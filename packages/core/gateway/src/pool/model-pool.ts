/**
 * 对外模型名 → 该渠道的上游模型名。
 *
 * 映射来自**统一注册表**（`<root>/models.json` 的 `channels` 段），不再问渠道目录：
 * 渠道上游 id 形态各异（`gfmodel` / `sn-deepseek-v4-1-flash-1017` / `LongCat-2.5`），
 * 由注册表逐渠道声明；删掉它请求就打不到模型。
 */

import type { Channel } from "../runtime/channel.js";
import { upstreamIdOf } from "./model-registry.js";

/**
 * 把对外模型名解析为该渠道的上游模型名；该渠道不提供这个模型时返回 `null`。
 *
 * `name` 可以是别名（`deepseek-flash`）：注册表按规范名建键，`upstreamIdOf` 内部归一。
 */
export function resolvePoolModel(channel: Channel, name: string): string | null {
  return upstreamIdOf(name, channel.config.cid) ?? null;
}
