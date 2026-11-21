/**
 * CatPaw 模型目录：上游模型表解析、缓存与首启种子（对外 id = 上游 id，不做短名映射）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/catpaw/PROTOCOL.md）：
 *   - 图片能力照上游逐模型声明（`supportImage`）：conversation 协议把图片作为
 *     `content[]` 的 `image_url` 分片传上去（先转存到自家对象存储换公网 URL）。
 *   - 上下文窗口取上游逐型号声明的最大档，未声明的型号回落渠道默认档（见 DEFAULT_CONTEXT_WINDOW）。
 *   - 目录未登录/不可达时走兜底表；exposedIds/resolveModel 必须同步返回。
 */

import { canonicalModelId, ensureChannelModels, hiddenModelIds, readCatalogCache, writeCatalogCache } from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

/** 一条模型目录条目。 */
export interface CatalogEntry {
  /** 对外暴露的 id（= 上游 id）。 */
  id: string;
  /** 展示名（上游 displayName / name）。 */
  name: string;
  /** 上游 modelType（数值，turn 请求必填）。 */
  modelType: number;
  /** 是否支持推理。 */
  reasoning: boolean;
  /** 上下文窗口。 */
  contextWindow: number;
  /** 最大输出 token（上游不下发，按公开规格补；数据在 models.json，见 `maxOutputOf`）。 */
  maxOutput?: number;
  /** 描述。 */
  description: string;
  /**
   * 是否支持图片输入（照上游 `supportImage` 声明）。
   *
   * `supportImage` 是上游**逐型号**给的布尔：`deepseek-v4.1-flash` / `LongCat-2.5` /
   * `glm-5.3-flash` 为 true，`deepseek-v4-pro` / `glm-5.3` / `auto` 为 false
   * （2026-11-16 真机实测上游原文）。请求侧的守卫按它决定「本型号收不收图」。
   */
  supportsImages: boolean;
  /** 上游原值（旧缓存里可能没有：那时被钉死成 false，恢复真值要一次 `--refresh`）。 */
  supportImage?: boolean;
  /** 消耗倍率（上游 `extendedInfo.rateMultiplier`）；null = 上游未提供。 */
  multiplier: number | null;
  /** 营销角标文案（上游 `extendedInfo.marketingCopy`，如「限时免费」「新」）。 */
  marketing: string;
  /**
   * 上游声明的思考强度档位（`parameterDefinitions[id=effort]`）。
   * 用 `thinking` 开关（无 effort）的型号没有该字段。
   */
  effort?: { supportedLevels: string[]; defaultLevel: string };
}

/**
 * 渠道默认上下文档位。
 *
 * 上下文档位是**请求参数**（body 的 `requestContext.modelParams.declarativeParams.context`），
 * 但上游 `/model-types` 的 `parameterDefinitions[id=context]` **逐型号声明了可选档位**
 * （各型号的上限实测于 2026-10-23，值见 docs/channels/catpaw/PROTOCOL.md；
 * 上游改档位表后需重测）。
 * 对外报**该型号的最大档**（能力上限）；上游没声明的型号（如 `auto`）才回落到本默认档。
 */
export const DEFAULT_CONTEXT_WINDOW = 1_024_000;

/** 补全 contextWindow：目录值 > 0 用之；否则按渠道默认档位（1M）补。 */
function contextWindowOfId(parsed: number): number {
  if (parsed > 0) return parsed;
  return DEFAULT_CONTEXT_WINDOW;
}

/** 上游 `parameterDefinitions` 里的一条参数定义（只取用到的字段）。 */
interface ParamDef {
  id: string;
  type: string;
  defaultValue?: string;
  values?: { value: string; displayName?: string }[];
}

/** 解析上游 `parameterDefinitions`（形状不对返回空数组）。 */
function parameterDefinitionsOf(row: Record<string, unknown>): ParamDef[] {
  const raw = row["parameterDefinitions"];
  if (!Array.isArray(raw)) return [];
  const out: ParamDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["id"] !== "string") continue;
    const values = Array.isArray(rec["values"])
      ? rec["values"]
          .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
          .map((v) => ({
            value: String(v["value"] ?? ""),
            displayName: typeof v["displayName"] === "string" ? v["displayName"] : undefined,
          }))
      : undefined;
    out.push({
      id: rec["id"],
      type: typeof rec["type"] === "string" ? rec["type"] : "",
      defaultValue: typeof rec["defaultValue"] === "string" ? rec["defaultValue"] : undefined,
      values,
    });
  }
  return out;
}

/**
 * 上游声明的**上下文档位最大值**（`id:"context"` 的 ENUM 档位取 max）。
 * 取不到返回 0（= 未声明，走渠道默认档）。
 */
function declaredContextWindow(row: Record<string, unknown>): number {
  for (const def of parameterDefinitionsOf(row)) {
    if (def.id !== "context" || !def.values) continue;
    let max = 0;
    for (const v of def.values) {
      const n = Number(v.value);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }
  return 0;
}

/**
 * 上游声明的**思考强度档位**（`id:"effort"`）→ 池层 `effort` 形状。
 * 用 `thinking` 开关（无 effort）的型号返回 undefined。
 */
function declaredEffort(
  row: Record<string, unknown>,
): { supportedLevels: string[]; defaultLevel: string } | undefined {
  for (const def of parameterDefinitionsOf(row)) {
    if (def.id !== "effort" || !def.values || def.values.length === 0) continue;
    const supportedLevels = def.values.map((v) => v.value);
    const preferred = def.defaultValue && supportedLevels.includes(def.defaultValue) ? def.defaultValue : supportedLevels[supportedLevels.length - 1]!;
    return { supportedLevels, defaultLevel: preferred };
  }
  return undefined;
}

/** 取已知最大输出（按 id 小写匹配；查不到返回 undefined）。规格是数据，落在 models.json。 */
function maxOutputOf(id: string): number | undefined {
  return seedTable().find((e) => e.id.toLowerCase() === id.toLowerCase())?.maxOutput;
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * 上下文：上游目录不下发，渠道按默认档位 1M 请求（见 `DEFAULT_CONTEXT_WINDOW`）；
 * 最大输出：按公开规格（数据在 models.json，经 `maxOutputOf` 查）。**查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = maxOutputOf(modelId);
  if (maxOutputTokens === undefined) return undefined;
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens };
}

/** 上游目录缓存（由 upstream.fetchModels() 成功时回填）。 */
let _remote: CatalogEntry[] | null = null;
let cacheLoaded = false;

/** 回填上游模型目录（由 upstream.fetchModels 成功后调用），并落盘。 */
export function setCatalog(entries: CatalogEntry[]): void {
  _remote = entries.length > 0 ? entries : null;
  cacheLoaded = true;
  if (entries.length > 0) writeCatalogCache(entries);
}

/**
 * 首次使用时把**磁盘缓存**（`cache/models.json`）读进来。
 *
 * 惰性而非模块加载时读：`channelFile()` 依赖渠道已注册（`setChannel`），
 * 而 `channel.ts` 是在 import 本模块**之后**才注册的 —— 模块加载时读会抛错。
 */
function ensureCachedModels(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const cached = readCatalogCache<CatalogEntry>();
    // 旧缓存没有 maxOutput（那是后来按公开规格补的）—— 读时补上，不必等一次刷新。
    if (cached) {
      const entries = cached.map((entry) => {
        // 旧缓存里的 `supportsImages` 是「本渠道不传图」那阵钉死的 false，且没有
        // 上游原值可依据 —— 只能继续按 false 处理，真值等一次 `mx model catpaw --refresh`。
        const patched = {
          ...entry,
          supportsImages: entry.supportImage === true,
        };
        if (patched.maxOutput !== undefined) return patched;
        const maxOutput = maxOutputOf(patched.id);
        return maxOutput === undefined ? patched : { ...patched, maxOutput };
      });
      // 顺带落盘：池层直接读磁盘缓存（`pool-targets.ts` 的 `getPoolModelMeta`）——
      // 不修盘的话池层还会看到旧值，对外误报能吃图。
      if (entries.some((entry, i) => entry !== cached[i])) writeCatalogCache(entries);
      _remote = entries;
    }
  } catch {
    /* 读不到就回落兜底表 */
  }
}

/**
 * 当前目录（上游缓存优先，缺则读用户目录的模型表 `channels/catpaw/models.json`；
 * 表不存在时用随包种子浇种（`ensureChannelModels`）。
 */
function loadCatalog(): CatalogEntry[] {
  ensureCachedModels();
  if (_remote && _remote.length > 0) return [..._remote];
  return fallbackEntries();
}

/** 兜底条目：数据以用户目录文件为准，代码内种子只作首次浇种源。 */
let seeded: CatalogEntry[] | null = null;
function fallbackEntries(): CatalogEntry[] {
  return seedTable();
}

/** 用户目录模型表（首启由随包 models.json 浇种）。 */
let seedCache: CatalogEntry[] | undefined;
function seedTable(): CatalogEntry[] {
  if (!seedCache) {
    seedCache =
      ensureChannelModels<CatalogEntry>(undefined, [
        bundledSnapshotPath(),
        packageSnapshotPath(import.meta.url),
      ]) ?? [];
  }
  return seedCache.map((e) => ({ ...e }));
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 解析与落盘已在 `upstream.fetchModels()` 里完成（它调 `setCatalog()`），
 * 这里只负责「要一次真实的拉取，并且失败要抛出去」。
 */
export async function refresh(): Promise<void> {
  // 动态 import：避免 catalog <-> upstream/cred 的静态环
  const [upstream, cred] = await Promise.all([import("./upstream.js"), import("./cred.js")]);
  const c = cred.load();
  const data = await upstream.fetchModels(c);
  const models = data["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("upstream returned an empty model catalog");
  }
}

/**
 * 解析上游行里的 `extendedInfo`：`rateMultiplier` 是倍率（字符串数字），
 * `marketingCopy` 是「限时免费 / 新」这类角标。缺失时倍率 null、角标空串。
 */
function parseExtendedInfo(row: Record<string, unknown>): {
  multiplier: number | null;
  marketing: string;
} {
  const ext = row["extendedInfo"];
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) {
    return { multiplier: null, marketing: "" };
  }
  const rec = ext as Record<string, unknown>;
  const raw = rec["rateMultiplier"];
  let multiplier: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    multiplier = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) multiplier = parsed;
  }
  const marketing = typeof rec["marketingCopy"] === "string" ? rec["marketingCopy"] : "";
  return { multiplier, marketing };
}

/**
 * 归一化上游模型行（字段名有多种历史写法，见 docs/channels/catpaw/PROTOCOL.md）。
 * 供 upstream.fetchModels 调用。
 */
export function toModelInfo(row: Record<string, unknown>): CatalogEntry | null {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const v = row[key];
      if (typeof v === "string" && v !== "") return v;
    }
    return "";
  };
  const id = pick("id", "modelId", "modelTypeName");
  if (!id) return null;
  // 「自动选择」入口与用户自建模型不是真实上游模型（Agent2Providers catalog.rs 同口径）：
  // isAuto 条目没有 rateMultiplier/parameterDefinitions，USER_CUSTOM 依赖客户端本地 apiKey。
  const ext = row["extendedInfo"];
  const isAuto = ext && typeof ext === "object" && !Array.isArray(ext)
    ? (ext as Record<string, unknown>)["isAuto"] === true || (ext as Record<string, unknown>)["isAuto"] === "true"
    : false;
  if (isAuto || row["provider"] === "USER_CUSTOM") return null;
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const v = row[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  const modelType = num("modelType", "modelTypeId");
  if (modelType <= 0) return null;
  const effort = declaredEffort(row);
  const entry: CatalogEntry = {
    id,
    name: pick("displayName", "name") || id,
    modelType,
    reasoning:
      row["reasoning"] === true ||
      Array.isArray(row["parameterDefinitions"]) ||
      row["supportsReasoning"] === true,
    // 上游逐型号声明的上下文档位最大值优先；没有才看旧字段，再没有走渠道默认档
    contextWindow: contextWindowOfId(
      declaredContextWindow(row) || num("contextWindow", "maxContextLength"),
    ),
    description: pick("description"),
    // 图片能力照上游逐型号声明走（请求侧守卫与转存链见 `upstream.ts`）。
    supportsImages: row["supportImage"] === true,
    ...(typeof row["supportImage"] === "boolean" ? { supportImage: row["supportImage"] } : {}),
    ...parseExtendedInfo(row),
    ...(effort ? { effort } : {}),
  };
  const maxOutput = maxOutputOf(id);
  if (maxOutput !== undefined) entry.maxOutput = maxOutput;
  return entry;
}

/** 对外隐藏的模型 id（数据是 `models.json` 的 `hidden` 标记；机制见共享层 `hiddenModelIds`）。 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url);
}

/**
 * 对外暴露的模型 ID 列表（`catalog` 内全部未隐藏的模型）。
 *
 * 目录（含缓存）照常保留 `hidden` 条目 —— 那是上游的事实；只是不进对外模型池，
 * 池层据此不再把本渠道列为该模型的候选。
 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  return loadCatalog()
    // 归一化口径一并判：池层会把尾饰变体归一进同一家族，只按原始 id 匹配会被绕过
    .filter((e) => !hidden.has(e.id.toLowerCase()) && !hidden.has(canonicalModelId(e.id)))
    .map((e) => e.id);
}

/**
 * 短名 → 上游模型 id（字符串，本渠道 id 即上游标识）。
 *
 * 大小写不敏感匹配；目录里没有就**原样返回**（与其余渠道一致）。
 * 本函数是纯映射，不承担「这个模型是否存在」的判定：抛错会穿透到 `attempt.ts`
 * （那里裸调无 catch）变成整条请求 500，而正确行为是交给注册表兜底，
 * 最终由调用方判「该渠道不提供这个模型」并换下一条候选。
 * `buildChatBody` 再做 id → modelType 数值转换。
 */
export function resolveModel(name: string): string {
  const folded = name.toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id === name || entry.name === name) return entry.id;
  }
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === folded || entry.name.toLowerCase() === folded) {
      return entry.id;
    }
  }
  return name;
}

/**
 * 某模型的上下文档位（上游目录不下发窗口 → 恒为渠道默认档位 1M）。
 *
 * 供 `upstream.ts` 组请求体用；取不到条目时也回落默认档位（与实际请求一致）。
 */
export function contextWindowOf(id: string): number {
  const wanted = id.toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === wanted) return contextWindowOfId(entry.contextWindow);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 模型 id → turn / round body 必需的**数字** modelType。
 *
 * 解析顺序：上游目录条目 → 用户目录模型表的 `modelType` → 抛错。
 *
 * 目录取不到时若表里没有该 id，兜底目录里的 modelType 只能是占位值，
 * 请求会被上游拒 —— 即「未登录 / 目录未拉取时全部模型不可用」。
 *
 * 注：目录条目的 modelType 恒 > 0（上游返回 0 的条目在 `toModelInfo` 就被丢弃）；
 * 兜底目录里表未覆盖的模型取 0（= auto，由上游自行选型）。
 */
/**
 * 该上游型号是否收图片（照 `supportImage` 声明）。
 *
 * 查不到条目按 **false** 处理：宁可拒图换一家，也不要把图丢掉后让模型答「看不到」。
 * 兜底表没有上游原值，所以未刷新目录时一律按 false —— 带图请求会顺延到别的渠道。
 */
export function supportsImageOf(upstreamModel: string): boolean {
  for (const entry of loadCatalog()) {
    if (entry.id === upstreamModel) return entry.supportsImages === true;
  }
  return false;
}

export function modelTypeOf(id: string): number {
  for (const entry of loadCatalog()) {
    if (entry.id === id) return entry.modelType;
  }
  const row = seedTable().find((e) => e.id.toLowerCase() === id.toLowerCase());
  if (row) return row.modelType;
  throw new Error(`unknown model id: ${id}`);
}