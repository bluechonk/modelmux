/**
 * CodeArts 模型目录：对外名 → 上游 id 映射 + 上游规格缓存。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codearts/PROTOCOL.md）：
 *   - **供给范围由统一模型注册表声明**（`packages/core/gateway/models.json` 的
 *     `channels.codearts` 段）；网关按注册表解析上游 id，本模块的映射必须与它一致。
 *   - 上游模型名单随套餐轮换（内置 + 限时福利两源），规格从 `fetchModels` 的发现结果
 *     取并落 `cache/models.json`；查不到就不填（不编造窗口 / 输出上限）。
 */

import { readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 对外 id → 上游模型 id（与注册表的 `channels.codearts` 段一致）。 */
const EXPOSED_TO_UPSTREAM: Readonly<Record<string, string>> = {
  "glm-5.3-flash": "glm-5.3-flash",
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
};

/** 对外暴露的模型 id（顺序即展示顺序）。 */
export function exposedIds(): string[] {
  return Object.keys(EXPOSED_TO_UPSTREAM);
}

/** 对外 id → 上游模型 id；未登记的名字原样返回（由上游判断是否存在）。 */
export function resolveModel(name: string): string {
  return EXPOSED_TO_UPSTREAM[name] ?? name;
}

/**
 * 强制从上游重拉目录并落盘（CLI 的 `--refresh` 用）。
 *
 * 失败**抛错**（与自动路径的「静默回落」相反）—— 用户显式要求刷新时必须知道成没成。
 */
export async function refresh(): Promise<void> {
  const c = cred.load();
  const { models } = (await upstream.fetchModels(c)) as { models: upstream.UpstreamModel[] };
  writeCatalogCache<upstream.UpstreamModel>(models);
}

/** 模型规格（窗口 / 输出上限）；查不到返回 `undefined`（不编造）。 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const rows = readCatalogCache<upstream.UpstreamModel>();
  const row = rows?.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  if (!row) return undefined;
  const out: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (row.contextWindow) out.contextWindow = row.contextWindow;
  if (row.maxTokens) out.maxOutputTokens = row.maxTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}
