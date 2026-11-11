/**
 * Today 模型目录：池模型 → 上游模型选项 id（`model.<name>`）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/todayai/PROTOCOL.md）：
 *   - 上游模型选项是**账号级**的（`/v1/pricing/status` 按套餐给），
 *     但池内能暴露的只有家族表里的模型 —— 本表是「池模型 → 上游选项」的静态映射，
 *     上游选项增减时改这里（上游给的是 `model.<name>`，别名 `glm-5.3` → 池内 `glm-5.3-flash`）。
 *   - `resolveModel` 只认表内条目：表外的名字原样返回（共享层据此判定「本渠道不供」）。
 *   - 上游目录不带窗口与输出上限，故 `modelSpec` 整体省略 —— 池层拿不到就回落默认，
 *     不编造数字（编造会让客户端按假窗口算钱）。
 */

import { canonicalModelId } from "@modelmux/gateway";

/** 池模型 → 上游选项 id。上游 `model.<name>` 与池内裸名多数一致，`glm-5.3` 是别名。 */
const POOL_TO_OPTION: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "model.deepseek-v4.1-flash",
  "glm-5.3-flash": "model.glm-5.3",
};

/** 对外暴露的模型 id（顺序即展示顺序）。 */
export function exposedIds(): string[] {
  return Object.keys(POOL_TO_OPTION);
}

/** 池模型名 → 上游选项 id；表外原样返回（共享层判定「不供」）。 */
export function resolveModel(name: string): string {
  const key = canonicalModelId(name);
  return POOL_TO_OPTION[key] ?? name;
}

/** 上游选项 → 池模型名（`model.` 前缀剥掉）。 */
export function optionToPoolModel(optionId: string): string {
  return optionId.replace(/^model\./, "");
}

/**
 * 模型规格（供池层 `/v1/models` 透出）。
 *
 * 上游目录只有选项名与展示名，没有窗口 / 输出上限 / 倍率 —— 一律省略，
 * 让池层回落默认（见文件头说明）。
 */
export function modelSpec(
  _modelId: string,
): { contextWindow?: number; maxOutputTokens?: number; multiplier?: number } | undefined {
  void _modelId;
  return undefined;
}
