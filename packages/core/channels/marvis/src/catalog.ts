/**
 * Marvis 模型目录：**没有自带模型**。
 *
 * 关键约束（端点/字段/实测见 docs/marvis/PROTOCOL.md §14.5）：
 *   - `list_custom_llm_provider` 返回的是用户自配的第三方 OpenAI 兼容端点
 *     （腾讯云 / DeepSeek / 阿里云 / MiniMax / Kimi / 智谱），不是 Marvis 的额度。
 *   - 因此本目录**不对外暴露任何池模型** —— 池模型是网关的对外契约，
 *     把第三方端点当成 Marvis 的模型会误导选路与计费。
 *   - 供应商清单只作展示（`mx marvis` 可见），不进模型池。
 */

/** 第三方供应商条目。 */
export interface ProviderEntry {
  readonly id: string;
  readonly provider: string;
  readonly plans: Array<{ name: string; baseUrl: string }>;
}

/** 对外暴露的池模型：**空**（Marvis 不提供模型）。 */
export function exposedIds(): string[] {
  return [];
}

/** 池模型 → 上游模型：表为空，一律原样返回（共享层判定「本渠道不供」）。 */
export function resolveModel(name: string): string {
  return name;
}

/**
 * 模型规格：不提供。
 *
 * 不编造窗口 / 倍率 —— 客户端会按它算钱，无源填数比不填更糟。
 */
export function modelSpec(_modelId: string): undefined {
  void _modelId;
  return undefined;
}

/** 从上游响应里解析供应商清单（供 CLI 展示）。 */
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
        if (name && baseUrl) plans.push({ name, baseUrl });
      }
    }
    out.push({ id, provider, plans });
  }
  return out;
}
