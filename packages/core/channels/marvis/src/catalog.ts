/**
 * Marvis 模型目录：**内置「省心组合」+ 用户自配的第三方 provider**。
 *
 * 关键约束（端点/字段/实测见 docs/channels/marvis/PROTOCOL.md）：
 *   - Marvis **自带模型**：默认组合「省心组合」（`homeSelectedModel = "default"`，
 *     前端常量 `cs = "default"` / 显示名 `Ll = "省心组合"`），按任务难度自动选模型，
 *     由服务端承载，用账号的 token 额度计费。
 *   - 用户自配的第三方 provider（`list_custom_llm_provider`）以 `custom:<id>` 前缀
 *     作 config_id；本目录把它们一并暴露。
 *   - 池模型名 = config_id；`resolveModel` 原样返回，网关按注册表判定供给。
 */

/** 默认组合（省心组合）的 config_id。 */
export const DEFAULT_MODEL_ID = "default";

/** 默认组合的展示名（前端常量 `Ll`）。 */
export const DEFAULT_MODEL_NAME = "省心组合";

/** 自定义模型前缀（前端常量 `Wp`）。 */
export const CUSTOM_MODEL_PREFIX = "custom:";

/** 第三方供应商条目。 */
export interface ProviderEntry {
  readonly id: string;
  readonly provider: string;
  readonly plans: Array<{ name: string; baseUrl: string }>;
}

/** 静态内置模型（省心组合）。 */
const BUILTIN: ReadonlyArray<{ id: string; name: string }> = [
  { id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME },
];

/**
 * 对外暴露的模型 id（同步契约）。
 *
 * 返回**池模型名** = Marvis 的 config_id：内置组合（`default`）恒在，
 * 自定义 provider 由调用方通过 `setDynamicIds` 注入（它们来自上游目录，
 * 同步阶段读不到）。
 */
let dynamicIds: string[] = [];

/** 由目录刷新流程注入动态模型（自定义 provider 的 config_id）。 */
export function setDynamicIds(ids: string[]): void {
  dynamicIds = ids.filter((id) => typeof id === "string" && id);
}

export function exposedIds(): string[] {
  return [...BUILTIN.map((m) => m.id), ...dynamicIds];
}

/** 池模型名 → 上游 model_config.config_id；表外原样返回（共享层判定「不供」）。 */
export function resolveModel(name: string): string {
  if (name === DEFAULT_MODEL_ID) return DEFAULT_MODEL_ID;
  if (name.startsWith(CUSTOM_MODEL_PREFIX)) return name;
  return name;
}

/** 展示名（`mx marvis models` 用）。 */
export function displayName(id: string): string {
  const hit = BUILTIN.find((m) => m.id === id);
  return hit ? hit.name : id;
}

/**
 * 模型规格：不提供。
 *
 * 上游不公布窗口 / 输出上限 / 倍率；不编造数字（客户端会按它算钱）。
 */
export function modelSpec(_modelId: string): undefined {
  void _modelId;
  return undefined;
}

/** 从上游响应里解析第三方供应商（供 CLI 展示与动态 id 注入）。 */
export function parseProviders(rows: Record<string, unknown>[]): ProviderEntry[] {
  const out: ProviderEntry[] = [];
  for (const row of rows) {
    const id = String(row["id"] ?? "");
    const provider = String(row["provider"] ?? "");
    if (!id || !provider) continue;
    const plansRaw = row["plans"];
    const plans: Array<{ name: string; baseUrl: string }> = [];
    if (Array.isArray(plansRaw)) {
      for (const p of plansRaw) {
        if (!p || typeof p !== "object") continue;
        const plan = p as Record<string, unknown>;
        const name = String(plan["name"] ?? "");
        const baseUrl = String(plan["base_url"] ?? "");
        const models = plan["models"];
        // 每个 plan 下的模型，以 custom:<id> 暴露
        if (Array.isArray(models)) {
          for (const m of models) {
            if (!m || typeof m !== "object") continue;
            const mid = String((m as Record<string, unknown>)["model_id"] ?? "");
            if (mid) dynamicIds.push(`${CUSTOM_MODEL_PREFIX}${mid}`);
          }
        }
        if (name && baseUrl) plans.push({ name, baseUrl });
      }
    }
    out.push({ id, provider, plans });
  }
  return out;
}
