/**
 * OrcaTerm 模型目录。
 *
 * 协议事实（来自 ZFXing-lite/orcaterm2api 与 hey7195/orcaterm_proxy 的参考实现）：
 * - 上游 `setting.model` 走 `TokenHub/<模型名>` 前缀，少量模型走 `Hunyuan3/` 前缀
 * - 18 个已知模型（8 current + 9 legacy + 1 兼容别名 `orcaterm-assistant`）
 * - 上游对未开通/不存在的模型名返回空流（不报错），故只列出已验证的模型
 *
 * 无上游模型列表端点，目录与 OrcaTerm 客户端同源内置。
 */

/** 模型条目：id 为网关对外展示名，upstream 为上游 setting.model。 */
interface ModelEntry {
  id: string;
  upstream: string;
  legacy: boolean;
}

/** 兼容别名，指向默认模型。 */
const ALIAS_MODEL = "orcaterm-assistant";

/** 默认模型。 */
const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/** 模型目录（快照）。 */
const MODELS: ModelEntry[] = [
  { id: "deepseek-v4-pro", upstream: "TokenHub/deepseek-v4-pro", legacy: false },
  { id: "deepseek-v4-flash", upstream: "TokenHub/deepseek-v4-flash", legacy: false },
  { id: "hy3", upstream: "Hunyuan3/hy3", legacy: false },
  { id: "hy4-preview", upstream: "Hunyuan3/hy4-preview", legacy: false },
  { id: "kimi-k3", upstream: "TokenHub/kimi-k3", legacy: false },
  { id: "glm-5.2", upstream: "TokenHub/glm-5.2", legacy: false },
  { id: "glm-5.3", upstream: "TokenHub/glm-5.3", legacy: false },
  { id: "glm-5.3-flash", upstream: "TokenHub/glm-5.3-flash", legacy: false },
  { id: "deepseek-chat-latest", upstream: "TokenHub/deepseek-chat-latest", legacy: true },
  { id: "glm-4.7", upstream: "TokenHub/glm-4.7", legacy: true },
  { id: "kimi-k2", upstream: "TokenHub/kimi-k2", legacy: true },
  { id: "kimi-k2.5", upstream: "TokenHub/kimi-k2.5", legacy: true },
  { id: "kimi-k2-thinking", upstream: "TokenHub/kimi-k2-thinking", legacy: true },
  { id: "kimi-k2.5-thinking", upstream: "TokenHub/kimi-k2.5-thinking", legacy: true },
  { id: "hunyuan-t1", upstream: "Hunyuan3/hunyuan-t1", legacy: true },
  { id: "hunyuan-turbos", upstream: "Hunyuan3/hunyuan-turbos", legacy: true },
  { id: "qwen3", upstream: "TokenHub/qwen3", legacy: true },
];

/** 默认模型的上游 id。 */
const DEFAULT_UPSTREAM_MODEL = (() => {
  const hit = MODELS.find((m) => m.id === DEFAULT_MODEL_ID);
  return hit ? hit.upstream : "TokenHub/deepseek-v4-flash";
})();

/**
 * 已知模型的**最大输出 token**（上游目录不下发，按公开规格补）。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回空流）—— 客户端应能降档重试。
 * 数值与来源见 `docs/MODEL-SPECS.md`（唯一事实源；渠道表在本文件的 `MAX_OUTPUTS`）。
 */
const MAX_OUTPUTS: Readonly<Record<string, number>> = {
  "deepseek-v4-pro": 393_216,
  "deepseek-v4-flash": 393_216,
  "glm-4.7": 131_072,
  "glm-5.2": 131_072,
  "glm-5.3": 131_072,
  "glm-5.3-flash": 131_072,
  "kimi-k3": 1_048_576,
  // 兼容别名：指向默认模型（deepseek-v4-flash）
  [ALIAS_MODEL]: 393_216,
};

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（与 `exposedIds()` 同形），故直接查表。
 * **查不到返回 undefined**（不编造 —— 如混元 / kimi-k2 / qwen3 均无公开输出规格）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = MAX_OUTPUTS[modelId.toLowerCase()];
  if (maxOutputTokens === undefined) return undefined;
  return { maxOutputTokens };
}

/** 对外暴露的模型 id 列表（小写）。 */
export function exposedIds(): string[] {
  return [...MODELS.map((m) => m.id.toLowerCase()), ALIAS_MODEL];
}

/** 将对外模型名映射为上游 setting.model（大小写不敏感）。 */
export function resolveModel(name: string): string {
  const lower = name.toLowerCase().trim();
  if (!lower || lower === ALIAS_MODEL) return DEFAULT_UPSTREAM_MODEL;
  const hit = MODELS.find((m) => m.id.toLowerCase() === lower);
  if (hit) return hit.upstream;
  return lower;
}
