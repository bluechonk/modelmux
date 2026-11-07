/**
 * 上下文弹窗的两头分片推进纯逻辑（从 `LogContextDialog.PayloadBlock` 抽出）。
 *
 * 正文切成固定格子 `[k·64KiB, (k+1)·64KiB)`，头尾相向逐格取；窗口正文以 base64 传递，
 * 按格拼齐字节后一次 `TextDecoder` 解码（格子劈开的多字节字符逐字节复原）。
 * 不变量（单测钉死）：`headEnd === tailStart` ⇔ 取全，此时按格拼接即完整正文。
 */

/** 格子大小（与后端 `PAYLOAD_SLICE_BYTES` 一致）。 */
export const PAYLOAD_SLICE = 64 * 1024;

/** 一片正文窗口；`offset` / `length` / `total` 都是**字节**，`bodyB64` 是该窗口的原始字节。 */
export interface SliceWindow {
  offset: number;
  length: number;
  total: number;
  bodyB64: string;
}

/** 加载进度：`headEnd` 之前、`tailStart` 之后都已就位（两者都是格边界）。 */
export interface SliceSpan {
  headEnd: number;
  tailStart: number;
  total: number;
}

/** base64 → 字节（分片来自服务端 JSON，解码成本相对 64KiB 网络传输可忽略）。 */
export function decodeSlice(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 字节 → 文本：整段拼齐后的唯一一次转换，替换符只来自源头真坏的字节。 */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export function initialSpan(total: number): SliceSpan {
  const size = Math.max(0, total);
  return { headEnd: 0, tailStart: size, total: size };
}

/** 头侧下一格；已取全时返回 null。 */
export function nextHeadRequest(span: SliceSpan): { offset: number; limit: number } | null {
  if (span.headEnd >= span.tailStart) return null;
  return { offset: span.headEnd, limit: Math.min(PAYLOAD_SLICE, span.total - span.headEnd) };
}

/**
 * 尾侧下一格（末格向上）；已取全时返回 null。
 *
 * 只剩一格时它和头侧申请的是**同一格**（各取一次）—— 这是刻意的：改成「让头侧认领」
 * 会让用户在空隙上**向上**滚时那一格永远不来（头侧被方向门挡住），反过来也一样。
 * 重复的那一次请求换两个方向都不会卡住，重复数据由 `unionBytes` 去重。
 */
export function nextTailRequest(span: SliceSpan): { offset: number; limit: number } | null {
  if (span.headEnd >= span.tailStart) return null;
  const covered = Math.ceil(span.tailStart / PAYLOAD_SLICE); // 已就位的最后一格序号 + 1
  const offset = (covered - 1) * PAYLOAD_SLICE;
  return { offset, limit: Math.min(PAYLOAD_SLICE, span.total - offset) };
}

/** 头侧数据入列：只认**紧邻**当前进度的那一格（乱序到达的窗口先留着，等相邻格补上）。 */
export function growHead(span: SliceSpan, window: SliceWindow): SliceSpan {
  if (window.offset !== span.headEnd || window.length <= 0) return span;
  return { ...span, headEnd: Math.min(span.tailStart, window.offset + window.length) };
}

/** 尾侧数据入列：同样只认紧邻当前进度的那一格。 */
export function growTail(span: SliceSpan, window: SliceWindow): SliceSpan {
  const end = window.offset + window.length;
  if (end !== span.tailStart || window.length <= 0) return span;
  return { ...span, tailStart: Math.max(span.headEnd, window.offset) };
}

export function spanComplete(span: SliceSpan): boolean {
  return span.headEnd >= span.tailStart;
}

/** 未加载的字节数（空隙块文案用）。 */
export function spanGapBytes(span: SliceSpan): number {
  return Math.max(0, span.tailStart - span.headEnd);
}

/**
 * 窗口是否严丝合缝铺满 `[0, total)`：从 0 起逐格相接、最后一格的末尾正好落在 `total`。
 *
 * 只在**进度说取全了**之后才用它兜底 —— 进度（`spanComplete`）只看格边界，不保证数组里
 * 真有那几格；少了格子时拼接会安静地缺一段（「看起来完整实则缺段」是本模块最想堵的坑）。
 */
export function windowsTileFully(windows: readonly SliceWindow[], total: number): boolean {
  const sorted = [...windows].sort((a, b) => a.offset - b.offset).filter((w) => w.length > 0);
  let end = 0;
  for (const window of sorted) {
    if (window.offset > end) return false; // 中间有洞
    if (window.offset < end) continue; // 同一格的重复取回
    end = window.offset + window.length;
  }
  return end === total;
}

/**
 * 按格拼字节：窗口按 `offset` 排序，已被前一格覆盖的跳过（同一格被两头各取一次）。
 *
 * **只在取全后调用** —— 中间有空格时它会安静地跳过空格里的窗口，拼出来的字节缺一段
 * 却看不出来。`assembledBody` 负责把关。
 */
export function unionBytes(windows: readonly SliceWindow[]): Uint8Array {
  const sorted = [...windows].sort((a, b) => a.offset - b.offset);
  let end = 0;
  const parts: Uint8Array[] = [];
  for (const window of sorted) {
    if (window.offset < end) continue; // 同一格重复取回（或落在已覆盖区间内）
    parts.push(decodeSlice(window.bodyB64));
    end = window.offset + window.length;
  }
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * 按格拼成正文文本：`unionBytes` + 一次 `TextDecoder`。
 *
 * **只在取全后调用** —— 未取全时返回空串，让调用方显式走两头渲染路径，而不是拿
 * 半截正文去解析（半截正文解析出的「消息条数」会被当成真的，这是本模块最想堵住的坑）。
 */
export function unionText(windows: readonly SliceWindow[]): string {
  return decodeUtf8(unionBytes(windows));
}

/**
 * 完整正文：`recordBody` 非空（调用方直接给了整段）时用它，否则要求**已取全**再拼。
 *
 * 未取全时返回空串 —— 让调用方显式走两头渲染路径，而不是拿半截正文去解析。
 */
export function assembledBody(input: {
  recordBody: string;
  span: SliceSpan;
  windows: readonly SliceWindow[];
}): string {
  if (input.recordBody !== "") return input.recordBody;
  return spanComplete(input.span) ? unionText(input.windows) : "";
}
