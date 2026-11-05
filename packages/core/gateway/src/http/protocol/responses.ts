/**
 * OpenAI Responses 协议适配（Codex 原生协议，wire_api="responses"）。
 *
 * 约束：请求翻译成 OpenAI chat payload（instructions 前置、custom tool → function
 * tool 桥接、reasoning item 跳过）；回程产出 response.created → … → response.completed
 * 事件族（usage 在 completed）。桥接与事件顺序细节见函数注释；CCR 锚点 codex-patch-bridge.ts。
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

export function translateResponsesRequest(
  body: Rec,
): { ok: true; value: TranslatedChat } | { ok: false; error: string } {
  const model = body["model"];
  if (typeof model !== "string" || !model.trim()) return { ok: false, error: "model is required" };

  const chatMessages: Rec[] = [];
  // instructions → system（Codex 的 base_instructions 走这里）
  const instructions = body["instructions"];
  if (typeof instructions === "string" && instructions) {
    chatMessages.push({ role: "system", content: instructions });
  }

  const input = body["input"];
  const items: Rec[] = [];
  if (typeof input === "string") {
    if (!input) return { ok: false, error: "input is required" };
    items.push({ type: "message", role: "user", content: input });
  } else if (Array.isArray(input)) {
    items.push(...(input.filter((x): x is Rec => Boolean(x) && typeof x === "object")));
  } else if (input && typeof input === "object") {
    items.push(input as Rec);
  } else {
    return { ok: false, error: "input is required (string or item array)" };
  }

  /** 连续 function_call/custom_tool_call 合并进一条 assistant 消息（chat 线型惯例）。 */
  let pendingCalls: Rec[] | null = null;
  const flushCalls = (): void => {
    if (pendingCalls && pendingCalls.length > 0) chatMessages.push({ role: "assistant", content: null, tool_calls: pendingCalls });
    pendingCalls = null;
  };
  for (const item of items) {
    const type = item["type"];
    if (type === "message") {
      const role = item["role"] === "assistant" ? "assistant" : item["role"] === "developer" || item["role"] === "system" ? "system" : "user";
      const converted = convertResponseMessage(role, item["content"]);
      if (converted) {
        flushCalls();
        chatMessages.push(converted);
      }
    } else if (type === "function_call") {
      const name = item["name"];
      if (typeof name !== "string" || !name) continue;
      (pendingCalls ??= []).push({
        type: "function",
        id: typeof item["call_id"] === "string" ? item["call_id"] : "",
        function: { name, arguments: typeof item["arguments"] === "string" ? item["arguments"] : "{}" },
      });
    } else if (type === "custom_tool_call") {
      const name = item["name"];
      if (typeof name !== "string" || !name) continue;
      // freeform 输入包成 {input} 参数（与工具定义侧的单参数形状对应）
      (pendingCalls ??= []).push({
        type: "function",
        id: typeof item["call_id"] === "string" ? item["call_id"] : "",
        function: { name, arguments: JSON.stringify({ input: String(item["input"] ?? "") }) },
      });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      flushCalls();
      const output = item["output"];
      chatMessages.push({
        role: "tool",
        tool_call_id: typeof item["call_id"] === "string" ? item["call_id"] : "",
        content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
    }
    // reasoning / item_reference：跳过（见文件头）
  }
  flushCalls();

  if (chatMessages.length === 0 || !chatMessages.some((m) => m["role"] !== "system")) {
    return { ok: false, error: "input produced no convertible content" };
  }

  const payload: Rec = {
    model,
    messages: chatMessages,
    stream: Boolean(body["stream"]),
  };
  const maxOut = body["max_output_tokens"];
  if (typeof maxOut === "number" && Number.isFinite(maxOut) && maxOut > 0) payload["max_tokens"] = maxOut;
  if (typeof body["temperature"] === "number") payload["temperature"] = body["temperature"];
  if (typeof body["top_p"] === "number") payload["top_p"] = body["top_p"];
  // reasoning.effort → chat 的 reasoning_effort（不认的上游会忽略）
  const reasoning = body["reasoning"];
  if (reasoning && typeof reasoning === "object") {
    const effort = (reasoning as Rec)["effort"];
    if (typeof effort === "string") payload["reasoning_effort"] = effort;
  }
  if (typeof body["parallel_tool_calls"] === "boolean") {
    payload["parallel_tool_calls"] = body["parallel_tool_calls"];
  }

  // tools：function 直通；custom（apply_patch）→ 单 input 参数的 function tool；
  // web_search / local_shell / mcp 等 chat 线型没有对应物，跳过
  if (Array.isArray(body["tools"])) {
    const tools: Rec[] = [];
    for (const raw of body["tools"]) {
      if (!raw || typeof raw !== "object") continue;
      const tool = raw as Rec;
      const name = tool["name"];
      if (typeof name !== "string" || !name) continue;
      if (tool["type"] === "function") {
        const fn: Rec = {
          name,
          description: typeof tool["description"] === "string" ? tool["description"] : "",
          parameters:
            tool["parameters"] && typeof tool["parameters"] === "object"
              ? tool["parameters"]
              : { type: "object", properties: {} },
        };
        if (tool["strict"] === true) fn["strict"] = true;
        tools.push({ type: "function", function: fn });
      } else if (tool["type"] === "custom") {
        const format = tool["format"] && typeof tool["format"] === "object" ? (tool["format"] as Rec) : {};
        tools.push({
          type: "function",
          function: {
            name,
            description:
              typeof format["description"] === "string"
                ? (format["description"] as string)
                : `Freeform tool ${name}; the input parameter carries the raw payload`,
            parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
          },
        });
      }
    }
    if (tools.length > 0) payload["tools"] = tools;
  }

  // tool_choice：字符串直通；function/custom 对象归一
  const choice = body["tool_choice"];
  if (typeof choice === "string" && ["auto", "none", "required"].includes(choice)) {
    payload["tool_choice"] = choice;
  } else if (choice && typeof choice === "object") {
    const c = choice as Rec;
    if ((c["type"] === "function" || c["type"] === "custom") && typeof c["name"] === "string") {
      payload["tool_choice"] = { type: "function", function: { name: c["name"] } };
    }
  }

  return { ok: true, value: { payload, model, messages: chatMessages } };
}

/** Responses 消息 content（string 或 parts）→ chat 消息。 */
function convertResponseMessage(role: "user" | "assistant" | "system", content: unknown): Rec | null {
  const parts: Rec[] = [];
  const pushText = (text: string): void => {
    if (text) parts.push({ type: "text", text });
  };
  if (typeof content === "string") {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Rec;
      if (typeof part["text"] === "string") {
        // input_text / output_text / 其他文本变体统一取 text
        pushText(part["text"]);
      } else if (part["type"] === "input_image" || part["type"] === "image_url") {
        const url = part["image_url"] ?? part["url"];
        if (typeof url === "string") parts.push({ type: "image_url", image_url: { url } });
      }
    }
  }
  if (parts.length === 0) return null;
  if (role === "user" && parts.every((p) => p["type"] === "text")) {
    // 单文本 user 消息给纯字符串：兼容只认 string content 的上游
    if (parts.length === 1) return { role, content: parts[0]!["text"] };
  }
  return { role, content: parts };
}

// ── 回程编码 ────────────────────────────────────────────────────────────────

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 聚合 usage → Responses usage（带 *_details，Codex 的账目读这里）。 */
function responsesUsage(usage: Rec): Rec {
  const input = toNum(usage["prompt_tokens"]);
  const output = toNum(usage["completion_tokens"]);
  const cached = toNum((usage["prompt_tokens_details"] as Rec | undefined)?.["cached_tokens"]);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: toNum(usage["total_tokens"]) || input + output,
  };
}

/** 重建 output 数组（非流式整体编码与流式收尾共用）。 */
function outputItems(message: AggregatedCompletion["choices"][number] | undefined, ids: ItemIds): Rec[] {
  const items: Rec[] = [];
  // reasoning item 在最前（output 数组顺序即语义顺序：思考 → 正文 → 工具调用）
  const reasoning = message?.message.reasoning_content;
  if (typeof reasoning === "string" && reasoning) {
    items.push({ type: "reasoning", id: ids.callId().replace("call_", "rs_"), summary: [] });
  }
  const text = typeof message?.message.content === "string" ? message!.message.content : "";
  if (text || (message?.message.tool_calls?.length ?? 0) === 0) {
    items.push({
      type: "message",
      id: ids.messageId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of message?.message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      id: ids.functionCallId(call.id),
      call_id: call.id || ids.callId(),
      name: call.function.name,
      arguments: call.function.arguments || "{}",
      status: "completed",
    });
  }
  return items;
}

interface ItemIds {
  messageId: string;
  callId: () => string;
  functionCallId: (upstreamId: string) => string;
}

function ids(): ItemIds {
  let seq = 0;
  const next = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${++seq}`;
  return {
    messageId: next("msg"),
    callId: () => next("call"),
    functionCallId: (upstreamId) => (upstreamId ? upstreamId : next("fc")),
  };
}

/** 非流式：聚合 completion → response JSON。 */
function encodeCompletion(aggregated: AggregatedCompletion, requestModel: string): Rec {
  const choice = aggregated.choices[0];
  return {
    id: `resp_${aggregated.id}`,
    object: "response",
    created_at: aggregated.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestModel,
    output: outputItems(choice, ids()),
    usage: responsesUsage(aggregated.usage ?? {}),
    error: null,
    incomplete_details: null,
  };
}

function emit(res: ServerResponse, event: string, data: Rec): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface StreamTool {
  callId: string;
  name: string;
  args: string;
  itemId: string;
  outputIndex: number;
  added: boolean;
}

/**
 * Responses 流式编码器。
 *
 * 事件顺序对 Codex 是硬约束：item 必须先 added 再 delta 再 done，
 * message 与 function_call 是 output 数组里的兄弟项（各自占一个 output_index）。
 * 收尾必须发 response.completed（usage 在里面），Codex 靠它结算回合。
 */
class ResponsesSink implements ProtocolSink {
  readonly name: ProtocolName = "responses";
  private started = false;
  private closed = false;
  private errored = false;
  private sequence = 0;
  private outputIndex = 0;
  private responseId = `resp_${Date.now().toString(36)}`;
  private createdAt = Math.floor(Date.now() / 1000);
  private messageId = "";
  /** 文本 item 是否已打开（added 事件已发）。 */
  private textOpened = false;
  private textParts: string[] = [];
  /** 推理 item（上游 reasoning_content 映射；必须在 message 之前）。 */
  private reasoningOpened = false;
  private reasoningId = "";
  private reasoningParts: string[] = [];
  private reasoningOutputIndex = 0;
  private tools = new Map<number, StreamTool>();
  private finishReason: unknown = null;
  private usage: Rec = {};

  constructor(
    private readonly res: ServerResponse,
    private readonly requestModel: string,
  ) {}

  private nextSeq(): number {
    return this.sequence++;
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
      emit(this.res, "response.created", {
        type: "response.created",
        sequence_number: this.nextSeq(),
        response: this.responseEnvelope("in_progress"),
      });
    }
    if (chunk["usage"] && typeof chunk["usage"] === "object") this.usage = chunk["usage"] as Rec;
    const choices = chunk["choices"];
    if (!Array.isArray(choices)) return;
    for (const raw of choices) {
      if (!raw || typeof raw !== "object") continue;
      const choice = raw as Rec;
      const delta = choice["delta"];
      if (delta && typeof delta === "object") this.handleDelta(delta as Rec);
      if (typeof choice["finish_reason"] === "string" && choice["finish_reason"]) {
        this.finishReason = choice["finish_reason"];
      }
    }
  }

  private handleDelta(delta: Rec): void {
    // 推理流（DeepSeek 风格 reasoning_content）→ reasoning item：上游推理先于正文，
    // 恰好满足 Responses「reasoning 在 message 之前」的顺序约束
    const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
    if (typeof reasoning === "string" && reasoning) {
      if (!this.reasoningOpened) this.openReasoning();
      this.reasoningParts.push(reasoning);
      emit(this.res, "response.reasoning_text.delta", {
        type: "response.reasoning_text.delta",
        sequence_number: this.nextSeq(),
        item_id: this.reasoningId,
        output_index: this.reasoningOutputIndex,
        delta: reasoning,
      });
    }
    if (typeof delta["content"] === "string" && delta["content"]) {
      if (!this.textOpened) this.openText();
      this.textParts.push(delta["content"]);
      emit(this.res, "response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: this.nextSeq(),
        item_id: this.messageId,
        output_index: 0,
        content_index: 0,
        delta: delta["content"],
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
        this.closeReasoning();
        this.closeText();
        tool = {
          callId: typeof call["id"] === "string" && call["id"] ? call["id"] : `call_${index + 1}`,
          name: "",
          args: "",
          itemId: `fc_${Date.now().toString(36)}_${index + 1}`,
          outputIndex: this.outputIndex++,
          added: false,
        };
        this.tools.set(index, tool);
      }
      const fn = call["function"] && typeof call["function"] === "object" ? (call["function"] as Rec) : {};
      if (typeof fn["name"] === "string" && fn["name"]) tool.name = fn["name"];
      if (typeof fn["arguments"] === "string") tool.args += fn["arguments"];
      if (!tool.added && tool.name) {
        tool.added = true;
        emit(this.res, "response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: this.nextSeq(),
          output_index: tool.outputIndex,
          item: {
            type: "function_call",
            id: tool.itemId,
            call_id: tool.callId,
            name: tool.name,
            arguments: "",
            status: "in_progress",
          },
        });
      }
      if (tool.added && fn["arguments"]) {
        emit(this.res, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: this.nextSeq(),
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          delta: String(fn["arguments"]),
        });
      }
    }
  }

  /** 推理 item：reasoning 在 message 之前（output 数组顺序即语义顺序）。 */
  private openReasoning(): void {
    this.reasoningOpened = true;
    this.reasoningId = `rs_${Date.now().toString(36)}`;
    this.reasoningOutputIndex = this.outputIndex++;
    emit(this.res, "response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: this.nextSeq(),
      output_index: this.reasoningOutputIndex,
      item: { type: "reasoning", id: this.reasoningId, summary: [] },
    });
  }

  private closeReasoning(): void {
    if (!this.reasoningOpened) return;
    this.reasoningOpened = false;
    emit(this.res, "response.reasoning_text.done", {
      type: "response.reasoning_text.done",
      sequence_number: this.nextSeq(),
      item_id: this.reasoningId,
      output_index: this.reasoningOutputIndex,
      text: this.reasoningParts.join(""),
    });
    emit(this.res, "response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: this.nextSeq(),
      output_index: this.reasoningOutputIndex,
      item: { type: "reasoning", id: this.reasoningId, summary: [] },
    });
  }

  private openText(): void {
    this.closeReasoning();
    this.textOpened = true;
    this.messageId = `msg_${Date.now().toString(36)}`;
    emit(this.res, "response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: this.nextSeq(),
      output_index: this.outputIndex++,
      item: { type: "message", id: this.messageId, role: "assistant", status: "in_progress", content: [] },
    });
    emit(this.res, "response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: this.nextSeq(),
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private closeText(): void {
    if (!this.textOpened) return;
    this.textOpened = false;
    const text = this.textParts.join("");
    emit(this.res, "response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: this.nextSeq(),
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      text,
    });
    emit(this.res, "response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: this.nextSeq(),
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    emit(this.res, "response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: this.nextSeq(),
      output_index: 0,
      item: {
        type: "message",
        id: this.messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    });
  }

  private closeTools(): void {
    for (const tool of this.tools.values()) {
      if (!tool.added) continue;
      emit(this.res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: this.nextSeq(),
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.args || "{}",
      });
      emit(this.res, "response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: this.nextSeq(),
        output_index: tool.outputIndex,
        item: {
          type: "function_call",
          id: tool.itemId,
          call_id: tool.callId,
          name: tool.name,
          arguments: tool.args || "{}",
          status: "completed",
        },
      });
    }
  }

  private responseEnvelope(status: string, output?: Rec[]): Rec {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.requestModel,
      output: output ?? [],
      usage: null,
      error: null,
      incomplete_details: null,
    };
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) {
      // 空流：也要给 Codex 一个可解析的终止事件
      emit(this.res, "response.created", {
        type: "response.created",
        sequence_number: this.nextSeq(),
        response: this.responseEnvelope("in_progress"),
      });
    }
    this.closeReasoning();
    this.closeText();
    this.closeTools();
    const items = this.collectItems();
    if (this.errored) {
      emit(this.res, "response.failed", {
        type: "response.failed",
        sequence_number: this.nextSeq(),
        response: { ...this.responseEnvelope("failed", items), error: { code: "upstream_error", message: "upstream stream failed" } },
      });
      return;
    }
    emit(this.res, "response.completed", {
      type: "response.completed",
      sequence_number: this.nextSeq(),
      response: { ...this.responseEnvelope("completed", items), usage: responsesUsage(this.usage) },
    });
  }

  /** 回放已产出的 output items（completed 信封里的 output 要与已发事件一致）。 */
  private collectItems(): Rec[] {
    const items: Rec[] = [];
    if (this.reasoningParts.length > 0) {
      items.push({ type: "reasoning", id: this.reasoningId || `rs_${Date.now().toString(36)}`, summary: [] });
    }
    if (this.textParts.length > 0 || this.tools.size === 0) {
      const text = this.textParts.join("");
      items.push({
        type: "message",
        id: this.messageId || `msg_${Date.now().toString(36)}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
    }
    for (const tool of this.tools.values()) {
      if (!tool.added) continue;
      items.push({
        type: "function_call",
        id: tool.itemId,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.args || "{}",
        status: "completed",
      });
    }
    return items;
  }

  writeError(code: string, message: string): void {
    this.errored = true;
    emit(this.res, "error", {
      type: "error",
      sequence_number: this.nextSeq(),
      code,
      message,
      param: null,
    });
  }
}

export const responsesProtocol: InboundProtocol = {
  name: "responses",
  encodeCompletion: (aggregated, requestModel) => encodeCompletion(aggregated, requestModel),
  openEncoder: (res, requestModel) => new ResponsesSink(res, requestModel),
};
