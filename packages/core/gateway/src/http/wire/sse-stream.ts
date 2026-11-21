/**
 * 上游 SSE 流处理：规范化转发（流式）与聚合（非流式）。
 *
 * 集中承载所有「上游兼容性 hack」，与网关的路由层解耦：改上游兼容性只需动这里。
 * 两处规范化：
 *  1. **丢弃注释行**（以 `:` 开头）—— 部分客户端的 SSE 解析器遇到注释行会
 *     解析失败并重置流状态。
 *  2. **剔除 delta 里语义为空的字段**（`tool_calls: []`）—— 客户端解析器判定
 *     `delta.tool_calls != null` 就结束当前思考块，空数组会把每个 reasoning
 *     token 切成独立「思考」块；删掉（无信息量）即修复。
 */

import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ServerResponse } from "node:http";

import { getChannel } from "../../runtime/channel.js";
import { noteUsage } from "../../runtime/log-store.js";
import { debugDir, noteOnce } from "../../runtime/paths.js";
import type { DsmlByteFilter } from "./dsml-tools.js";

const READ_CHUNK = 8192;

/** 读取上游流时出错（如连接中断）。 */
export class StreamError extends Error {
  override name = "StreamError";
}

/**
 * 抓包落盘目录。
 *
 * 变量名取自渠道的 `debugDumpEnv`。值为 `1`/`true` 时落到渠道层内的
 * `debug/`；其余值必须是**绝对路径**。未设置则返回 null —— 抓包是 opt-in，
 * 默认不落盘（见 STORAGE-CONVENTION.md §3 第 5 条）。
 */
function debugDumpDir(cid?: string): string | null {
  const { config } = getChannel(cid);
  const name = config.debugDumpEnv;
  const value = process.env[name];
  if (!value) return null;
  if (value === "1" || value.toLowerCase() === "true") return debugDir(cid);
  if (!isAbsolute(value)) {
    noteOnce(`debug-rel:${value}`, `${name} must be an absolute path; ignored: ${value}`);
    return null;
  }
  return value;
}

/** 把抓包数据原样落盘（目录由 debugDumpDir() 决定，未启用则不落盘）。 */
export function debugDump(tag: string, ext: string, data: Buffer, cid?: string): void {
  const dir = debugDumpDir(cid);
  if (!dir) return;
  const name = `${tag}-${Date.now()}-${process.hrtime.bigint() % 1_000_000n}.${ext}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), data);
  } catch {
    /* 抓包失败不影响主流程 */
  }
}

function captureEnabled(cid?: string): boolean {
  return debugDumpDir(cid) !== null;
}

export interface AggregatedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AggregatedChoice {
  index: number;
  message: {
    role: string;
    /**
     * 正文。纯工具调用时**省略该键**（而不是给 `null`）——
     * 严格客户端（Go 的 `Content string`）解 `null` 会直接失败，
     * 缺失字段对它们等价于空串。
     */
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: AggregatedToolCall[];
  };
  finish_reason: string;
}

export interface AggregatedCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: AggregatedChoice[];
  /**
   * 上游给的 usage；**上游没给就是 undefined**（不伪造全 0 —— 见下方聚合处的说明）。
   */
  usage: Record<string, unknown> | undefined;
}

/** 把上游的 SSE 流聚合为标准 OpenAI chat.completion JSON（非流式响应用）。 */
export function aggregateChatSse(buf: Buffer): AggregatedCompletion {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  // 流式 tool_calls 按 index 累积：同一调用的参数可能分多帧到达
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish = "";
  let id = "";
  let model = "";
  let created = 0;
  let usage: Record<string, unknown> | undefined;

  for (const block of buf.toString("utf8").split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof chunk["id"] === "string") id = chunk["id"];
      if (typeof chunk["model"] === "string") model = chunk["model"];
      if (typeof chunk["created"] === "number") created = chunk["created"];
      if (chunk["usage"] && typeof chunk["usage"] === "object") {
        usage = chunk["usage"] as Record<string, unknown>;
      }
      const choices = chunk["choices"];
      if (!Array.isArray(choices)) continue;
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const c = choice as Record<string, unknown>;
        const delta = c["delta"];
        if (delta && typeof delta === "object") {
          const d = delta as Record<string, unknown>;
          if (typeof d["content"] === "string" && d["content"]) contentParts.push(d["content"]);
          const r = d["reasoning_content"] ?? d["reasoning"];
          if (typeof r === "string" && r) reasoningParts.push(r);
          const rawCalls = d["tool_calls"];
          if (Array.isArray(rawCalls)) {
            for (const raw of rawCalls) {
              if (!raw || typeof raw !== "object") continue;
              const tc = raw as Record<string, unknown>;
              const index = typeof tc["index"] === "number" && Number.isFinite(tc["index"])
                ? (tc["index"] as number)
                : toolCalls.size;
              let acc = toolCalls.get(index);
              if (!acc) {
                acc = { id: "", name: "", arguments: "" };
                toolCalls.set(index, acc);
              }
              if (typeof tc["id"] === "string" && tc["id"]) acc.id = tc["id"];
              const fn = tc["function"] && typeof tc["function"] === "object"
                ? (tc["function"] as Record<string, unknown>)
                : {};
              if (typeof fn["name"] === "string" && fn["name"]) acc.name = fn["name"];
              if (typeof fn["arguments"] === "string") acc.arguments += fn["arguments"];
            }
          }
        }
        if (typeof c["finish_reason"] === "string" && c["finish_reason"]) {
          finish = c["finish_reason"];
        }
      }
    }
  }

  const calls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.name);

  const message: AggregatedChoice["message"] = { role: "assistant" };
  // 纯工具调用消息：OpenAI 规范给 `content: null`，但严格客户端（Go 的 `Content string`）
  // 解 null 会整帧失败 → 这里**根本不设该键**（不是设成 undefined —— 键存在即会被序列化器
  // 当成「有这个字段」，缺失对多数解析器等价于空串）。
  if (contentParts.length > 0) message.content = contentParts.join("");
  else if (calls.length === 0) message.content = "";
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (calls.length > 0) {
    message.tool_calls = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  }

  return {
    id: id || "chatcmpl-gateway",
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finish || (calls.length > 0 ? "tool_calls" : "stop"),
    }],
    // 上游没给 usage 就**不编造**：此前这里填 `{0,0,0}`，让「上游不提供用量」与
    // 「真的用了 0 token」在日志与 UI 上长得一模一样（有的渠道结束帧只带会话
    // 标识、不带任何计数，实测确认上游不提供 → 请求日志整列显示 `0 / 0`）。
    // 这里显式给 `undefined`（不是省略键）—— `tokensOf` 据此返回 null，日志记 noUsage、
    // 表格显示 `-`。对外 JSON 序列化时 undefined 键会被丢弃，客户端拿到的仍是原形态。
    usage,
  };
}

/**
 * 取 SSE 字节里**第一个错误帧**（`data: {"error":{…}}`）；没有则返回 null。
 *
 * 上游 HTTP 200 但流内投递业务错误（如排队/限流）时，聚合器会把它当无内容可聚，
 * 结果退化成空 completion。调用方用本函数把这种「有错误帧但零内容」明确报成错误。
 */
export function firstSseError(buf: Buffer): { code?: string; message?: string } | null {
  for (const block of buf.toString("utf8").split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue;
      const err = (chunk as Record<string, unknown>)["error"];
      if (!err || typeof err !== "object" || Array.isArray(err)) continue;
      const e = err as Record<string, unknown>;
      return {
        ...(typeof e["code"] === "string" ? { code: e["code"] } : {}),
        ...(typeof e["message"] === "string" ? { message: e["message"] } : {}),
      };
    }
  }
  return null;
}

/**
 * 取**单帧**里的业务错误对象（`data: {"error":{…}}`）；不是错误帧返回 null。
 *
 * 与 `firstSseError` 的区别：那个翻的是已聚合的整段字节，这个只看一帧 ——
 * 流式路径需要逐帧记账（见 `http/chat/stream.ts` 的 `noteStreamError`）。
 */
export function errorFrameOf(frame: Buffer | string): Record<string, unknown> | null {
  const text = Buffer.isBuffer(frame) ? frame.toString("utf8") : frame;
  // 快判：绝大多数帧是内容帧，不值一次 JSON 解析（与 `noteFrameUsage` 同口径 ——
  // 本函数在流式热路径上逐帧调用）
  if (!text.includes('"error"')) return null;
  // 逐 `data:` 行扫：翻译器正常一帧一条，但 TCP 合并 / 渠道实现可能一帧里有多行
  for (const line of text.split("\n")) {
    const data = line.trim();
    if (!data.startsWith("data:")) continue;
    const payload = data.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      /* 非 JSON 的 data 行（心跳 / 注释 / 半截帧）直接跳过，不视为错误帧 */
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const err = (parsed as Record<string, unknown>)["error"];
    if (err && typeof err === "object" && !Array.isArray(err)) {
      return err as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * 剔除 data 块里语义为空的字段（目前只有空数组 `tool_calls`）。
 *
 * 上游每个 delta 都带 `"tool_calls": []`，而客户端判定
 * `delta.tool_calls != null` 就结束当前思考块 —— 空数组导致每个 reasoning token
 * 都被切成独立的「思考」块。删除它（无任何信息量）即修复。
 * 解析失败或无需改动的行原样返回。
 */
function normalizeDataLine(line: string): string {
  const payload = line.startsWith("data:") ? line.slice(5).trimStart() : line;
  if (!payload || payload.startsWith("[DONE]")) return line;
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return line;
  }
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return line;

  let changed = false;
  const rec = chunk as Record<string, unknown>;
  const choices = rec["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const delta = (choice as Record<string, unknown>)["delta"];
      if (!delta || typeof delta !== "object") continue;
      const d = delta as Record<string, unknown>;
      if (Array.isArray(d["tool_calls"]) && d["tool_calls"].length === 0) {
        delete d["tool_calls"];
        changed = true;
      }
    }
  }
  if (!changed) return line;
  return `data: ${JSON.stringify(chunk)}`;
}

/**
 * 清洗一个 SSE 事件块：丢弃注释行、规范化 data 行；清洗后为空则返回 null（不转发）。
 */
function processEvent(event: string): string | null {
  const kept: string[] = [];
  for (const line of event.split("\n")) {
    if (line.startsWith(":")) continue;
    kept.push(normalizeDataLine(line));
  }
  if (!kept.some((x) => x.trim())) return null;
  return kept.join("\n");
}

/**
 * SSE 感知透传上游流到客户端（响应头需已写出）。
 *
 * 按事件块（空行分隔）切分上游字节流，做两处规范化后再转发；
 * 事件数据其余部分原样保留，不在重组时引入额外延迟。
 *
 * 兼容 `\n\n` 与 `\r\n\r\n` 两种事件分隔符，取最先出现者；
 * 统一规范化为标准 SSE 帧（`\n\n` 结尾），避免 `\r` 残留。
 */
export interface RelayOptions {
  /** 响应侧 DSML 过滤器：传入时字节先过它再写出（仅 SSE 生效）。 */
  dsml?: DsmlByteFilter;
  /** 探测层已消费的前缀帧：必须按原序先写客户端。 */
  prefix?: Buffer[];
  /**
   * 入站协议回程编码器（结构化最小接口，见 protocol/types.ts 的 ProtocolSink）。
   *
   * 传入时规范化后的帧不再直写 `out`，改交编码器转译成协议事件字节；
   * 结尾也不再 `out.end()`（编码器的 finish() + 调用方收尾负责）。
   */
  sink?: {
    writeOpenAiFrame(frame: Buffer | string): void;
    /** 可选：零帧等异常收尾时写结构化错误帧（协议编码器实现它）。 */
    writeError?(code: string, message: string): void;
  };
  /**
   * 每写一帧回调一次（**只观测，不改帧**）。
   *
   * 用途是流内业务错误的逐帧记账：openai 线型的帧在本函数内部流转，
   * 调用方看不到，只能由这里递出去（见 `http/chat/stream.ts`）。
   */
  onFrame?: (frame: Buffer | string) => void;
  /**
   * **惰性写响应头**：第一次真正要往客户端写东西之前调用（幂等，由调用方保证）。
   *
   * 为什么要惰性：一进转发层就 writeHead，等于向客户端承诺「这个请求我接了」，
   * 之后发现上游 200 却零产出（空流）就再也换不了候选 —— 换渠道会变成两个响应。
   * 把写头挪到首次写出，零产出且未写头的情况就能交回上层改试下一条渠道。
   */
  ensureHead?: () => void;
}

/**
 * `relay` 的结果。
 *
 * `produced` = 实际交付给客户端的帧数（0 = 上游 200 但零帧）；
 * `disconnected` = 客户端已断开（那种情况没有收件人，上层不该再换候选去喂它）。
 */
export interface RelayResult {
  produced: number;
  disconnected: boolean;
}

export async function relay(
  out: ServerResponse,
  upstreamBody: ReadableStream<Uint8Array>,
  contentType: string,
  cid?: string,
  opts: RelayOptions = {},
): Promise<RelayResult> {
  const isSse = contentType.toLowerCase().includes("text/event-stream");
  // 只要上层给了过滤器就启用：openai 线型的响应语义是 SSE，content-type 可能不准
  const dsml = opts.dsml;
  const sink = opts.sink;
  const capture: Buffer[] | null = captureEnabled(cid) ? [] : null;
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder("utf-8");
  /** 异常向上传播时置位：`finally` 据此**不**收尾，留给调用方写错误帧。 */
  let propagateFailure = false;
  /** 客户端已断开：没有收件人，照常收尾，也不给上层留「换候选」的余地。 */
  let disconnected = false;
  /**
   * 交付给客户端的帧数。
   *
   * 0 = 上游回了 200 却一个帧都没有 —— 静默 `end()` 会让客户端收到「空的成功响应」
   * （ZCode 报成 "Provider returned a business error"），访问日志与账本还都记 success
   * （2026-11-16 实测 loomy 一次 10.3s 空流）。非流式聚合路径早有同口径判定，
   * 流式路径此前漏了。`prefix` 帧也算产出：它们确属本次响应。
   */
  let produced = 0;

  /**
   * 客户端是否已断开（本函数内累计判定，读循环每轮检查）。
   *
   * 向已销毁的 `res` 写数据不抛错、只返回 false（Node 直接丢弃），所以中继循环
   * 不会自己停下来 —— 上游会照常生成完整段（照常计费），非流式路径还会等到聚合完成。
   * 客户端在 Claude Code / Codex 里点停止是最常见的触发。
   */
  let clientGone = out.destroyed || out.writableEnded;
  const onClose = (): void => {
    clientGone = true;
  };
  // 测试用替身对象可能没有 EventEmitter 接口：有监听能力才挂（不影响生产路径）
  const canListen = typeof out.once === "function" && typeof out.off === "function";
  if (!clientGone && canListen) out.once("close", onClose);

  /**
   * 是否该等写缓冲排空（背压）。
   *
   * `res.write()` 的返回值此前被全部丢弃：客户端读得慢（弱网 / 被限速 / 暂停读取）时
   * 数据在 Node 的响应缓冲里无界堆积，内存随生成长度线性上涨，最终可能 OOM 把整个
   * 进程（含其它在途请求）带走。上游持续吐大段正文或工具参数时最容易撞上。
   *
   * 判据用 `write()` 自己的返回值（`false` = 缓冲已超 highWaterMark），而不是
   * `writableLength`：后者在有编码器（sink）时由编码器写、本函数看不到，且测试替身
   * 没有这个属性。返回 false 后等 `drain` —— 但**必须**同时受断连/结束保护，否则
   * 客户端中途消失时 `drain` 永不到来，读循环会挂死。
   */
  let needDrain = false;
  const drainIfNeeded = async (): Promise<void> => {
    if (!needDrain) return;
    needDrain = false;
    if (clientGone || out.writableEnded || !canListen) return;
    await once(out, "drain").catch(() => {
      /* 等 drain 期间断开：下一轮的 clientGone 判定会接管 */
    });
  };

  /** 有编码器时不直写 out：帧交编码器转译（收尾与 end 也归调用方）。 */
  const writeOut = (frame: Buffer | string): void => {
    // 首次写出才落响应头：在此之前都还算「这条渠道没接住这个请求」，上层可换候选
    opts.ensureHead?.();
    produced += 1;
    if (sink) sink.writeOpenAiFrame(frame);
    // write 返回 false = 缓冲已满，下一轮读之前先等 drain（见 drainIfNeeded）
    else if (out.write(frame) === false) needDrain = true;
  };

  try {
    // 探测层消费掉的前缀帧先写：它们属于同一次响应，顺序不能倒
    for (const frame of opts.prefix ?? []) {
      for (const outFrame of dsml ? dsml.push(frame) : [frame]) {
        noteFrameUsage(out, outFrame);
        opts.onFrame?.(outFrame);
        writeOut(outFrame);
      }
    }

    if (dsml) {
      // 上游没按 SSE 回（错误 JSON 直落正文）时 DSML 过滤器一个事件都切不出来：
      // 非 SSE 兜底必须先判，否则错误体会被当空流吞掉，协议客户端收到「空成功消息」。
      if (!isSse) {
        const chunks: Buffer[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (capture) capture.push(Buffer.from(value));
          chunks.push(Buffer.from(value));
        }
        opts.ensureHead?.(); // 非 SSE 正文也是「往客户端写东西」：先落头
      emitNonSseBody(Buffer.concat(chunks).toString("utf8"), sink, out);
        produced += 1; // 非 SSE 正文同样是一次交付（不算空流）
        return { produced, disconnected };
      }
      for (;;) {
        // 客户端已断开就别再读上游了（照常计费，且没有收件人）；有积压时等排空
        if (clientGone) break;
        await drainIfNeeded();
        const { done, value } = await reader.read();
        if (done) break;
        if (capture) capture.push(Buffer.from(value));
        for (const outFrame of dsml.push(value)) {
          noteFrameUsage(out, outFrame);
          opts.onFrame?.(outFrame);
          writeOut(outFrame);
        }
      }
      for (const outFrame of dsml.finish()) {
        noteFrameUsage(out, outFrame);
        opts.onFrame?.(outFrame);
        writeOut(outFrame);
      }
      return { produced, disconnected };
    }

    if (!isSse) {
      // 上游没按 SSE 回（错误 JSON 直落正文）：**整段读完一次性交付**。
      // 边读边发会把已读前缀反复拼进正文（第 N 段带上前 N-1 段）；开了抓包时
      // `capture` 已收下当前段，再拼一次就是两份正文。协议客户端拿到的消息会
      // 被重复内容挤占 500 字符窗口，真正的错误细节反而被截掉。
      const chunks: Buffer[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (capture) capture.push(Buffer.from(value));
        chunks.push(Buffer.from(value));
      }
      opts.ensureHead?.(); // 非 SSE 正文也是「往客户端写东西」：先落头
      emitNonSseBody(Buffer.concat(chunks).toString("utf8"), sink, out);
      produced += 1; // 非 SSE 正文同样是一次交付（不算空流）
      return { produced, disconnected };
    }

    let buffer = "";
    for (;;) {
      // 同上：断连即停读上游，有积压先等排空（背压）
      if (clientGone) break;
      await drainIfNeeded();
      const { done, value } = await reader.read();
      if (done) break;
      if (capture) capture.push(Buffer.from(value));
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const lf = buffer.indexOf("\n\n");
        const crlf = buffer.indexOf("\r\n\r\n");
        if (lf < 0 && crlf < 0) break;
        let event: string;
        if (crlf < 0 || (lf >= 0 && lf < crlf)) {
          event = buffer.slice(0, lf);
          buffer = buffer.slice(lf + 2);
        } else {
          event = buffer.slice(0, crlf);
          buffer = buffer.slice(crlf + 4);
        }
        const processed = processEvent(event);
        if (processed !== null) {
          const frame = processed.replace(/\r+$/, "");
          noteFrameUsage(out, frame);
          opts.onFrame?.(frame);
          writeOut(`${frame}\n\n`);
        }
      }
    }
    if (isSse) {
      buffer += decoder.decode();
      if (buffer) {
        const processed = processEvent(buffer);
        if (processed !== null) {
          noteFrameUsage(out, processed);
          opts.onFrame?.(processed);
          writeOut(processed);
        }
      }
    }
  } catch (err) {
    // 客户端提前断开（如主动取消请求）属正常情况，降级为调试日志
    if (isBenignDisconnect(err)) {
      disconnected = true;
    } else {
      // 异常要往上抛给 `relayStream` 的 catch 去写错误帧 —— 所以下面 finally 不能先 end：
      // `writeError()` 首行是 `if (res.writableEnded) return`，一旦这里 end 了，
      // 错误帧与 `[DONE]` 会被静默吞掉，客户端只看到 SSE 截断（与 stream.ts 的
      // 「必须避免截断」约定直接冲突）。
      propagateFailure = true;
      throw err;
    }
  } finally {
    if (!clientGone && canListen) out.off("close", onClose);
    await reader.cancel().catch(() => {});
    if (capture) debugDump("resp", "sse", Buffer.concat(capture), cid);
    // 零帧**不在这里**写错误帧、也不 end：头还没写时上层要改试下一条候选
    // （写了就成了两个响应，end 掉了更没法重试）—— 判定与收尾都在 `forward.ts`。
    if (!sink && !propagateFailure && (produced > 0 || out.headersSent || disconnected)) out.end();
  }
  // 客户端中途断开同样要报给上层：它据此不再换候选（没有收件人）
  return { produced, disconnected: disconnected || clientGone };
}

/**
 * 上游返回非 SSE 正文（多为错误 JSON 直落 body）时的统一兜底。
 *
 * 协议客户端（anthropic / responses）只认事件帧 —— 直接把 JSON 字节写过去会让它解析失败；
 * 有编码器就转成一个错误事件。裸 OpenAI 客户端可以吃原字节，照写。
 */
function emitNonSseBody(
  text: string,
  sink: { writeOpenAiFrame: (frame: string) => void } | undefined,
  out: ServerResponse,
): void {
  if (sink) {
    const body = text.trim();
    sink.writeOpenAiFrame(
      `data: ${JSON.stringify({ error: { code: "upstream_error", message: body.slice(0, 500) || "upstream returned a non-SSE body" } })}\n\n`,
    );
    return;
  }
  out.write(Buffer.from(text, "utf8"));
}

function isBenignDisconnect(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    (err as Error | null)?.name === "AbortError"
  );
}

/**
 * 从一个 SSE 帧里提取 usage 并记到请求日志。
 *
 * 两条转发路径共用：翻译器路径（`chat/stream.ts`）与 `openai` 线型的直通路径
 * （本文件的 `relay`）。直通路径**不采集 usage 的话**，workbuddy /
 * loomy / raccoon 等渠道的流式请求访问日志会没有 usage 字段
 * （2026-10-24 实测：这几个渠道当日流式请求 usage 采样全部为 0）。
 *
 * 快判：绝大多数帧不含 `"usage"`，只做一次子串扫描就返回，不给直通路径
 * 增加 JSON 解析开销。
 */
export function noteFrameUsage(out: ServerResponse, frame: Buffer | string): void {
  const text = typeof frame === "string" ? frame : frame.toString("utf8");
  if (!text.includes('"usage"')) return;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed["usage"]) noteUsage(out, parsed["usage"]);
    } catch {
      /* 非 JSON 帧不处理 */
    }
  }
}

/** 读完整个上游响应体（非流式路径），读取中断抛 StreamError。 */
export async function readAll(
  upstreamBody: ReadableStream<Uint8Array>,
  cid?: string,
  /**
   * 每读到一个上游 chunk 回调一次（首个 chunk = 上游开始吐字）。
   *
   * 给「生成窗口」打点用：非流式路径同样需要知道**上游什么时候开始吐**，
   * 而不只是「我们什么时候聚完」——后者等于总耗时，做不出 TPS（见 docs/LOGGING.md §3.1）。
   */
  onChunk?: () => void,
): Promise<Buffer> {
  const capture: Buffer[] | null = captureEnabled(cid) ? [] : null;
  const chunks: Buffer[] = [];
  const reader = upstreamBody.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      if (capture) capture.push(buf);
      onChunk?.();
    }
  } catch (err) {
    throw new StreamError(String(err));
  } finally {
    await reader.cancel().catch(() => {});
    if (capture) debugDump("resp", "sse", Buffer.concat(capture), cid);
  }
  return Buffer.concat(chunks);
}

export { READ_CHUNK };
