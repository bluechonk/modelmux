/**
 * 入站模型名解析：客户端模型名 → 规范模型名（route.ts 调用）。
 *
 * 约束：对外只暴露模型家族表里的名字（见 `model-family.ts`），客户端用**裸模型名**请求；
 * 解析只做两项容错 —— 剥 `[1m]` 后缀（Claude Code 的 1M 窗口标记）与 `modelmux/` 前缀，
 * 其余交给 `canonicalOf`（大小写不敏感 + 别名归并）。不在家族里的一律 400。
 *
 * 只读模型家族表，不碰渠道目录、不发上游请求。
 */

import { canonicalOf, POOL_MODEL_IDS } from "./model-family.js";

/** 一次解析的结果；`target` 为 null 时 `error` 是给人看的 400 文案。 */
export interface InboundModelResolution {
  /** 规范模型名（如 `deepseek-v4.1-flash`）；解析失败为 null。 */
  target: string | null;
  /** 命中途径（诊断用；当前只有 `pool` —— 本来就是对外家族名或带容错前缀）。 */
  via: "pool";
  error?: string;
}

/** `modelmux/` 前缀（历史客户端配置里的写法）。 */
const SELF_PREFIX = /^modelmux\//i;

export function resolveInboundModel(raw: string): InboundModelResolution {
  const name = raw.trim().replace(/\[1m\]$/i, "").trim().replace(SELF_PREFIX, "").trim();
  const canonical = canonicalOf(name);
  if (!canonical) {
    return {
      target: null,
      via: "pool",
      error: `unknown model ${raw}; 可用模型：${POOL_MODEL_IDS.join(" / ")}（模型清单见 GET /v1/models）`,
    };
  }
  return { target: canonical, via: "pool" };
}
