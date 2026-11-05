/**
 * 上下文弹窗的分片推进纯逻辑（从 `LogContextDialog.PayloadBlock` 抽出）。
 *
 * 这里钉着两个实测出现过的坑：
 *   - 「首片拼两遍」：推进 offset 后必须消费**该片对应**的分片数据，而不是手里
 *     残留的上一片（旧实现点击路径把首片拼了两遍）；
 *   - 「首屏永远空串」：首片（offset=0）必须自动进正文，否则任何解析都拿不到输入。
 * 抽成纯函数后，这两个不变量可以被表驱动测试钉死。
 */

/** 首屏与后续分片的大小（与后端 `PAYLOAD_SLICE_BYTES` 一致）。 */
export const PAYLOAD_SLICE = 64 * 1024;

export interface SliceView {
  body: string;
}

/** 下一个分片的偏移：夹到 `total`（最后一片允许短于整片）。 */
export function nextOffset(offset: number, total: number): number {
  return Math.min(offset + PAYLOAD_SLICE, total);
}

/**
 * 已拼装的正文。
 *
 * `record.body` 非空 = 元数据请求带回了整段（旧路径 / full=1），直接用；
 * 否则 = 已积累 `loaded` + **当前 offset 命中的那一片**：offset=0 消费首片，
 * 之后消费续片查询的数据。当前片未到达时贡献空串（显示「读取中」）。
 */
export function assembledBody(input: {
  recordBody: string;
  loaded: string;
  offset: number;
  firstSlice?: SliceView | undefined;
  nextSlice?: SliceView | undefined;
}): string {
  if (input.recordBody !== "") return input.recordBody;
  const current =
    input.offset === 0 ? (input.firstSlice?.body ?? "") : (input.nextSlice?.body ?? "");
  return input.loaded + current;
}

/** 是否还有剩余正文没取（到顶后懒加载停止）。 */
export function hasMore(input: { recordBody: string; offset: number; total: number }): boolean {
  return input.recordBody === "" && input.offset < input.total;
}
