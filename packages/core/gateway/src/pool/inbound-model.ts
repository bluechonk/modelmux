/**
 * 入站模型名解析：客户端模型名 → 池 id `<cid>/<模型>`（route.ts 调用）。
 *
 * 约束：对外模型 id 恒为 `<cid>/<模型>`（渠道由请求方显式指定）；解析只做两件容错 ——
 * 剥 `[1m]` 后缀（Claude Code 的 1M 窗口标记）与 `modelmux/` 前缀，然后要求含 `/`。
 * 裸模型名一律 400（见根 AGENTS.md「代码约定」）。只读注册表，不发上游请求。
 */

import { parsePoolModel } from "./pool-targets.js";

/** 一次解析的结果；`target` 为 null 时 `error` 是给人看的 400 文案。 */
export interface InboundModelResolution {
  target: string | null;
  /** 命中途径（诊断用；当前只有 `pool` —— 本来就是池 id 或带容错前缀的池 id）。 */
  via: "pool";
  error?: string;
}

/** `modelmux/` 前缀（历史客户端配置里的写法）。 */
const SELF_PREFIX = /^modelmux\//i;

export function resolveInboundModel(raw: string): InboundModelResolution {
  let name = raw.trim();
  // [1m] 后缀：Claude Code 的 1M 窗口标记（CCR 同款约定），池 id 里不存在
  name = name.replace(/\[1m\]$/i, "").trim();
  name = name.replace(SELF_PREFIX, "");
  if (!name) {
    return { target: null, via: "pool", error: "model name is empty" };
  }
  if (!name.includes("/")) {
    return {
      target: null,
      via: "pool",
      error: `unknown model ${raw}; 对外模型 id 恒为 <渠道>/<模型> 形态（模型清单见 GET /v1/models）`,
    };
  }
  const parsed = parsePoolModel(name);
  if (!parsed) {
    return {
      target: null,
      via: "pool",
      error: `unknown model ${raw}; 请用 <渠道>/<模型> 形态（模型清单见 GET /v1/models）`,
    };
  }
  return { target: `${parsed.cid}/${parsed.model}`, via: "pool" };
}
