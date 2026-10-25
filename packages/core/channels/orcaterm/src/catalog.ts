/**
 * OrcaTerm 模型目录：无上游列表端点，目录与客户端同源内置（快照）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/orcaterm/PROTOCOL.md）：
 *   - 上游对未开通/不存在的模型名返回空流而不报错，故只列出已验证的模型。
 *   - 上下文窗口与最大输出按公开规格补，查不到就不返回该型号（不编造）。
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
 * 已知模型的**上下文窗口**与**最大输出 token**（本渠道无上游目录端点，两个数都没有上游声明，
 * 按公开规格补）。数值与来源见 `docs/MODEL-SPECS.md`（唯一事实源；表在本文件的 `MODEL_SPECS`）。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回空流）—— 客户端应能降档重试。
 * **查不到就不填该字段**（回落占位值，不编造）—— 如混元 / qwen3 的旧型号已无现行官方页面。
 *
 * 2026-10-25 补充：Hy3 / Hy4 preview 的数值取自 TokenHub 官方文档与混元官方发布页
 * （见 `docs/MODEL-SPECS.md` §3）。
 */
const MODEL_SPECS: Readonly<Record<string, { contextWindow?: number; maxOutputTokens?: number }>> = {
  "deepseek-v4-pro": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v4-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "glm-4.7": { contextWindow: 202_752, maxOutputTokens: 131_072 },
  "glm-5.2": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3-flash": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  // Hy3 preview：TokenHub 官方「上下文窗口 256K / 最大输入 192K / 最大输出 128K」
  hy3: { contextWindow: 262_144, maxOutputTokens: 131_072 },
  // Hy4 preview：官方发布页「上下文长度 1M」；最大输出未公布 → 不填
  "hy4-preview": { contextWindow: 1_048_576 },
  // Hunyuan-TurboS：官方模型卡给 256K 上下文；输出上限无公开规格 → 不填
  "hunyuan-turbos": { contextWindow: 262_144 },
  "kimi-k2": { contextWindow: 131_072 },
  "kimi-k2.5": { contextWindow: 262_144 },
  "kimi-k3": { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 },
  // 兼容别名：指向默认模型（deepseek-v4-flash）
  [ALIAS_MODEL]: { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
};

/**
 * 已知模型的**思考档位**（`reasoning_effort`）—— 取自 TokenHub 官方「推理深度配置」表
 * （完整表格与来源见 `docs/MODEL-SPECS.md` §3.2）。
 *
 * ⚠ 这是**官方文档**而不是运行时上游声明（本渠道没有目录端点），所以经 `modelSpec()` 走
 * 「渠道规格」通道，池层把来源标成 `spec` 而不是 `upstream` —— 两者不能混为一谈。
 * `none` = 关闭思考（TokenHub 用它表示关，与 loomy / lobsterai 的 `off` 同义）。
 */
const MODEL_EFFORTS: Readonly<
  Record<string, { supportedLevels: string[]; defaultLevel: string }>
> = {
  "hy4-preview": { supportedLevels: ["high", "none"], defaultLevel: "high" },
  hy3: { supportedLevels: ["low", "high", "none"], defaultLevel: "high" },
  "deepseek-v4-flash": { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
  "deepseek-v4-pro": { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
  "glm-5.2": {
    supportedLevels: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    defaultLevel: "max",
  },
  "glm-5.3": { supportedLevels: ["low", "high", "max"], defaultLevel: "max" },
  "glm-5.3-flash": { supportedLevels: ["low", "high", "max"], defaultLevel: "max" },
  "kimi-k3": { supportedLevels: ["low", "high", "max"], defaultLevel: "max" },
};

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（与 `exposedIds()` 同形），故直接查表。
 * 只返回表里**有值**的字段；**查不到返回 undefined**（不编造）。
 * `effort` 也走这条通道（官方文档给的档位 = 渠道规格，不是上游运行时声明）。
 */
export function modelSpec(modelId: string):
  | {
      contextWindow?: number;
      maxOutputTokens?: number;
      effort?: { supportedLevels: string[]; defaultLevel: string };
    }
  | undefined {
  const key = modelId.toLowerCase();
  const spec = MODEL_SPECS[key];
  const effort = MODEL_EFFORTS[key];
  if (!spec && !effort) return undefined;
  return {
    ...(spec?.contextWindow === undefined ? {} : { contextWindow: spec.contextWindow }),
    ...(spec?.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
    ...(effort === undefined ? {} : { effort }),
  };
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
