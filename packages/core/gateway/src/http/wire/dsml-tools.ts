/**
 * DSML 工具调用兜底（响应侧）。
 *
 * 上游偶发把工具调用写成 `<｜｜DSML｜｜ calls>` 文本塞进 `delta.content`，
 * 而网关对 `WIRE === "openai"` 是字节级透传 —— 标记会直达客户端，表现为
 * 「会话里出现一坨标记、工具没执行」。本模块把完整块还原成 `tool_calls`。
 *
 * 边界：只转完整块；请求未声明 `tools` 时只剥离不合成；字节级增量，
 * 标记可被任意 chunk 切开。
 */

import { randomBytes } from "node:crypto";

import { asRecord } from "./openai-normalize.js";

/** 全角竖线：DSML 标记的分隔符（U+FF5C）。 */
const BAR = "｜";
const MARKER = `${BAR}${BAR}DSML${BAR}${BAR}`;

/** 开始 / 结束标记的两种常见写法（带不带空格）。 */
const OPEN_MARKERS = [`<${MARKER} calls>`, `<${MARKER}calls>`];
const CLOSE_MARKERS = [`</${MARKER} calls>`, `</${MARKER}calls>`];

/** 块内容迟迟不闭合时的上限：超过就当普通正文吐出，避免无界缓存。 */
const MAX_PENDING_CHARS = 256 * 1024;

/** 合成出的 OpenAI `tool_calls` 元素（流式 delta 形态）。 */
export interface DsmlToolCall {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface DsmlPushResult {
  text: string;
  toolCalls: DsmlToolCall[];
}

interface MarkerHit {
  index: number;
  length: number;
}

function findMarker(text: string, markers: string[]): MarkerHit | null {
  let best: MarkerHit | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    if (!best || index < best.index) best = { index, length: marker.length };
  }
  return best;
}

/**
 * 返回 `text` 尾部「可能是开始标记前缀」的最长长度。
 *
 * 标记可能被切在两个 chunk 之间（如 `<｜｜DS` + `ML｜｜ calls>`），
 * 这一段必须扣住等下一块，否则半截标记会先当正文发出去。
 */
function pendingPrefixLen(text: string, markers: string[]): number {
  let keep = 0;
  for (const marker of markers) {
    const max = Math.min(text.length, marker.length - 1);
    for (let len = max; len > 0; len -= 1) {
      if (text.endsWith(marker.slice(0, len))) {
        if (len > keep) keep = len;
        break;
      }
    }
  }
  return keep;
}

function parseParameters(body: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const paramRe = new RegExp(
    `<${MARKER}\\s*parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${MARKER}\\s*parameter>`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(body)) !== null) {
    const name = match[1];
    if (!name) continue;
    const raw = match[3] ?? "";
    // `string="false"` 表示该参数是 JSON 值（数字/布尔/对象），其余按字符串处理
    if (match[2] === "false") {
      try {
        params[name] = JSON.parse(raw);
      } catch {
        // 上游把 JSON 写坏时保留原文：一个参数失败不该毁掉整条调用
        params[name] = raw;
      }
    } else {
      params[name] = raw;
    }
  }
  return params;
}

interface ParsedInvoke {
  name: string;
  arguments: string;
}

function parseInvocations(block: string): ParsedInvoke[] {
  const invokes: ParsedInvoke[] = [];
  const invokeRe = new RegExp(
    `<${MARKER}\\s*invoke\\s+name="([^"]*)"\\s*>([\\s\\S]*?)</${MARKER}\\s*invoke>`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = invokeRe.exec(block)) !== null) {
    const name = match[1];
    if (!name) continue;
    invokes.push({
      name,
      arguments: JSON.stringify(parseParameters(match[2] ?? "")),
    });
  }
  return invokes;
}

/**
 * 把正文文本流里的 DSML 块抽出来，其余文本原样返回。
 *
 * 状态机只有「块外 / 块内」两态：块外做前缀扣留，块内等闭合标记。
 */
/** 单调递增的 tool_calls index 分配器（content / reasoning 两个提取器共享）。 */
export function createToolCallIndexAllocator(): () => number {
  let next = 0;
  return () => {
    const index = next;
    next += 1;
    return index;
  };
}

export class DsmlTextExtractor {
  private pending = "";
  private inBlock = false;
  private sawToolCall = false;

  constructor(
    private readonly hasTools: boolean,
    private readonly allocateIndex: () => number = createToolCallIndexAllocator(),
  ) {}

  /** 已经合成过至少一个调用（上层据此把 finish_reason 改成 tool_calls）。 */
  get sawAnyToolCall(): boolean {
    return this.sawToolCall;
  }

  push(text: string): DsmlPushResult {
    this.pending += text;
    let out = "";
    const toolCalls: DsmlToolCall[] = [];

    for (;;) {
      if (this.inBlock) {
        const close = findMarker(this.pending, CLOSE_MARKERS);
        if (!close) {
          if (this.pending.length > MAX_PENDING_CHARS) {
            out += this.pending;
            this.pending = "";
            this.inBlock = false;
          }
          break;
        }
        const block = this.pending.slice(0, close.index);
        this.pending = this.pending.slice(close.index + close.length);
        this.inBlock = false;
        if (this.hasTools) {
          for (const invoke of parseInvocations(block)) toolCalls.push(this.makeCall(invoke));
        }
        continue;
      }

      const open = findMarker(this.pending, OPEN_MARKERS);
      if (!open) {
        const keep = pendingPrefixLen(this.pending, OPEN_MARKERS);
        const emit = this.pending.length - keep;
        if (emit > 0) {
          out += this.pending.slice(0, emit);
          this.pending = this.pending.slice(emit);
        }
        break;
      }
      if (open.index > 0) {
        out += this.pending.slice(0, open.index);
        this.pending = this.pending.slice(open.index);
      }
      this.pending = this.pending.slice(open.length);
      this.inBlock = true;
    }

    return { text: out, toolCalls };
  }

  /**
   * 流结束：块外的残留前缀（可能只是正常正文）原样吐回；
   * 块内若已凑齐完整 invoke 则仍按调用收下，否则原样吐出。
   */
  finish(): DsmlPushResult {
    const toolCalls: DsmlToolCall[] = [];
    let text = "";

    if (this.inBlock) {
      const invokes = parseInvocations(this.pending);
      if (invokes.length > 0) {
        if (this.hasTools) {
          for (const invoke of invokes) toolCalls.push(this.makeCall(invoke));
        }
      } else {
        text = this.pending;
      }
    } else {
      text = this.pending;
    }

    this.pending = "";
    this.inBlock = false;
    return { text, toolCalls };
  }

  private makeCall(invoke: ParsedInvoke): DsmlToolCall {
    const index = this.allocateIndex();
    this.sawToolCall = true;
    return {
      index,
      id: `call_${randomBytes(12).toString("hex")}`,
      type: "function",
      function: { name: invoke.name, arguments: invoke.arguments },
    };
  }
}

/**
 * SSE 事件级的 DSML 过滤器：只改写 `data:` 行里的 delta，其余字节不动。
 *
 * 上游会把工具调用写进 `reasoning_content`（DeepSeek 思考链）而不是 `content`——
 * 实测（2026-11-02）1.2MB 长会话：completion 4237 token 里 3927 是 reasoning、
 * 正文为空，DSML 全在思考链里。两个字段各自用独立状态机，共享 index 分配器。
 */
export class DsmlSseFilter {
  private readonly contentExtractor: DsmlTextExtractor;
  private readonly reasoningExtractor: DsmlTextExtractor;
  private readonly allocateIndex = createToolCallIndexAllocator();
  private template: { id?: string; model?: string; created?: number } = {};

  constructor(hasTools: boolean) {
    this.contentExtractor = new DsmlTextExtractor(hasTools, this.allocateIndex);
    this.reasoningExtractor = new DsmlTextExtractor(hasTools, this.allocateIndex);
  }

  /** 任一字段合成过调用（上层据此改写 finish_reason）。 */
  private get sawToolCall(): boolean {
    return this.contentExtractor.sawAnyToolCall || this.reasoningExtractor.sawAnyToolCall;
  }

  /** 输入一个 SSE 事件块（不含结尾空行），返回要下发的帧。 */
  transformEvent(event: string): string[] {
    const lines = event.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trimStart();
      if (!payload || payload === "[DONE]") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const rec = asRecord(parsed);
      if (!rec) continue;
      if (typeof rec["id"] === "string") this.template.id = rec["id"];
      if (typeof rec["model"] === "string") this.template.model = rec["model"];
      if (typeof rec["created"] === "number") this.template.created = rec["created"];

      const choices = rec["choices"];
      if (!Array.isArray(choices)) continue;

      let touched = false;
      for (const rawChoice of choices) {
        const choice = asRecord(rawChoice);
        if (!choice) continue;

        const delta = asRecord(choice["delta"]);
        if (delta) {
          const content = delta["content"];
          if (typeof content === "string" && content.length > 0) {
            this.applyExtracted(delta, "content", this.contentExtractor.push(content));
            touched = true;
          }
          // `reasoning_content` 与 `reasoning` 是同一段思考链的两种字段名
          for (const field of ["reasoning_content", "reasoning"] as const) {
            const reasoning = delta[field];
            if (typeof reasoning !== "string" || reasoning.length === 0) continue;
            this.applyExtracted(delta, field, this.reasoningExtractor.push(reasoning));
            touched = true;
          }
          // 空 `tool_calls: []` 必须剔除：客户端看到 tool_calls != null 就结束当前
          // 思考块，空数组会把思考逐 token 切碎（与 sse-stream.ts::normalizeDataLine 同规则）。
          // 走 DSML 过滤器的请求不再经过那条路径，这条规则要在这里补一次。
          if (Array.isArray(delta["tool_calls"]) && delta["tool_calls"].length === 0) {
            delete delta["tool_calls"];
            touched = true;
          }
        }

        const finishReason = choice["finish_reason"];
        if (typeof finishReason === "string" && finishReason && this.sawToolCall) {
          choice["finish_reason"] = "tool_calls";
          touched = true;
        }
      }

      if (touched) {
        lines[i] = `data: ${JSON.stringify(rec)}`;
        changed = true;
      }
    }

    return changed ? [lines.join("\n")] : [event];
  }

  /** 把提取结果写回 delta：正文/思考链只留非标记部分，调用并入 `tool_calls`。 */
  private applyExtracted(
    delta: Record<string, unknown>,
    field: "content" | "reasoning_content" | "reasoning",
    result: DsmlPushResult,
  ): void {
    if (result.text.length > 0) delta[field] = result.text;
    else delete delta[field];
    if (result.toolCalls.length > 0) {
      const existing = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
      delta["tool_calls"] = [...existing, ...result.toolCalls];
    }
  }

  /** 流结束：吐出被扣留的正文、思考链或未闭合块里的调用。 */
  finish(): string[] {
    const frames: string[] = [];
    const base = {
      id: this.template.id ?? `chatcmpl-${randomBytes(8).toString("hex")}`,
      object: "chat.completion.chunk",
      created: this.template.created ?? Math.floor(Date.now() / 1000),
      model: this.template.model ?? "",
    };
    const pushText = (field: "content" | "reasoning_content", text: string): void => {
      frames.push(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { [field]: text }, finish_reason: null }],
        })}`,
      );
    };
    const pushCalls = (calls: DsmlToolCall[]): void => {
      frames.push(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: "tool_calls" }],
        })}`,
      );
    };

    const content = this.contentExtractor.finish();
    if (content.text.length > 0) pushText("content", content.text);
    if (content.toolCalls.length > 0) pushCalls(content.toolCalls);

    const reasoning = this.reasoningExtractor.finish();
    if (reasoning.text.length > 0) pushText("reasoning_content", reasoning.text);
    if (reasoning.toolCalls.length > 0) pushCalls(reasoning.toolCalls);

    return frames;
  }
}

/**
 * 字节级入口：接收任意切片的上游字节，输出完整 SSE 帧。
 *
 * 上游 chunk 边界与 SSE 事件边界无关，标记也可能跨 chunk，所以解码、
 * 事件切分、DSML 状态机必须共用同一份缓冲。
 */
export class DsmlByteFilter {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly sse: DsmlSseFilter;
  private buffer = "";

  constructor(hasTools: boolean) {
    this.sse = new DsmlSseFilter(hasTools);
  }

  push(chunk: Uint8Array): Buffer[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  finish(): Buffer[] {
    this.buffer += this.decoder.decode();
    const out = this.drain();
    const tail = this.buffer;
    this.buffer = "";
    // `[DONE]` 必须留在最后：客户端看到它就停止读取，状态机残留帧得排在前面
    const isDone = tail.trim().startsWith("data: [DONE]");
    if (tail.trim() !== "" && !isDone) {
      for (const frame of this.sse.transformEvent(tail)) out.push(this.encode(frame));
    }
    for (const frame of this.sse.finish()) out.push(this.encode(frame));
    if (isDone) {
      for (const frame of this.sse.transformEvent(tail)) out.push(this.encode(frame));
    }
    return out;
  }

  private drain(): Buffer[] {
    const out: Buffer[] = [];
    for (;;) {
      const lf = this.buffer.indexOf("\n\n");
      const crlf = this.buffer.indexOf("\r\n\r\n");
      if (lf < 0 && crlf < 0) break;
      let event: string;
      if (crlf < 0 || (lf >= 0 && lf < crlf)) {
        event = this.buffer.slice(0, lf);
        this.buffer = this.buffer.slice(lf + 2);
      } else {
        event = this.buffer.slice(0, crlf);
        this.buffer = this.buffer.slice(crlf + 4);
      }
      for (const frame of this.sse.transformEvent(event)) out.push(this.encode(frame));
    }
    return out;
  }

  private encode(frame: string): Buffer {
    return Buffer.from(`${frame.replace(/\r+$/, "")}\n\n`, "utf8");
  }
}

/** 请求是否声明了工具（决定能不能把 DSML 合成成 tool_calls）。 */
export function hasToolDeclarations(request: Record<string, unknown> | undefined): boolean {
  const tools = request?.["tools"];
  return Array.isArray(tools) && tools.length > 0;
}

/** 非流式路径：整段上游 SSE 过一次过滤器。 */
export function filterDsmlBytes(buf: Buffer, hasTools: boolean): Buffer {
  const filter = new DsmlByteFilter(hasTools);
  return Buffer.concat([...filter.push(buf), ...filter.finish()]);
}
