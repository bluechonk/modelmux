/**
 * 渠道维度的两个小判定：调用渠道模块时的上下文包装、上游线型判定。
 *
 * 关键约束：
 *   - 渠道模块内部靠 `paths.*` 找自己的落点，调用前必须进入该渠道上下文
 *   - 线型非 `openai` 的渠道需要翻译层（帧增量解析），走 chat/stream 的中继路径
 *
 * 铁律：只按注册渠道暴露的字段判定，不含任何渠道知识。
 */

import { type Channel } from "../../runtime/channel.js";
import { runInChannel } from "../../runtime/channel-context.js";

/** 调用渠道模块时一律包进渠道上下文（渠道内部的 `paths.*` 据此解析自己的落点）。 */
export function inChannel<T>(channel: Channel, fn: () => T): T {
  return runInChannel(channel.config.cid, fn);
}

/** 该渠道的上游线型是否为自定义（需翻译层）。 */
export function isCustomWire(channel: Channel): boolean {
  return String(channel.upstream.WIRE) !== "openai";
}
