/**
 * Qoder 模型目录：动态拉取（COSY 签名）+ 磁盘缓存 + 内置兜底表。
 *
 * 关键约束（端点/字段/实测见 docs/channels/qoder/PROTOCOL.md）：
 *   - 对外名 ≠ 上游 key：模型 id 是短 key，需映射到对外名，其余用上游展示名归一化。
 *   - 上游目录全量对外暴露，不按家族过滤。
 *   - 目录按 动态 → 磁盘缓存 → 内置兜底 三源优先级解析；缓存保证未登录/上游不可达时仍能列出模型。
 */

import { readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 一条模型条目（本渠道内部形态）。 */
interface ModelEntry {
  /** 上游 key（`x-model-key` / 请求体 `model_config.key` 用它）。 */
  key: string;
  /** 对外 id（池内名）。 */
  id: string;
  displayName: string;
  isReasoning: boolean;
  isVl: boolean;
  maxInputTokens: number;
  /** 最大输出 token（上游不下发，按公开规格补；见 `MAX_OUTPUTS`）。 */
  maxOutput?: number;
}

/**
 * 已知模型的**最大输出 token**（上游目录不下发，按公开规格补）。
 *
 * ⚠ 只列**真实模型**：`auto` / `efficient` / `ultimate` 等是平台的**策略档位**
 * （按账号档位路由到不同底层模型），没有单一规格，故不列。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回 400）—— 客户端应能降档重试。
 * 数值与来源见 `docs/MODEL-SPECS.md`（唯一事实源；渠道表在本文件的 `MAX_OUTPUTS`）。
 */
const MAX_OUTPUTS: Readonly<Record<string, number>> = {
  "deepseek-flash": 393_216,
  "deepseek-v4-pro": 393_216,
  "glm-5.3": 131_072,
  "glm-5.3-flash": 131_072,
  "kimi-k3": 1_048_576,
  "minimax-m3": 131_072,
  "minimax-m3.1-flash": 524_288,
  "qwen3.7-max": 131_072,
  "qwen3.7-plus": 131_072,
  "qwen3.8-flash": 131_072,
  "qwen3.8-max": 131_072,
};

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（与 `exposedIds()` 同形），故直接查表。
 * **查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = MAX_OUTPUTS[modelId.toLowerCase()];
  if (maxOutputTokens === undefined) return undefined;
  return { maxOutputTokens };
}

/**
 * 上游 key → 池内 id 的**已知映射**。
 *
 * 只列「上游 key 与展示名对不上」的条目（如 `gfmodel` → `glm-5.3-flash`）；
 * 未列出的 key 用上游展示名归一化后作为对外 id（见 `toEntry`）。
 *
 * 全模型池：不再把非映射条目标在池外 —— 上游目录里的模型都会暴露。
 */
const POOL_KEY_MAP: Record<string, string> = {
  gfmodel: "glm-5.3-flash",
};

/** 兜底表：连磁盘缓存都没有时用（元数据取自官方目录快照）。 */
const FALLBACK: ModelEntry[] = [
  {
    key: "gfmodel",
    id: "glm-5.3-flash",
    displayName: "GLM-5.3-Flash",
    isReasoning: true,
    isVl: true,
    maxInputTokens: 1_000_000,
  },
];

/**
 * 上游 key → 模型元数据的**静态兜底表**（请求体的 `model_config` 用）。
 *
 * 取自本机动态目录快照（`~/.modelmux/qoder/cache/models.json`），
 * 字段集与参考实现的官方目录快照
 * （解密自官方客户端 `catalog-v6`）同构 `[参考]`。
 *
 * ⚠ **只作兜底**：快照会随上游演进而脱节 —— 动态目录
 * （`GET /algo/api/v2/model/list?Encode=1`，即官方「此刻」的目录）里有就以动态为准。
 * ⚠ `max_input_tokens` 与目录的 `context_config` 档位表**经常矛盾**（官方客户端
 * 只认档位表）；这里取 `max_input_tokens` 是因为上游请求体用它
 * （参考实现 `qoder2api-hub/qoder_proxy.py:3925`）。
 */
const STATIC_META: Record<string, upstream.ModelMeta> = {
  auto: { displayName: "Auto", isVl: true, isReasoning: false, maxInputTokens: 200_000 },
  ultimate: { displayName: "Ultimate", isVl: true, isReasoning: true, maxInputTokens: 1_000_000 },
  performance: { displayName: "Performance", isVl: true, isReasoning: false, maxInputTokens: 1_000_000 },
  efficient: { displayName: "Efficient", isVl: true, isReasoning: false, maxInputTokens: 200_000 },
  smodel: { displayName: "Sonus", isVl: true, isReasoning: true, maxInputTokens: 180_000 },
  cmodel: { displayName: "Cantus", isVl: true, isReasoning: true, maxInputTokens: 180_000 },
  qmodel_38max: { displayName: "Qwen3.8-Max", isVl: true, isReasoning: true, maxInputTokens: 180_000 },
  qfmodel: { displayName: "Qwen3.8-Flash", isVl: true, isReasoning: true, maxInputTokens: 180_000 },
  qmodel_latest: { displayName: "Qwen3.7-Max", isVl: true, isReasoning: false, maxInputTokens: 1_000_000 },
  qmodel: { displayName: "Qwen3.7-Plus", isVl: true, isReasoning: false, maxInputTokens: 1_000_000 },
  kmodel_latest: { displayName: "Kimi-K3", isVl: true, isReasoning: false, maxInputTokens: 180_000 },
  // 快照里 `kmodel` 的 max_input_tokens 为空 → 参考实现回落 180000
  kmodel: { displayName: "Kimi-K2.8-Preview", isVl: true, isReasoning: false, maxInputTokens: 180_000 },
  gmodel: { displayName: "GLM-5.3", isVl: true, isReasoning: true, maxInputTokens: 180_000 },
  gfmodel: { displayName: "GLM-5.3-Flash", isVl: true, isReasoning: true, maxInputTokens: 1_000_000 },
  dmodel: { displayName: "DeepSeek-V4-Pro", isVl: true, isReasoning: true, maxInputTokens: 1_000_000 },
  dfmodel: { displayName: "DeepSeek-Flash", isVl: true, isReasoning: true, maxInputTokens: 1_000_000 },
  mmodel: { displayName: "MiniMax-M3.1-Flash", isVl: true, isReasoning: false, maxInputTokens: 180_000 },
};

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 非数组对象取出来（否则 null）；用于安全地下钻上游嵌套字段。 */
function objOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 归一后的思考档位（与共享层 `PoolModelMeta.effort` 同形）。 */
type Effort = { supportedLevels: string[]; defaultLevel: string };

/** 目录缓存条目：运行期带着上游原始字段，类型上只保证 `id`（见共享层 `catalog-cache.ts`）。 */
type CacheRow = Record<string, unknown> & { id: string };

/**
 * 上游 `thinking_config` → 归一档位（`{supportedLevels[], defaultLevel}`）。
 *
 * 上游形态（实测见 docs/channels/qoder/PROTOCOL.md）：档位是**对象 map**，
 * 默认档由 `is_default` 标出 ——
 * `{"enabled":{"efforts":{"high":{"is_default":true},"low":{},...}},"disabled":{...}}`。
 *
 * ⚠ 必须在**落盘前**归一：池层（`getPoolModelMeta`）直接读这份磁盘缓存，
 * 只认 `effort: {supportedLevels, defaultLevel}` 这一种形态。
 *
 * ⚠ `disabled` **不映射**成 `off` 档：那会让客户端发出 `reasoning_effort: "off"`，
 * 而上游关闭思考走的是另一套字段（不是档位取值）。只在文档里记录它存在。
 */
function wireEffort(raw: Record<string, unknown>): Effort | undefined {
  const enabled = objOf(objOf(raw["thinking_config"])?.["enabled"]);
  const efforts = objOf(enabled?.["efforts"]);
  if (!efforts) return undefined;
  const levels = Object.keys(efforts);
  if (levels.length === 0) return undefined;
  return {
    supportedLevels: levels,
    defaultLevel: levels.find((level) => objOf(efforts[level])?.["is_default"] === true) ?? "",
  };
}

/** 缓存条目补齐 `effort`（已有则原样返回，便于调用方判断是否需要回写）。 */
function withEffort(row: CacheRow): CacheRow {
  if (row["effort"] !== undefined) return row;
  const effort = wireEffort(row);
  return effort === undefined ? row : { ...row, effort };
}

/** 展示名 → 对外 id（小写、空格与下划线转连字符）。 */
function toPublicId(displayName: string, key: string): string {
  const base = displayName.trim() || key;
  return base.toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * 官方目录条目 → 内部条目。
 *
 * 全模型池：**所有**目录条目都保留 —— 已知 key 走 `POOL_KEY_MAP` 的显式映射，
 * 其余用展示名归一化作为对外 id（无展示名时退回 key 本身）。
 */
function toEntry(raw: Record<string, unknown>): ModelEntry | null {
  const key = str(raw["key"]) || str(raw["id"]);
  if (!key) return null;
  const displayName = str(raw["display_name"]) || str(raw["name"]) || key;
  const id = POOL_KEY_MAP[key] ?? toPublicId(displayName, key);
  // 规格表优先；缓存行里已带 maxOutput 的（刷新时写入的）也认。
  const spec = MAX_OUTPUTS[id.toLowerCase()];
  const cached = num(raw["maxOutput"], 0);
  const maxOutput = spec ?? (cached > 0 ? cached : undefined);
  return {
    key,
    id,
    displayName,
    isReasoning: raw["is_reasoning"] === true,
    isVl: raw["is_vl"] === true,
    maxInputTokens: num(raw["max_input_tokens"], 180_000),
    ...(maxOutput === undefined ? {} : { maxOutput }),
  };
}

/** 读目录：磁盘缓存优先，缓存缺失/为空时退回内置表。 */
function loadCatalog(): ModelEntry[] {
  try {
    // 缓存条目运行期带着渠道自己的字段（key / display_name…），类型上只保证 `id`
    const cached = readCatalogCache();
    if (cached && cached.length > 0) {
      // 旧缓存里的 `effort` 可能还没归一（本字段是后加的）—— 读时补上并回写，
      // 不必等一次刷新：池层直接读这份缓存，不补的话 `/v1/models` 里这些型号的
      // 思考档位会一直是空的，而上游其实早就下发了。
      const rows = cached.map((item) => withEffort(item as unknown as CacheRow));
      if (rows.some((row, i) => row !== cached[i])) writeCatalogCache(rows);
      const mapped = rows
        .map((item) => toEntry(item))
        .filter((entry): entry is ModelEntry => entry !== null);
      if (mapped.length > 0) return mapped;
    }
  } catch {
    /* 缓存读不出来就用兜底表 —— 目录不可用不该让整个渠道消失 */
  }
  return [...FALLBACK];
}

/** 对外暴露的模型 id（池内名；去重、保持目录顺序）。 */
export function exposedIds(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loadCatalog()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}

/** 按对外 id 取完整条目（供 upstream 填 `model_config` 元数据）。 */
function entryOf(name: string): ModelEntry | null {
  const wanted = name.toLowerCase();
  return loadCatalog().find((entry) => entry.id.toLowerCase() === wanted) ?? null;
}

/**
 * 按**上游 key** 取模型元数据（请求体的 `model_config` 用）。
 *
 * ⚠ 与 `entryOf()` 的区别：`entryOf()` 按**对外 id** 查（池内视图），
 * 这里按**上游 key** 查 —— `upstream.buildChatBody` 只拿到 key。
 *
 * 优先级：动态目录（磁盘缓存，来自上游 `model/list`）→ 静态兜底表（官方目录快照）。
 */
export function metaOfKey(key: string): upstream.ModelMeta | undefined {
  const wanted = key.trim().toLowerCase();
  if (!wanted) return undefined;
  for (const entry of loadCatalog()) {
    if (entry.key.toLowerCase() !== wanted) continue;
    return {
      displayName: entry.displayName,
      isVl: entry.isVl,
      isReasoning: entry.isReasoning,
      maxInputTokens: entry.maxInputTokens,
    };
  }
  return STATIC_META[wanted];
}

/**
 * 对外 id（或上游 key）→ 上游 key。
 *
 * 三种输入都认：池内名（`glm-5.3-flash`）、上游 key（`gfmodel`）、
 * 上游展示名（`GLM-5.3-Flash`）—— 排查时手写哪种都能通。未命中则原样返回。
 */
export function resolveModel(name: string): string {
  const wanted = name.toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === wanted) return entry.key;
    if (entry.key.toLowerCase() === wanted) return entry.key;
    if (entry.displayName.toLowerCase() === wanted) return entry.key;
  }
  return name;
}

/**
 * 强制从上游重拉目录并落盘（CLI 的 `--refresh` 用；失败**抛错**）。
 *
 * 上游返回 `payload.chat[]`，每条以 `key` 为模型 id。落盘走共享的目录缓存
 * （`<root>/qoder/cache/models.json`），**不裁剪字段** —— 以后要放宽池策略时
 * 不必重新拉。
 */
export async function refresh(): Promise<void> {
  const credential = cred.load();
  const payload = await upstream.fetchModels(credential);
  const chat = Array.isArray(payload["chat"]) ? (payload["chat"] as unknown[]) : [];
  const entries = chat
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const key = str(item["key"]);
      const displayName = str(item["display_name"]) || str(item["name"]) || key;
      const id = POOL_KEY_MAP[key] ?? toPublicId(displayName, key);
      // 原始字段全留（不裁剪），另附**按公开规格补的**最大输出（上游不下发），
      // 以及归一后的思考档位（池层读的是这份缓存，只认 `effort` 那一种形态）。
      const spec = MAX_OUTPUTS[id.toLowerCase()];
      const effort = wireEffort(item);
      return {
        ...item,
        id: key,
        ...(spec === undefined ? {} : { maxOutput: spec }),
        ...(effort === undefined ? {} : { effort }),
      };
    })
    .filter((item) => str(item["id"]) !== "");
  if (entries.length === 0) throw new Error("upstream model list is empty");
  writeCatalogCache(entries);
}
