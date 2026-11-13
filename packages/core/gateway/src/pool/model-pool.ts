/**
 * 对外模型名 → 该渠道的上游模型名。
 *
 * **优先问渠道目录**（`catalog.resolveModel()`）：上游 id 形态各异
 * （`gfmodel` / `sn-deepseek-v4-1-flash-1017` / `LongCat-2.5`），渠道自己最清楚。
 * 目录不认（或原样返回，部分是恒等 stub）时回落**注册表**的逐渠道声明 ——
 * 注册表仍保留上游 id 作为兜底，不再是候选列表的来源。
 */

import type { Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { upstreamIdOf } from "./model-registry.js";

/**
 * 把对外模型名解析为该渠道的上游模型名；该渠道不提供这个模型时返回 `null`。
 *
 * `name` 可以是别名（`deepseek-flash`）：目录与注册表内部都会归一到规范名。
 */
export function resolvePoolModel(channel: Channel, name: string): string | null {
  const cid = channel.config.cid;
  const resolved = runInChannel(cid, () => channel.catalog.resolveModel(name));
  if (resolved.trim() !== "" && resolved !== name) return resolved;
  return upstreamIdOf(name, cid) ?? null;
}
