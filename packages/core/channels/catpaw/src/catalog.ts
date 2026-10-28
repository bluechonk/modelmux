/**
 * CatPaw 模型目录：上游模型表解析、缓存与兜底表（对外 id = 上游 id，不做短名映射）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/catpaw/PROTOCOL.md）：
 *   - 图片能力恒不对外声明（supportsImages=false）：上游逐模型声明的是模型自身能力，
 *     本渠道 conversation 协议不传图片，照抄会对外误报能吃图。
 *   - 上下文窗口取上游逐型号声明的最大档，未声明的型号回落渠道默认档（见 DEFAULT_CONTEXT_WINDOW）。
 *   - 目录未登录/不可达时走兜底表；exposedIds/resolveModel 必须同步返回。
 */

import { readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

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
  /** 最大输出 token（上游不下发，按公开规格补；见 `MAX_OUTPUTS`）。 */
  maxOutput?: number;
  /** 描述。 */
  description: string;
  /**
   * 是否支持图片输入 —— **恒 false**。
   *
   * ⚠ 上游模型目录的 `supportImage` 是**模型自身**的能力声明，本渠道的 conversation
   * 协议没有图片传输路径（见文件头「图片能力」）；照抄上游会对外误报能吃图。
   */
  supportsImages: boolean;
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

/**
 * 已知模型的**最大输出 token**（上游目录不下发，按公开规格补）。
 *
 * ⚠ 上游 `/model-types` 不带输出上限（[实测]），网关 `/v1/models` 只能给兜底值 ——
 * 而 4096 的兜底会让客户端把每次回答截到 4k。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回 400）—— 客户端应能降档重试。
 * 数值与来源见 `docs/channels/catpaw/PROTOCOL.md` 的「最大输出 token」节（渠道表在本文件的 `MAX_OUTPUTS`）。
 */
const MAX_OUTPUTS: Readonly<Record<string, number>> = {
  "deepseek-v4-flash": 393_216,
  "deepseek-v4-pro": 393_216,
  "deepseek-v4.1-flash": 393_216,
  "glm-5.3": 131_072,
  "glm-5.3-flash": 131_072,
  "glm-5.3-flashx": 131_072,
  "kimi-k3": 1_048_576,
  "longcat-2.0": 262_144,
  "minimax-m3": 131_072,
};

/** 取已知最大输出（按 id 小写匹配；查不到返回 undefined）。 */
function maxOutputOf(id: string): number | undefined {
  return MAX_OUTPUTS[id.toLowerCase()];
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * 上下文：上游目录不下发，渠道按默认档位 1M 请求（见 `DEFAULT_CONTEXT_WINDOW`）；
 * 最大输出：按公开规格（见 `MAX_OUTPUTS`）。**查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = maxOutputOf(modelId);
  if (maxOutputTokens === undefined) return undefined;
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens };
}

/**
 * modelType 数值兜底表（上游目录不可用时用）。
 *
 * ⚠ 数值来源：参考实现 `reference/icebears111_catpaw2api/internal/upstream/const.go:83-90`
 *   （`[参考]`；逆向自 app.asar 的 modelType 编号，与目录返回的 `catPawModelType` 同一套编号）。
 *
 * 用途：turn / round 的 body 要的是**数字** modelType（不是模型名）。上游目录拉不到时
 * （未登录 / 上游不可达）只剩兜底目录，若兜底目录的 modelType 只能填占位值，
 * 请求会被上游拒 —— 有了这张表就能按模型名解析出真值。
 *
 * `0` = auto（由上游自行选型），是「表里没有该模型」时的合法回落。
 */
const MODEL_TYPE_FALLBACK: Readonly<Record<string, number>> = {
  "auto": 0,
  "longcat-2.0": 77,
  "deepseek-v4-flash": 63,
  "deepseek-v4-pro": 64,
  "glm-5.2": 75,
  "glm-5.3-flash": 91,
  "minimax-m3": 70,
  "kimi-k3": 83,
};

/**
 * 兜底表：上游模型目录不可用时仍可暴露的模型。
 *
 * ⚠ **内容取自真实的上游 `/model-types` 返回**（见 `docs/channels/catpaw/PROTOCOL.md`）。
 *
 * ⚠ 兜底表必须用**真实 id**：占位名（如 `catpaw-flash`）上游**根本不存在**，
 * 暴露到模型池也选不中任何模型 —— 兜底表要能真的兜住，就得用真实 id。
 *
 * ⚠ `modelType` 取自 `MODEL_TYPE_FALLBACK`（表里没有的模型回落 0 = auto）；
 * 必须是真实数值：上游按 modelType 数字选型，占位值会让目录不可用时的 turn 请求被拒。
 */
const FALLBACK_MODELS: CatalogEntry[] = [
  {
    id: "glm-5.3-flashx",
    name: "GLM-5.3-FlashX",
    modelType: MODEL_TYPE_FALLBACK["glm-5.3-flashx"] ?? 0,
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutput: 131_072,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
    multiplier: null,
    marketing: "",
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    modelType: MODEL_TYPE_FALLBACK["glm-5.3-flash"] ?? 0,
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutput: 131_072,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
    multiplier: null,
    marketing: "",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    modelType: MODEL_TYPE_FALLBACK["deepseek-v4-flash"] ?? 0,
    reasoning: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutput: 393_216,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
    multiplier: null,
    marketing: "",
  },
];

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
        // 旧缓存可能带着上游的 `supportsImages: true` —— 那是**模型**的能力声明，
        // 不是本渠道的传输能力；读时钉死为 false（否则对外会误报能吃图）。
        const patched =
          entry.supportsImages === false ? entry : { ...entry, supportsImages: false };
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

/** 当前目录（上游缓存优先，缺则兜底）。 */
function loadCatalog(): CatalogEntry[] {
  ensureCachedModels();
  if (_remote && _remote.length > 0) return [..._remote];
  return FALLBACK_MODELS.map((e) => ({ ...e }));
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 解析与落盘已在 `upstream.fetchModels()` 里完成（它调 `setCatalog()`），
 * 这里只负责「要一次真实的拉取，并且失败要抛出去」。
 */
export async function refresh(): Promise<void> {
  // 动态 import：避免 catalog ↔ upstream/cred 的静态环
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
    // 上游的 `supportImage` 是**模型**的能力声明；本渠道的 conversation 协议不传图片
    // （内容拍平成纯文本）→ 不对外声明图片能力（见文件头「图片能力」）。
    supportsImages: false,
    ...parseExtendedInfo(row),
    ...(effort ? { effort } : {}),
  };
  const maxOutput = maxOutputOf(id);
  if (maxOutput !== undefined) entry.maxOutput = maxOutput;
  return entry;
}

/**
 * 对外暴露的模型 ID 列表（全模型池：`catalog` 内全部模型）。
 */
export function exposedIds(): string[] {
  return loadCatalog().map((e) => e.id);
}

/**
 * 短名 → 上游模型 id（字符串，本渠道 id 即上游标识）。
 *
 * 大小写不敏感匹配；未知名称抛错（让网关明确报错，不用错模型发请求）。
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
  throw new Error(`unknown model: ${name}`);
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
 * 解析顺序：上游目录条目 → `MODEL_TYPE_FALLBACK` 数值表 → 抛错。
 *
 * ⚠ 目录取不到时若没有那张表，兜底目录里的 modelType 只能是占位值，
 * 请求会被上游拒 —— 即「未登录 / 目录未拉取时全部模型不可用」。
 *
 * 注：目录条目的 modelType 恒 > 0（上游返回 0 的条目在 `toModelInfo` 就被丢弃）；
 * 兜底目录里表未覆盖的模型取 0（= auto，由上游自行选型）。
 */
export function modelTypeOf(id: string): number {
  for (const entry of loadCatalog()) {
    if (entry.id === id) return entry.modelType;
  }
  const fallback = MODEL_TYPE_FALLBACK[id.toLowerCase()];
  if (fallback !== undefined) return fallback;
  throw new Error(`unknown model id: ${id}`);
}