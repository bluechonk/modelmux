/**
 * Anthropic Messages 协议适配（Claude Code 原生协议）。
 *
 * 约束：请求翻译成 OpenAI chat payload 走既有池层；回程把 OpenAI SSE 帧转成
 * message_start / content_block_*(start/delta/stop) / message_delta / message_stop
 * 事件族（带 event: 名）；thinking 映射是 P1（当前丢弃 reasoning_content）。
 * 协议锚点：CCR 参考 .tmp/ref/claude-code-router（context-archive/protocol.ts）。
 *
 * 文档：docs/CLIENT-INTEGRATION.md
 */

import type { ServerResponse } from "node:http";

import type { AggregatedCompletion } from "../wire/sse-stream.js";
import { type InboundProtocol, type ProtocolName, type ProtocolSink } from "./types.js";

type Rec = Record<string, unknown>;

// ── 请求翻译 ────────────────────────────────────────────────────────────────

export interface TranslatedChat {
  payload: Rec;
  model: string;
  messages: unknown[];
}

/** 翻译失败原因（调用方转 400）。 */
export function translateAnthropicRequest(body: Rec): { ok: true; value: TranslatedChat } | { ok: false; error: string } {
  const model = body["model"];
  if (typeof model !== "string" || !model.trim()) return { ok: false, error: "model is required" };
  const maxTokens = body["max_tokens"];
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    // Anthropic 协议 max_tokens 必填（OpenAI 可省）—— 缺了上游也接不住
    return { ok: false, error: "max_tokens is required and must be a positive number" };
  }
  const rawMessages = body["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: "messages is required and must be a non-empty array" };
  }

  const chatMessages: Rec[] = [];

  // system：字符串或文本块数组（Claude Code 发块数组，常带 cache_control）
  const systemText = collectText(body["system"]);
  if (systemText) chatMessages.push({ role: "system", content: systemText });

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Rec;
    const role = message["role"] === "assistant" ? "assistant" : "user";
    const converted = convertMessage(role, message["content"]);
    if (!converted) continue;
    chatMessages.push(...converted);
  }
  if (chatMessages.length === 0 || !chatMessages.some((m) => m["role"] !== "system")) {
    return { ok: false, error: "messages produced no convertible content" };
  }

  const payload: Rec = {
    model,
    messages: chatMessages,
    max_tokens: maxTokens,
    stream: Boolean(body["stream"]),
  };
  if (typeof body["temperature"] === "number") payload["temperature"] = body["temperature"];
  if (typeof body["top_p"] === "number") payload["top_p"] = body["top_p"];
  if (Array.isArray(body["stop_sequences"]) && body["stop_sequences"].length > 0) {
    payload["stop"] = body["stop_sequences"];
  }

  // tools：input_schema 直接作 parameters（空 schema 给最小 object，上游都要这形状）
  if (Array.isArray(body["tools"])) {
    const tools: Rec[] = [];
    for (const raw of body["tools"]) {
      if (!raw || typeof raw !== "object") continue;
      const tool = raw as Rec;
      const name = tool["name"];
      if (typeof name !== "string" || !name) continue;
      tools.push({
        type: "function",
        function: {
          name,
          description: typeof tool["description"] === "string" ? tool["description"] : "",
          parameters:
            tool["input_schema"] && typeof tool["input_schema"] === "object"
              ? tool["input_schema"]
              : { type: "object", properties: {} },
        },
      });
    }
    if (tools.length > 0) payload["tools"] = tools;
  }

  // tool_choice：Anthropic 的 auto/any/tool → OpenAI 的 auto/required/function
  const choice = body["tool_choice"];
  if (choice && typeof choice === "object") {
    const c = choice as Rec;
    const type = c["type"];
    if (type === "auto") payload["tool_choice"] = "auto";
    else if (type === "any") payload["tool_choice"] = "required";
    else if (type === "tool" && typeof c["name"] === "string") {
      payload["tool_choice"] = { type: "function", function: { name: c["name"] } };
    }
  }

  return { ok: true, value: { payload, model, messages: chatMessages } };
}

/** 收集 string 或文本块数组里的全部正文（system / tool_result 共用）。 */
function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Rec;
    if (typeof block["text"] === "string") parts.push(block["text"]);
  }
  return parts.join("\n");
}

/**
 * 单条 Anthropic 消息 → 若干 chat 消息。
 *
 * tool_result（user 消息里的工具回执）在 OpenAI 线型里是独立的 `role:"tool"`
 * 消息，所以一条 Anthropic 消息可能拆出多条；同消息里的文本块拼成一条 user。
 */
function convertMessage(role: "user" | "assistant", content: unknown): Rec[] | null {
  if (typeof content === "string") {
    if (!content) return null;
    return [{ role, content }];
  }
  if (!Array.isArray(content)) return null;

  if (role === "assistant") {
    let text = "";
    const toolCalls: Rec[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Rec;
      if (block["type"] === "text" && typeof block["text"] === "string") text += block["text"];
      else if (block["type"] === "tool_use") {
        const input = block["input"] ?? {};
        toolCalls.push({
          type: "function",
          id: typeof block["id"] === "string" ? block["id"] : "",
          function: { name: String(block["name"] ?? ""), arguments: JSON.stringify(input) },
        });
      }
      // thinking / redacted_thinking：P1 前不回灌（上游也不认）
    }
    if (toolCalls.length === 0 && !text) return null;
    const message: Rec = { role: "assistant", content: text || null };
    if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
    return [message];
  }

  const parts: Rec[] = [];
  const toolMessages: Rec[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Rec;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "image") {
      const url = imageUrlOf(block["source"]);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    } else if (block["type"] === "tool_result") {
      // 工具回执：content 是字符串或块数组，取全部文本
      toolMessages.push({
        role: "tool",
        tool_call_id: typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "",
        content: collectText(block["content"]),
      });
    }
  }
  const out: Rec[] = [];
  // Anthropic 惯例：tool_result 在 user 消息开头 —— 先发 tool 再发剩余文本
  out.push(...toolMessages);
  if (parts.length > 0) out.push({ role: "user", content: parts });
  return out.length > 0 ? out : null;
}

/** Anthropic image source（base64 / url）→ chat 的 image_url。 */
function imageUrlOf(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const s = source as Rec;
  if (s["type"] === "url" && typeof s["url"] === "string") return s["url"];
  if (s["type"] === "base64" && typeof s["media_type"] === "string" && typeof s["data"] === "string") {
    return `data:${s["media_type"]};base64,${s["data"]}`;
  }
  return null;
}

// ── 回程编码 ────────────────────────────────────────────────────────────────

/** OpenAI finish_reason → Anthropic stop_reason。 */
function stopReasonOf(finish: unknown): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  return "end_turn";
}

/** 非流式：聚合 completion → message JSON。 */
function encodeCompletion(aggregated: AggregatedCompletion, requestModel: string): Rec {
  const choice = aggregated.choices[0];
  const message = choice?.message;
  const content: Rec[] = [];
  // thinking 块排在最前（anthropic 语义顺序：思考先于回答；流式路径同序）
  const reasoning = message?.reasoning_content;
  if (typeof reasoning === "string" && reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (message && typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  let toolSeq = 0;
  for (const call of message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      // 参数截坏时给空对象：工具调用仍可投递，比整条请求报错有用
    }
    content.push({
      type: "tool_use",
      id: call.id || `toolu_gateway_${++toolSeq}`,
      name: call.function.name,
      input,
    });
  }
  const usage = aggregated.usage ?? {};
  return {
    id: `msg_${aggregated.id}`,
    type: "message",
    role: "assistant",
    model: requestModel,
    content,
    stop_reason: stopReasonOf(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: toNum(usage["prompt_tokens"]),
      output_tokens: toNum(usage["completion_tokens"]),
    },
  };
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Anthropic 错误体（响应头未发时的 4xx/5xx JSON 形态）。 */
export function anthropicErrorBody(code: string, message: string): Rec {
  return { type: "error", error: { type: anthropicErrorType(code, message), message } };
}

/**
 * 上游错误文案是否表示**上下文窗口超限**（请求体太大，重试必然失败）。
 *
 * 只认通用措辞；厂商私有业务码由渠道钩子上报，共享层不硬编码。
 *
 * 住在协议层是因为它有两个消费者：`chat/errors.ts` 用它决定 HTTP 状态码（回 400
 * 而非 502），本文件的 `anthropicErrorType` 用它决定流式错误类型（回
 * `invalid_request_error` 而非 `api_error` —— 流的响应头早已发出，改不了状态码，
 * 只能靠信封类型告诉客户端「这是请求问题，别重试」）。反向放会让 protocol →
 * chat 形成循环依赖。
 */
export const CONTEXT_LENGTH_EXCEEDED_RE =
  /context[_ ](length|window)[_ ](has[_ ])?(been[_ ])?exceed|maximum[_ ]context[_ ](length|window)|prompt[_ ]is[_ ]too[_ ]long|input[_ ](is[_ ])?too[_ ](long|large)|reduce[_ ](the[_ ])?(length|size)[_ ]of[_ ](the[_ ])?(messages|prompt|input)|(maximum|max)[_ ](context|token)[_ ](length|limit)[_ ](exceed|reached)|上下文(长度|窗口)?(超出|超过|超限)|超出(模型)?上下文/i;

function anthropicErrorType(code: string, message = ""): string {
  if (/not_found/i.test(code)) return "not_found_error";
  if (/auth/i.test(code)) return "authentication_error";
  // 上下文超限归 invalid_request_error：让客户端明白是请求太大、该压缩历史，
  // 而不是「服务端临时故障」（后者会被无限重试）。
  if (CONTEXT_LENGTH_EXCEEDED_RE.test(message)) return "invalid_request_error";
  if (/quota|rate|limit/i.test(code)) return "rate_limit_error";
  if (/invalid|bad_request|unknown_model|method_not_allowed|missing/i.test(code)) return "invalid_request_error";
  return "api_error";
}

/** 流式事件写出（`event:` + `data:` 两行；Anthropic SSE 必须带事件名）。 */
function emit(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface PendingTool {
  id: string;
  name: string;
  args: string;
  blockIndex: number;
  opened: boolean;
}

/**
 * Anthropic 流式编码器：维护「message → 内容块」两段状态。
 *
 * 关键点：tool_use 块必须等拿到 name 才能 content_block_start（首条 delta 同时带
 * id+name，后续只有 arguments）；text 块在出现 tool_calls 时要先关掉 ——
 * OpenAI 一个 choice 里文本与工具调用是顺序追加的，Anthropic 用块索引表达同一顺序。
 */
class AnthropicSink implements ProtocolSink {
  readonly name: ProtocolName = "anthropic";
  private started = false;
  private closed = false;
  private blockIndex = 0;
  private textBlockIndex = -1;
  private thinkingBlockIndex = -1;
  private tools = new Map<number, PendingTool>();
  private finishReason: unknown = null;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    private readonly res: ServerResponse,
    private readonly requestModel: string,
    /**
     * 请求侧的 input token 估算（`estimateInputTokens` 的结果）。
     *
     * 为什么需要：`message_start` 在**首个 chunk 到达时**就发，那一刻上游的 usage 帧
     * 还没到，`inputTokens` 必然是 0；而 Anthropic 语义里 `message_delta.usage`
     * 只带 output —— 于是流式路径永远报 `input_tokens: 0`。Claude Code 用它估上下文
     * 占用与成本，恒 0 会让它误判「还有大把窗口」。上游末尾给了真值就用真值覆盖，
     * 没给就留估算值（宁可差 20%，也不能是 0）。
     */
    inputEstimate = 0,
  ) {
    this.inputTokens = inputEstimate;
  }

  writeOpenAiFrame(frame: Buffer | string): void {
    const text = typeof frame === "string" ? frame : frame.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk: Rec;
      try {
        chunk = JSON.parse(payload) as Rec;
      } catch {
        continue;
      }
      const err = chunk["error"];
      if (err && typeof err === "object") {
        const e = err as Rec;
        this.writeError(typeof e["code"] === "string" ? e["code"] : "upstream_error", String(e["message"] ?? "upstream error"));
        continue;
      }
      this.handleChunk(chunk);
    }
  }

  private handleChunk(chunk: Rec): void {
    if (!this.started) {
      this.started = true;
      this.messageStart();
    }
    const choices = chunk["choices"];
    if (!Array.isArray(choices)) {
      this.noteUsage(chunk["usage"]);
      return;
    }
    for (const raw of choices) {
      if (!raw || typeof raw !== "object") continue;
      const choice = raw as Rec;
      const delta = choice["delta"];
      if (delta && typeof delta === "object") this.handleDelta(delta as Rec);
      if (typeof choice["finish_reason"] === "string" && choice["finish_reason"]) {
        this.finishReason = choice["finish_reason"];
      }
    }
    this.noteUsage(chunk["usage"]);
  }

  private handleDelta(delta: Rec): void {
    // 推理流（DeepSeek 风格 reasoning_content）→ thinking 块：上游推理先于正文到达，
    // 恰好满足 anthropic「thinking 块在 text 之前」的顺序约束
    const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
    if (typeof reasoning === "string" && reasoning) {
      this.openThinkingBlock();
      emit(this.res, "content_block_delta", {
        type: "content_block_delta",
        index: this.thinkingBlockIndex,
        delta: { type: "thinking_delta", thinking: reasoning },
      });
    }
    if (typeof delta["content"] === "string" && delta["content"]) {
      this.openTextBlock();
      emit(this.res, "content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text: delta["content"] },
      });
    }
    const rawCalls = delta["tool_calls"];
    if (!Array.isArray(rawCalls)) return;
    for (const raw of rawCalls) {
      if (!raw || typeof raw !== "object") continue;
      const call = raw as Rec;
      const index = typeof call["index"] === "number" && Number.isFinite(call["index"])
        ? (call["index"] as number)
        : this.tools.size;
      let tool = this.tools.get(index);
      if (!tool) {
        this.closeThinkingBlock();
        this.closeTextBlock();
        tool = {
          id: typeof call["id"] === "string" && call["id"] ? call["id"] : `toolu_gateway_${index + 1}`,
          name: "",
          args: "",
          blockIndex: this.blockIndex++,
          opened: false,
        };
        this.tools.set(index, tool);
      }
      const fn = call["function"] && typeof call["function"] === "object" ? (call["function"] as Rec) : {};
      if (typeof fn["name"] === "string" && fn["name"]) tool.name = fn["name"];
      if (typeof fn["arguments"] === "string") tool.args += fn["arguments"];
      if (!tool.opened && tool.name) {
        tool.opened = true;
        emit(this.res, "content_block_start", {
          type: "content_block_start",
          index: tool.blockIndex,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        });
      }
      if (tool.opened && fn["arguments"]) {
        emit(this.res, "content_block_delta", {
          type: "content_block_delta",
          index: tool.blockIndex,
          delta: { type: "input_json_delta", partial_json: String(fn["arguments"]) },
        });
      }
    }
  }

  private noteUsage(usage: unknown): void {
    if (!usage || typeof usage !== "object") return;
    const u = usage as Rec;
    if (typeof u["prompt_tokens"] === "number") this.inputTokens = u["prompt_tokens"];
    if (typeof u["completion_tokens"] === "number") this.outputTokens = u["completion_tokens"];
  }

  private messageStart(): void {
    emit(this.res, "message_start", {
      type: "message_start",
      message: {
        id: `msg_${Date.now().toString(36)}`,
        type: "message",
        role: "assistant",
        model: this.requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  private openThinkingBlock(): void {
    if (this.thinkingBlockIndex >= 0) return;
    this.thinkingBlockIndex = this.blockIndex++;
    emit(this.res, "content_block_start", {
      type: "content_block_start",
      index: this.thinkingBlockIndex,
      content_block: { type: "thinking", thinking: "" },
    });
  }

  private openTextBlock(): void {
    // anthropic 语义顺序：thinking 块必须先于 text 块出现 —— 开 text 前先关 thinking
    this.closeThinkingBlock();
    if (this.textBlockIndex >= 0) return;
    this.textBlockIndex = this.blockIndex++;
    emit(this.res, "content_block_start", {
      type: "content_block_start",
      index: this.textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  private closeTextBlock(): void {
    if (this.textBlockIndex < 0) return;
    emit(this.res, "content_block_stop", { type: "content_block_stop", index: this.textBlockIndex });
    this.textBlockIndex = -1;
  }

  /** 关 thinking 块（若有）。 */
  private closeThinkingBlock(): void {
    if (this.thinkingBlockIndex < 0) return;
    emit(this.res, "content_block_stop", { type: "content_block_stop", index: this.thinkingBlockIndex });
    this.thinkingBlockIndex = -1;
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) this.messageStart();
    this.closeThinkingBlock();
    this.closeTextBlock();
    for (const tool of this.tools.values()) {
      if (tool.opened) emit(this.res, "content_block_stop", { type: "content_block_stop", index: tool.blockIndex });
    }
    emit(this.res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReasonOf(this.finishReason), stop_sequence: null },
      // input_tokens 也带上：Claude Code 只在 message_delta 里读 usage 的客户端
      // 拿不到 message_start 的值（`input_tokens` 为 0 会误判上下文没占用）
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    });
    emit(this.res, "message_stop", { type: "message_stop" });
  }

  writeError(code: string, message: string): void {
    emit(this.res, "error", anthropicErrorBody(code, message));
  }
}

export const anthropicProtocol: InboundProtocol = {
  name: "anthropic",
  encodeCompletion: (aggregated, requestModel) => encodeCompletion(aggregated, requestModel),
  openEncoder: (res, requestModel, inputEstimate) =>
    new AnthropicSink(res, requestModel, inputEstimate ?? 0),
};
