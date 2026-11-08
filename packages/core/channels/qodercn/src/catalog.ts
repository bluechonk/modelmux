/**
 * Qoder 模型目录：动态拉取（COSY 签名）+ 磁盘缓存 + 内置兜底表。
 *
 * 关键约束（端点/字段/实测见 docs/channels/qodercn/PROTOCOL.md）：
 *   - 对外名 ≠ 上游 key：模型 id 是短 key，需映射到对外名，其余用上游展示名归一化。
 *   - 上游目录全量进目录，但**对外暴露哪些**由 `models.json` 的 `hidden` 标记决定
 *     （本渠道只暴露 glm-5.3-flash，deepseek 系一律隐藏）。
 *   - 目录按 动态 → 磁盘缓存 → 内置兜底 三源优先级解析；缓存保证未登录/上游不可达时仍能列出模型。
 */

import {
  canonicalModelId,
  ensureChannelModels,
  hiddenModelIds,
  readCatalogCache,
  writeCatalogCache,
} from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

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
  /** 最大输出 token（上游不下发，按用户目录模型表补；见 `models.json`）。 */
  maxOutput?: number;
  /** 对外隐藏（数据在 `models.json`）：目录里保留，但不进对外模型池。 */
  hidden?: boolean;
}

/**
 * 随包快照候选路径（隐藏策略的兜底来源，见 `hiddenIds`）。
 *
 * **必须懒算**：`bundledSnapshotPath()` 依赖渠道上下文（`activeCid()`），
 * 模块加载期还没有上下文 —— 写成常量会永远拿到 `null`（bundle 布局下连
 * `packageSnapshotPath` 也找不到包根，因为模块 url 指向 bundle 本身）。
 */
function seedPaths(): Array<string | null> {
  return [bundledSnapshotPath(), packageSnapshotPath(import.meta.url)];
}

/**
 * 对外隐藏的模型（数据是 `models.json` 的 `hidden` 标记；并集 / 失败关闭等机制见共享层
 * `hiddenModelIds`）。收 **id 与上游 key** 两种写法：对外 id 由展示名派生，上游改名不该让策略失效。
 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url, ["key"]);
}

/**
 * 按 id 查用户目录模型表里的最大输出。
 *
 * 规格**是数据**，落在 `models.json` 的 `maxOutputTokens`；本函数只做查表，
 * 查不到返回 `undefined`（不编造 —— 公开规格见 `docs/channels/qoder/PROTOCOL.md` §8）。
 */
function specOf(modelId: string): { maxOutputTokens?: number } | undefined {
  const k = modelId.toLowerCase();
  const row = ensureChannelModels<ModelEntry>(undefined, seedPaths())?.find(
    (e) => e.id.toLowerCase() === k,
  );
  return row?.maxOutput === undefined ? undefined : { maxOutputTokens: row.maxOutput };
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（与 `exposedIds()` 同形），故直接查表。
 * **查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = specOf(modelId)?.maxOutputTokens;
  if (maxOutputTokens === undefined) return undefined;
  return { maxOutputTokens };
}

/**
 * 上游 key → 池内 id 的**已知映射**。
 *
 * 只列「上游 key 与展示名对不上」的条目（如 `gfmodel` → `glm-5.3-flash`）；
 * 未列出的 key 用上游展示名归一化后作为对外 id（见 `toEntry`）。
 *
 * 这是 **key → id 的映射**，不是曝光白名单：上游目录里的模型都会进目录，
 * 对外暴露哪些由 `models.json` 的 `hidden` 标记决定（见 `hiddenIds`）。
 */
const POOL_KEY_MAP: Record<string, string> = {
  gfmodel: "glm-5.3-flash",
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
 * 上游形态（实测见 docs/channels/qodercn/PROTOCOL.md）：档位是**对象 map**，
 * 默认档由 `is_default` 标出；与 qoder 同一套字段。
 *
 * 必须在**落盘前**归一：池层（`getPoolModelMeta`）直接读这份磁盘缓存，
 * 只认 `effort: {supportedLevels, defaultLevel}` 这一种形态。
 *
 * `disabled` **不映射**成 `off` 档：那会让客户端发出 `reasoning_effort: "off"`，
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
 * **所有**目录条目都保留（已知 key 走 `POOL_KEY_MAP` 的显式映射，其余用展示名归一化作为
 * 对外 id，无展示名时退回 key 本身）—— 是不是对外暴露由 `hiddenIds()` 事后过滤。
 */
function toEntry(raw: Record<string, unknown>): ModelEntry | null {
  const key = str(raw["key"]) || str(raw["id"]);
  if (!key) return null;
  const displayName = str(raw["display_name"]) || str(raw["name"]) || key;
  // `POOL_KEY_MAP` 是普通对象，`??` 会走原型链：上游 key 写成 `constructor` /
  // `__proto__` 时 `id` 变成函数或对象，随后 `exposedIds()` 里的 `entry.id.toLowerCase()`
  // 抛 TypeError，被池层 catch 接住 → **整条渠道目录**当作空列表，该渠道所有模型
  // 一起消失（不是单个模型名异常）。这里只认自有键。
  const id = Object.hasOwn(POOL_KEY_MAP, key) ? POOL_KEY_MAP[key]! : toPublicId(displayName, key);
  // 用户目录表优先；缓存行里已带 maxOutput 的（刷新时写入的）也认。
  const spec = specOf(id)?.maxOutputTokens;
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
  // 兜底走用户目录模型表（首启由随包 models.json 浇种）：条目已是归一化产物，直接读
  return ensureChannelModels<ModelEntry>(undefined, seedPaths()) ?? [];
}

/** 对外暴露的模型 id（池内名；去重、保持目录顺序；`hidden` 的不暴露）。 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loadCatalog()) {
    // 三种写法都判：id（小写）、上游 key、归一化规范名 —— 池层会把
    // `GLM-5.3-Flash-Official` 这类尾饰变体归一进同一家族，只按原始 id 匹配会被绕过
    if (hidden.has(entry.id.toLowerCase())) continue;
    if (hidden.has(entry.key.toLowerCase())) continue;
    if (hidden.has(canonicalModelId(entry.id))) continue;
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
 * 与 `entryOf()` 的区别：`entryOf()` 按**对外 id** 查（池内视图），
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
  return undefined;
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
      const id = Object.hasOwn(POOL_KEY_MAP, key) ? POOL_KEY_MAP[key]! : toPublicId(displayName, key);
      // 原始字段全留（不裁剪），另附**按用户目录表补的**最大输出（上游不下发），
      // 以及归一后的思考档位（池层读的是这份缓存，只认 `effort` 那一种形态）。
      const spec = specOf(id)?.maxOutputTokens;
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
