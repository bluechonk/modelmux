/**
 * 入站协议适配层契约：协议句柄（回程编码）与每请求的流式编码器。
 *
 * 内部 canonical 协议是 OpenAI chat completions（既有转发层的统一产出形态）：
 * 入站 adapter 把新协议请求**翻译成 chat payload** 走既有池层（request 侧），
 * 回程由编码器消费 OpenAI SSE 帧**产出协议事件字节**（response 侧）。
 * 池层 / attempt / 排队 / 账号轮换对入站协议无感知。
 *
 * 编码器经 res 上的 Symbol 挂载（`sinkOf`）：排队进度帧（attempt.ts）、
 * 流中错误（stream.ts）、探测前缀帧（sse-stream.ts）这些写入点分散在四层，
 * 全部改为从 res 取编码器，避免把 sink 参数穿满整条转发链。
 */

import type { ServerResponse } from "node:http";

import type { AggregatedCompletion } from "../wire/sse-stream.js";

export type ProtocolName = "anthropic" | "responses";

/** 每请求的流式回程编码器：吃 OpenAI SSE 帧，吐协议事件字节。 */
export interface ProtocolSink {
  readonly name: ProtocolName;
  /**
   * 一条 OpenAI SSE 帧（`data: {...}\n\n` / `data: [DONE]\n\n`）。
   *
   * 排队占位帧（空 role 帧）、内容 delta、tool_calls delta、finish_reason 帧、
   * usage 帧都从这进；编码器自己维护「先开 message 再开块」的状态机。
   */
  writeOpenAiFrame(frame: Buffer | string): void;
  /** 上游流结束：补协议收尾事件（message_delta/message_stop、response.completed）。 */
  finish(): void;
  /** 流中错误（响应头已发）：以协议形态投递；随后的 finish() 仍要收尾。 */
  writeError(code: string, message: string): void;
}

/** 一个入站协议的完整回程适配（请求侧翻译在 anthropic.ts / responses.ts）。 */
export interface InboundProtocol {
  readonly name: ProtocolName;
  /** 非流式：聚合的 OpenAI completion → 协议应答 JSON。 */
  encodeCompletion(aggregated: AggregatedCompletion, requestModel: string): unknown;
  /** 流式：新建每请求编码器并挂到 res 上；requestModel = 客户端请求里的模型名原文。 */
  openEncoder(res: ServerResponse, requestModel: string): ProtocolSink;
}

const PROTOCOL = Symbol("modelmux.inboundProtocol");
const SINK = Symbol("modelmux.protocolSink");

interface ProtocolContext {
  protocol: InboundProtocol;
  /** 客户端请求里的模型名原文（协议应答的 `model` 字段用它，不是池 id）。 */
  requestModel: string;
}

type WithProtocol = ServerResponse & { [PROTOCOL]?: ProtocolContext; [SINK]?: ProtocolSink };

/** 挂协议上下文：此后该请求的错误信封与非流式应答都按协议形态写。 */
export function attachProtocol(res: ServerResponse, protocol: InboundProtocol, requestModel: string): void {
  (res as WithProtocol)[PROTOCOL] = { protocol, requestModel };
}

export function protocolOf(res: ServerResponse): ProtocolContext | undefined {
  return (res as WithProtocol)[PROTOCOL];
}

/** 流式转发开始后才有值；排队进度帧与流中错误据此转译。 */
export function sinkOf(res: ServerResponse): ProtocolSink | undefined {
  return (res as WithProtocol)[SINK];
}

export function setSink(res: ServerResponse, sink: ProtocolSink): void {
  (res as WithProtocol)[SINK] = sink;
}
