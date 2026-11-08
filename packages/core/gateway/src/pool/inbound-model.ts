/**
 * 入站模型名解析：客户端模型名 → 规范模型名（route.ts / 协议入站共同调用）。
 *
 * 约束：对外只暴露模型家族表里的名字（见 `model-family.ts`），客户端优先用**裸模型名**请求；
 * 解析做三项容错 —— 剥 `[1m]` 窗口标记与 `modelmux/` 前缀、按 `canonicalOf` 做大小写与
 * 别名归并、把 Claude Desktop 的三个角色名按固定表映射到池模型。都不命中一律 400。
 *
 * 只读模型家族表，不碰渠道目录、不发上游请求。
 */

import { canonicalOf, desktopRoleModel, POOL_MODEL_IDS } from "./model-family.js";

/** 一次解析的结果；`target` 为 null 时 `error` 是给人看的 400 文案。 */
export interface InboundModelResolution {
  /** 规范模型名（如 `deepseek-v4.1-flash`）；解析失败为 null。 */
  target: string | null;
  /** 命中途径（诊断用）：家族名 / 别名，还是 Claude Desktop 的角色名映射。 */
  via: "pool" | "desktop-role";
  error?: string;
}

/** `modelmux/` 前缀（历史客户端配置里的写法）。 */
const SELF_PREFIX = /^modelmux\//i;

export function resolveInboundModel(raw: string): InboundModelResolution {
  const name = raw.trim().replace(/\[1m\]$/i, "").trim().replace(SELF_PREFIX, "").trim();
  const canonical = canonicalOf(name);
  if (canonical) return { target: canonical, via: "pool" };
  // Desktop 的角色名不是家族名，但接入 profile 只能写它们（见 `DESKTOP_ROLE_MODELS`）
  const roleModel = desktopRoleModel(name);
  if (roleModel) return { target: roleModel, via: "desktop-role" };
  return {
    target: null,
    via: "pool",
    error: `unknown model ${raw}; 可用模型：${POOL_MODEL_IDS.join(" / ")}（模型清单见 GET /v1/models）`,
  };
}
