/**
 * 公共模型池：对外只暴露 deepseek 系列（见 `model-family.ts`），客户端用**裸模型名**请求。
 *
 * 渠道归属由网关按「账号池剩余额度之和」自动选择（`poolCandidates`），渠道内再走既有的
 * 账号轮换（`pool/account-rotate.ts`）；设计细节见 docs/POOL-ARCHITECTURE.md。
 *
 * 约束：① 别名双向匹配（`deepseek-flash` ↔ `deepseek-v4.1-flash`）；
 * ② 归一化后**精确相等**（包含匹配会让 `deepseek-v4-flash` 误命中 `deepseek-v4.1-flash`）；
 * ③ 取不到窗口/输出/档位时用兄弟渠道同名值兜底（数值取最大、档位取交集，只填缺值）。
 */

import { channels, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readCatalogCache } from "../runtime/catalog-cache.js";
import { readModelSpecs, type ModelSpecEntry } from "../runtime/model-specs.js";
import { logRecovered, logThrottled } from "../runtime/logger.js";
import { aliasGroupOf, canonicalOf, POOL_EXPOSED_IDS } from "./model-family.js";
import { priorityOf, totalRemainOf } from "./pool-usage.js";

/**
 * 对外暴露的模型池（家族中**至少有一个渠道能供给**的 id，按展示顺序）。
 *
 * 不做进程内缓存：渠道目录可随登录/刷新变化，每次调用重新收集是刻意的
 * （调用方若需在同一表达式里保持一致快照，应先取一次局部变量）。
 *
 * 只公布**有货**的模型：没有渠道供给的 id 公布出去只会让请求必然落空
 * （共享层不持有渠道知识，`AGENTS.md` 的「仓库结构与约束」）。
 */
export function poolModels(): string[] {
  const index = buildCrossModelIndex();
  return POOL_EXPOSED_IDS.filter((id) => candidatesOf(canonicalOf(id)!, index).length > 0);
}

export type PoolModel = string;

/**
 * 池模型的对外元数据 —— **字段结构对齐 DeepSeek 官方 `GET /models`**。
 *
 * 官方（实测 `https://api.deepseek.com/models`）每条长这样：
 *
 * ```json
 * {"id":"deepseek-flash","object":"model","owned_by":"deepseek","name":"DeepSeek-V4.1-Flash",
 *  "context_window":1048576,"max_output_tokens":393216,
 *  "input_modalities":["text","image"],"output_modalities":["text"],
 *  "effort":{"supported_levels":["low","high","max"],"default_level":"high"},
 *  "api_capabilities":{...}}
 * ```
 *
 * 注意官方**没有 `created` 字段**，且 `name` 是展示名而不是 id 的副本 —— 我们照此对齐。
 * `api_capabilities` 是官方 Anthropic 兼容层的私有描述，与我们的转发语义无关，故不输出。
 */
export interface PoolModelMeta {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  outputModalities: string[];
  /**
   * **思考模式（reasoning effort）档位**；`null` = 渠道**没有声明**。
   *
   * 刻意可空：渠道目录**普遍不下发**思考档位（实测只有 catpaw 的 `effort`、
   * loomy / traecn 的 `efforts` 数组有真值）。
   * 兜底**不许编档位**（旧版给所有模型都填了 `["low","high"]`，等于把「不知道」
   * 说成「支持」）——没有声明就是「不支持 / 未知」，由调用方如实呈现。
   */
  effort: { supportedLevels: string[]; defaultLevel: string } | null;
  /** 消耗倍率；null 表示渠道目录未提供。 */
  multiplier: number | null;
  /** 营销角标文案（如「限时免费」「新」）；空串表示无。 */
  marketing: string;
  /** 窗口 / 输出 / 档位三个值**各自从哪来**（见 `MetaSource`）。 */
  sources: ModelMetaSources;
}

/**
 * 元数据取值的来源 —— 让「上游真说的」「渠道按公开规格补的」「兄弟渠道推断的」
 * 「占位值」在界面上分得开（跨渠道兜底不能冒充上游事实）。
 *
 * - `upstream`：渠道目录（上游返回）里有这个字段；
 * - `spec`：渠道按公开规格维护的 `catalog.modelSpec()` 或全局 `model-specs.json`；
 * - `cross`：兄弟渠道同 model id 的已知值（数值取 min / 档位取交集）；
 * - `default`：谁都没有 → 占位值（`effort` 为 `null` 时也记 `default`）。
 */
export type MetaSource = "upstream" | "spec" | "web_search" | "cross" | "default";

/** `PoolModelMeta` 里三个带来源的字段。 */
export interface ModelMetaSources {
  contextWindow: MetaSource;
  maxOutputTokens: MetaSource;
  effort: MetaSource;
}

/**
 * 默认元数据（从渠道 catalog 中提取不到时的兜底）。
 *
 * 兜底值表示「未知」，不是任何模型的真实上限：窗口 200K / 输出 64K 是常见档位的**下限**，
 * 比 4096 更贴近真实模型，避免客户端把长回答截断。能查到公开规格的型号应由渠道表给出真值。
 */
const DEFAULT_META: PoolModelMeta = {
  name: "Unknown",
  contextWindow: 200_000,
  maxOutputTokens: 65_536,
  inputModalities: ["text"],
  outputModalities: ["text"],
  /** 未声明就是未声明 —— 不编档位（见 `PoolModelMeta.effort` 注释）。 */
  effort: null,
  multiplier: null,
  marketing: "",
  sources: { contextWindow: "default", maxOutputTokens: "default", effort: "default" },
};

/** 各渠道缓存条目里可能出现的倍率字段名 —— 渠道自己决定字段名，汇聚层逐个尝试。 */
const MULTIPLIER_KEYS = [
  "price_factor", // Qoder 上游字段（qoder_catalog.py:20 实测）
  "multiplier",
  "effective_multiplier",
  "effectiveMultiplier",
  "cost_multiplier",
];

function firstNumber(entry: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** 各渠道缓存条目里可能出现的营销角标字段名（catpaw 写 `marketing` / `marketingCopy`，兜底 `marketing_copy`）。 */
const MARKETING_KEYS = ["marketing", "marketingCopy", "marketing_copy"];

function firstString(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * 各渠道缓存条目里可能出现的**上下文窗口**字段名 —— 渠道自己决定字段名，汇聚层逐个尝试
 * （与 `MULTIPLIER_KEYS` 同一惯例：字段名只是约定，不算渠道知识）。
 */
const CONTEXT_KEYS = [
  "contextWindow",
  "context_window",
  "maxInputTokens",
  "max_input_tokens",
];

/** 各渠道缓存条目里可能出现的**最大输出**字段名。 */
const OUTPUT_KEYS = [
  "maxOutputTokens",
  "max_output_tokens",
  "maxOutput",
  "max_output",
  "maxTokens",
  "max_tokens",
];

/**
 * 各渠道缓存条目里可能出现的**思考档位**字段名（与 `MULTIPLIER_KEYS` 同一惯例：
 * 字段名只是约定，不算渠道知识）。
 *
 * 两种形态（实测）：
 * - `effort`：对象，catpaw 写 `{supportedLevels:[…], defaultLevel:"high"}`；
 * - `efforts`：字符串数组，loomy / traecn 写 `["none","low","medium","high"]`，
 *   默认档另放在 `defaultEffort` / `default_effort`。
 *
 * **空数组 = 未声明**（traecn 全部模型都写 `[]`），不能当成「支持但档位为空」。
 */
const EFFORT_LIST_KEYS = ["efforts"];
const EFFORT_DEFAULT_KEYS = ["defaultEffort", "default_effort", "default_effort_level"];

/** 归一出 `effort` 形态：`null` = 没声明。 */
function effortOf(entry: Record<string, unknown>): PoolModelMeta["effort"] {
  // 形态一：对象（catpaw）
  const obj = entry["effort"];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    const levelsRaw = Array.isArray(rec["supportedLevels"])
      ? rec["supportedLevels"]
      : Array.isArray(rec["supported_levels"])
        ? rec["supported_levels"]
        : [];
    const levels = levelsRaw.filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (levels.length > 0) {
      return { supportedLevels: levels, defaultLevel: firstString(rec, ["defaultLevel", "default_level"]) };
    }
  }
  // 形态二：数组 + 默认档字段（loomy / traecn）
  for (const key of EFFORT_LIST_KEYS) {
    const list = entry[key];
    if (!Array.isArray(list)) continue;
    const levels = list.filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (levels.length === 0) continue; // 空数组 = 未声明
    return {
      supportedLevels: levels,
      defaultLevel: firstString(entry, EFFORT_DEFAULT_KEYS),
    };
  }
  return null;
}

/**
 * 各渠道缓存条目里可能出现的**图片能力**字段名 —— 渠道自己决定字段名，汇聚层逐个尝试
 * （与 `MULTIPLIER_KEYS` / `CONTEXT_KEYS` 同一惯例：字段名只是约定，不算渠道知识）。
 *
 * 这里收的是「上游/渠道**可能**用的字段名」，**不是**任何一家的私有协议：
 *   目录条目会把上游的原始字段名原样缓存下来，汇聚层照单全收；某个名字看着像
 *   某家的私有缩写也一样收 —— 汇聚层只认识「字段名 → 归一能力」这一张约定表，
 *   不认识渠道（渠道知识只允许出现在各渠道包内）。
 */
const IMAGE_CAPABILITY_KEYS = [
  // 模态数组（取值是字符串数组，如 ["text","image"]）：比布尔开关更具体，优先试
  "inputModalities",
  "input_modalities",
  // 布尔开关（true = 该模型能吃图）
  "supportsImages",
  "supportsImage",
  "supports_image",
  "supportImage",
  "vision",
  "is_vl",
  "isVl",
  "multimodal",
  // **不收** `supports_image_detail_original`：它的语义是「支持原图细节」，
  // 不是「支持图片」—— 收进来会把真能吃图、但不支持原图的型号判成纯文本
  // （实测 workbuddy 随包快照里 `deepseek-v4.1-flash` 就是这个组合）。
];

/** 输入模态的别名表（键一律小写；查表前先小写化）。 */
const MODALITY_ALIASES: Readonly<Record<string, string>> = {
  text: "text",
  txt: "text",
  image: "image",
  images: "image",
  img: "image",
  vision: "image",
};

/** 取候选字段名里的第一个**正整数**值（0 / 缺字段 / 非数都算「上游未声明」）。 */
function firstPositive(entry: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(entry[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * 上下文窗口取值：直字段 + 档位表（`context_config`）取**较大者**。
 *
 * 档位表是 qoder 形态（`{"1M":{token_count:1000000}, "200K":{token_count:200000, is_default:true}}`）；
 * 与 traecn 渠道「有档位时更靠 max」的口径一致 —— 对客户端报**能力上限**，
 * 否则 1M 模型会被按默认档误判成 200k。
 */
function contextWindowOf(entry: Record<string, unknown>): number | null {
  const direct = firstPositive(entry, CONTEXT_KEYS);
  const config = entry["context_config"];
  let tierMax: number | null = null;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    for (const tier of Object.values(config as Record<string, unknown>)) {
      if (!tier || typeof tier !== "object") continue;
      const count = Number((tier as Record<string, unknown>)["token_count"]);
      if (Number.isFinite(count) && count > 0 && (tierMax === null || count > tierMax)) {
        tierMax = count;
      }
    }
  }
  if (direct === null) return tierMax;
  if (tierMax === null) return direct;
  return Math.max(direct, tierMax);
}

/**
 * 模态数组归一：小写化 + 别名映射 + 去重（保持首次出现的顺序）。
 *
 * 查别名用 `hasOwn`：上游目录的 `input_modalities` 是外部数据，写成 `constructor` /
 * `__proto__` 会走原型链命中 `Object.prototype`，`??` 于是不落兜底，
 * 把函数或对象塞进返回值 —— 该结果直接进 `/v1/models` 的 `input_modalities`，
 * 破坏「`string[]`」契约，客户端按字符串处理会崩。
 */
function normalizeModalities(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const key = item.trim().toLowerCase();
    if (!key) continue;
    const norm = Object.hasOwn(MODALITY_ALIASES, key) ? MODALITY_ALIASES[key]! : key;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * 输入模态：目录条目声明的输入能力，归一成 `["text", …]` 形态。
 *
 * 候选字段名见 `IMAGE_CAPABILITY_KEYS`；取值有两类：
 * - **布尔**：`true` → `["text","image"]`（能吃图），`false` → `["text"]`；
 * - **字符串数组**：直接取，归一大小写与别名（`vision` / `img` → `image`）。
 *
 * 一律带 `text`：模型再怎么说也是文本模型，纯文本入口必须留着。
 * 字段全缺 → 回落 `["text"]`（宁可少报，别让客户端以为能发图）。
 */
export function inputModalitiesOf(entry: Record<string, unknown>): string[] {
  for (const key of IMAGE_CAPABILITY_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    // 布尔是**显式声明**（含 false）→ 不再往后试别的键
    if (typeof value === "boolean") return value ? ["text", "image"] : ["text"];
    if (Array.isArray(value)) {
      const modalities = normalizeModalities(value);
      return modalities.length > 0 ? modalities : DEFAULT_META.inputModalities;
    }
  }
  return DEFAULT_META.inputModalities;
}

/** 目录缓存条目：运行期带着渠道自己的字段，类型上只保证 `id`（见 `catalog-cache.ts`）。 */
type CacheRow = Record<string, unknown> & { id: string };

/**
 * **本渠道**已知的事实（上游目录条目 + 渠道公开规格）—— 跨渠道兜底之前的状态。
 *
 * 条目要按渠道自己的 `resolveModel()` 定位：缓存里的 `id` 可能是**上游 key**
 * （qoder 存 `dmodel`），对外名与 key 不同。
 */
interface ChannelFacts {
  entry: CacheRow | null;
  /**
   * 渠道按**公开规格**维护的规格（`catalog.modelSpec()`）。
   *
   * 除窗口 / 输出外还可以带 `effort`：有些渠道没有目录端点（只有内置快照），
   * 但官方文档写明了思考档位 —— 那种情况走这条通道，来源标 `spec` 而不是 `upstream`。
   */
  spec:
    | {
        contextWindow?: number;
        maxOutputTokens?: number;
        effort?: { supportedLevels: string[]; defaultLevel: string };
        multiplier?: number;
      }
    | undefined;
  /** 上游目录声明的窗口（含 `context_config` 档位表取最大档）；null = 没声明。 */
  contextWindow: number | null;
  /** 上游目录声明的输出上限；null = 没声明。 */
  maxOutputTokens: number | null;
  effort: PoolModelMeta["effort"];
}

/** 空事实：本渠道什么都没说（目录读不出来时用它，语义等价于「没有目录」）。 */
const EMPTY_FACTS: ChannelFacts = {
  entry: null,
  spec: undefined,
  contextWindow: null,
  maxOutputTokens: null,
  effort: null,
};

/**
 * 取「本渠道」对这个模型知道的一切。
 *
 * 每一步都兜异常：任一渠道的读盘 / `resolveModel` / `modelSpec` 抛错都不该让
 * `/v1/models` 整页 500（控制台与 `mx model list` 都依赖这个端点）。
 */
function channelFacts(cid: string, channel: Channel, model: string): ChannelFacts {
  return runInChannel(cid, () => {
    let cache: CacheRow[] = [];
    try {
      cache = readCatalogCache<CacheRow>(cid) ?? [];
    } catch {
      cache = [];
    }
    let spec: ChannelFacts["spec"];
    try {
      spec = channel.catalog.modelSpec?.(model);
    } catch {
      spec = undefined;
    }
    let entry = cache.find((row) => canonicalModelId(row.id) === model) ?? null;
    if (!entry) {
      // 缓存 id 可能是上游 key（如 `qfmodel`），与对外名（如 `glm-5.3-flash`）不同 ——
      // 用 resolveModel 将对外名解析为上游 key，再按 key 匹配
      let upstreamKey: string | undefined;
      try {
        upstreamKey = channel.catalog.resolveModel(model);
      } catch {
        upstreamKey = undefined;
      }
      if (upstreamKey !== undefined) {
        entry =
          cache.find(
            (row) => row["key"] === upstreamKey || canonicalModelId(row.id) === upstreamKey,
          ) ?? null;
      }
    }
    return {
      entry,
      spec,
      contextWindow: entry ? contextWindowOf(entry) : null,
      maxOutputTokens: entry ? firstPositive(entry, OUTPUT_KEYS) : null,
      effort: entry ? effortOf(entry) : null,
    };
  });
}

/** 跨渠道兜底候选：兄弟渠道（同规范模型名）那里已知的缺值候补。 */
export interface CrossModelFallback {
  /** 兄弟渠道已知窗口的**最小值**（都没有则 null）。 */
  contextWindow: number | null;
  /** 兄弟渠道已知输出上限的**最小值**（都没有则 null）。 */
  maxOutputTokens: number | null;
  /** 兄弟渠道声明档位的**交集**（没有则 null）。 */
  effort: PoolModelMeta["effort"];
  /**
   * 声明过该模型的渠道及其**原始写法**（上游 slug 大小写敏感，必须原样带回去给
   * `resolveModel()`）。`poolCandidates()` 用它直接定位候选，省掉再扫一遍目录。
   */
  exposed: ReadonlyArray<{ cid: string; exposedId: string }>;
}

/** 规范模型名 → 跨渠道兜底候选；由 `buildCrossModelIndex()` 构建。 */
export type CrossModelIndex = ReadonlyMap<string, CrossModelFallback>;

/**
 * 档位交集：只留**兄弟渠道都声明**的档位 —— 「偏低」= 更少的承诺，
 * 绝不报出某个兄弟渠道不支持、连自己也未必支持的档位。
 *
 * 交集为空 = 各家毫无共识，返回 null（不编档位）。
 */
function intersectEfforts(
  list: readonly { supportedLevels: string[]; defaultLevel: string }[],
): PoolModelMeta["effort"] {
  const first = list[0];
  if (!first) return null;
  let levels = [...first.supportedLevels];
  for (const item of list.slice(1)) {
    levels = levels.filter((level) => item.supportedLevels.includes(level));
  }
  if (levels.length === 0) return null;
  // 默认档：优先取兄弟渠道**真声明过**的默认档（且落在交集内）；都没有才取交集首项 ——
  // 交集里的档位是各家都支持的，取首项不会凭空造出新能力，且能避免下发空档位。
  const declared = list
    .map((item) => item.defaultLevel)
    .find((level) => level !== "" && levels.includes(level));
  return { supportedLevels: levels, defaultLevel: declared ?? levels[0]! };
}

/**
 * 跨渠道索引的缓存时长。
 *
 * 30s 是**兜底**：目录变化都有显式失效（池集合变化 / 目录刷新 / 登录入池），
 * TTL 只防「进程外改目录」这种没有失效信号的情况。控制台轮询是 3 秒一次，
 * 没有这层缓存时每次都要重建（实测 392–398ms 的同步阻塞，把同页面的
 * accounts / logs 请求全挤到后面 —— 症状是「进入账号池要等很久」）。
 */
const CROSS_INDEX_TTL_MS = 30_000;

/** 最近一次构建的跨渠道索引（`null` = 已失效或还没建过）。 */
let crossIndexCache: { at: number; index: CrossModelIndex } | null = null;

/**
 * 让跨渠道索引失效。
 *
 * 调用点必须覆盖「目录内容可能变了」的全部入口：池集合变化（`state.setModels`）、
 * 渠道目录刷新（`mx model --refresh`）、登录入池（账号变多可能带回新模型）。
 */
export function invalidateCrossModelIndex(): void {
  crossIndexCache = null;
}

/**
 * 构建跨渠道索引：把全部渠道的对外模型按**规范模型名**对齐，聚出缺值候补。
 *
 * 只读磁盘目录缓存 + 渠道表，不联网、不落盘。**进程内缓存 30 秒**（见
 * `CROSS_INDEX_TTL_MS`）：建一次要枚举 10 个渠道目录 × 每模型查规格，实测约 400ms
 * 且是同步阻塞 —— 控制台 3 秒轮一次会把事件循环占掉 15%，同页面的其他请求全在排队。
 * 调用方若要在一次枚举里反复用，仍应只取一次（见 `poolModelMetas()`）。
 */
export function buildCrossModelIndex(): CrossModelIndex {
  const now = Date.now();
  const hit = crossIndexCache;
  if (hit !== null && now - hit.at < CROSS_INDEX_TTL_MS) return hit.index;
  interface Bucket {
    ctxs: number[];
    outs: number[];
    efforts: { supportedLevels: string[]; defaultLevel: string }[];
    /** 声明过该模型的渠道及其**原始写法**（`poolCandidates` 直接用它，省掉再扫一遍目录）。 */
    exposed: Array<{ cid: string; exposedId: string }>;
  }
  const acc = new Map<string, Bucket>();
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        const out = channel.catalog.exposedIds() as string[];
        logRecovered(console.warn, `pool:exposedIds:${cid}`, `[pool] channel ${cid} catalog recovered`);
        return out;
      } catch (err) {
        // 坏渠道只影响自己（空目录），但「渠道消失」必须留痕 —— 静默吞掉会让
        // 「随包快照读不到（失败关闭）」伪装成「目录里本来就没有模型」
        logThrottled(console.warn, `pool:exposedIds:${cid}`, `[pool] channel ${cid} exposedIds failed: ${String(err)}`);
        return [] as string[];
      }
    });
    const seen = new Set<string>();
    for (const raw of ids) {
      // 目录条目脏数据（非字符串 id）不该让整池枚举抛错 —— 与 `poolModels()` 同一底线
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const model = canonicalModelId(raw);
      if (seen.has(model)) continue; // 渠道内先按规范名去重
      seen.add(model);
      let facts: ChannelFacts;
      try {
        facts = channelFacts(cid, channel, model);
      } catch {
        continue; // 一个坏渠道只影响自己，不拖垮整池
      }
      const bucket = acc.get(model) ?? { ctxs: [], outs: [], efforts: [], exposed: [] };
      const ctx = facts.contextWindow ?? facts.spec?.contextWindow ?? null;
      const out = facts.maxOutputTokens ?? facts.spec?.maxOutputTokens ?? null;
      // 档位同样收「上游声明」与「渠道规格」两种来源：只认上游会让没有目录端点的渠道
      // （官方档位在规格表里）在别的渠道缺档位时帮不上忙。
      const effort = facts.effort ?? facts.spec?.effort ?? null;
      if (ctx !== null) bucket.ctxs.push(ctx);
      if (out !== null) bucket.outs.push(out);
      if (effort) bucket.efforts.push(effort);
      bucket.exposed.push({ cid, exposedId: raw });
      acc.set(model, bucket);
    }
  }
  const index = new Map<string, CrossModelFallback>();
  for (const [model, bucket] of acc) {
    index.set(model, {
      // 取**最大**：跨渠道兜底是给「本渠道没声明」的字段补值，报的是能力上限。
      // 取最小会把最窄渠道的数字强加给能跑到更宽的渠道（实测 catpaw 报 600K 把
      // traecn 的 1,048,576 拉成 600,000，客户端按它算预算就永远用不满）。
      contextWindow: bucket.ctxs.length > 0 ? Math.max(...bucket.ctxs) : null,
      maxOutputTokens: bucket.outs.length > 0 ? Math.max(...bucket.outs) : null,
      effort: intersectEfforts(bucket.efforts),
      exposed: bucket.exposed,
    });
  }
  crossIndexCache = { at: now, index };
  return index;
}

/**
 * 拼装对外元数据：**本渠道上游 → 本渠道公开规格 → 跨渠道兜底 → 占位值**，
 * 并逐项记下取值来源（`sources`）。
 *
 * 顺序不能换：本渠道规格（渠道按公开规格维护，见 `docs/MODEL-SPECS.md`）比兄弟渠道
 * 被上游裁剪过的值更权威，所以跨渠道兜底**只替换占位值**，不会把已有真值改小。
 * 思考档位同理：上游声明 > 渠道规格（官方文档给的档位）> 跨渠道交集。
 */
function metaFromFacts(
  facts: ChannelFacts,
  model: string,
  cross?: CrossModelFallback,
  modelSpecs?: ModelSpecEntry,
): PoolModelMeta {
  const entry = facts.entry;
  // 取值链：上游 entry → 全局模型规格 → 渠道静态表 spec → 兄弟渠道 cross → 兜底 default
  const ctx =
    facts.contextWindow ?? modelSpecs?.contextWindow ?? facts.spec?.contextWindow ?? cross?.contextWindow ?? null;
  const out =
    facts.maxOutputTokens ?? modelSpecs?.maxOutputTokens ?? facts.spec?.maxOutputTokens ?? cross?.maxOutputTokens ?? null;
  const effort = facts.effort ?? modelSpecs?.effort ?? facts.spec?.effort ?? cross?.effort ?? null;
  // `model-specs.json` 里由联网补全写入的条目，来源标 web_search，与人工规格区分
  const specSource: MetaSource = modelSpecs?._source?.startsWith("web_search") ? "web_search" : "spec";
  const output = entry?.["outputModalities"] ?? entry?.["output_modalities"];
  const inputMods =
    entry
      ? inputModalitiesOf(entry)
      : modelSpecs?.inputModalities
        ? modelSpecs.inputModalities
        : DEFAULT_META.inputModalities;
  // 倍率：上游目录 > 全局规格 > 渠道 spec > 未知（不跨渠道）
  const multiplier =
    entry
      ? firstNumber(entry, MULTIPLIER_KEYS)
      : modelSpecs?.multiplier ?? facts.spec?.multiplier ?? null;
  return {
    name: entry && typeof entry["name"] === "string" && entry["name"] !== "" ? entry["name"] : model,
    contextWindow: ctx ?? DEFAULT_META.contextWindow,
    maxOutputTokens: out ?? DEFAULT_META.maxOutputTokens,
    inputModalities: inputMods,
    outputModalities: Array.isArray(output) ? (output as string[]) : DEFAULT_META.outputModalities,
    effort,
    multiplier,
    marketing: entry ? firstString(entry, MARKETING_KEYS) : "",
    sources: {
      contextWindow:
        ctx === null
          ? "default"
          : facts.contextWindow !== null
            ? "upstream"
            : modelSpecs?.contextWindow !== undefined
              ? specSource
              : facts.spec?.contextWindow !== undefined
                ? "spec"
                : "cross",
      maxOutputTokens:
        out === null
          ? "default"
          : facts.maxOutputTokens !== null
            ? "upstream"
            : modelSpecs?.maxOutputTokens !== undefined
              ? specSource
              : facts.spec?.maxOutputTokens !== undefined
                ? "spec"
                : "cross",
      effort:
        effort === null
          ? "default"
          : facts.effort !== null
            ? "upstream"
            : modelSpecs?.effort !== undefined
              ? specSource
              : facts.spec?.effort !== undefined
                ? "spec"
                : "cross",
    },
  };
}

/**
 * 聚合元数据：一个模型家族跨多个渠道时的合并值。
 *
 * 窗口 / 输出取**各渠道最大值**：对外报的是能力上限，网关按账号池剩余额度挑渠道，
 * 客户端拿这个数字算预算。取最小会把最窄渠道的数字强加给能跑到更宽的渠道 ——
 * 实测 catpaw 报 600K 把 traecn 的 1,048,576 压成 600,000，客户端以为只剩 59% 余量、
 * 不触发自动压缩，一路涨到上游硬顶被拒（2026-11-08）。
 *
 * 窄渠道（如 600K 的 catpaw）应由渠道自己在目录里标 `hidden` 退出该型号候选，
 * 而不是让全池替它降级 —— 见 `docs/MODEL-CATALOG.md`。
 *
 * 档位取**交集**（各家都支持才算支持），倍率与展示名取首个声明渠道。
 * 任一渠道上游声明过的字段，来源就标 `upstream`。
 */
function mergeFacts(list: readonly ChannelFacts[], model: string, spec?: ModelSpecEntry): PoolModelMeta {
  const ctxs = list.map((f) => f.contextWindow).filter((v): v is number => v !== null);
  const outs = list.map((f) => f.maxOutputTokens).filter((v): v is number => v !== null);
  const efforts = list
    .map((f) => f.effort)
    .filter((v): v is { supportedLevels: string[]; defaultLevel: string } => v !== null);
  const ctx = ctxs.length > 0 ? Math.max(...ctxs) : null;
  const out = outs.length > 0 ? Math.max(...outs) : null;
  const effort = intersectEfforts(efforts);
  const specSource: MetaSource = spec?._source?.startsWith("web_search") ? "web_search" : "spec";
  const first = list.find((f) => f.entry) ?? list[0];
  const ctxValue = ctx ?? spec?.contextWindow ?? null;
  const outValue = out ?? spec?.maxOutputTokens ?? null;
  const effortValue = effort ?? spec?.effort ?? null;
  const output = first?.entry?.["outputModalities"] ?? first?.entry?.["output_modalities"];
  return {
    name:
      first?.entry && typeof first.entry["name"] === "string" && first.entry["name"] !== ""
        ? first.entry["name"]
        : model,
    contextWindow: ctxValue ?? DEFAULT_META.contextWindow,
    maxOutputTokens: outValue ?? DEFAULT_META.maxOutputTokens,
    inputModalities: first?.entry ? inputModalitiesOf(first.entry) : DEFAULT_META.inputModalities,
    outputModalities: Array.isArray(output) ? (output as string[]) : DEFAULT_META.outputModalities,
    effort: effortValue,
    multiplier: first?.entry ? firstNumber(first.entry, MULTIPLIER_KEYS) : (spec?.multiplier ?? null),
    marketing: first?.entry ? firstString(first.entry, MARKETING_KEYS) : "",
    sources: {
      contextWindow: ctxValue === null ? "default" : ctx !== null ? "upstream" : specSource,
      maxOutputTokens: outValue === null ? "default" : out !== null ? "upstream" : specSource,
      effort: effortValue === null ? "default" : effort !== null ? "upstream" : specSource,
    },
  };
}

/** 渠道包装前缀（去掉后才可能命中池内模型）。 */
const WRAPPER_PREFIXES = ["sn-", "z-ai-", "bytedance-"];

/**
 * 归一化的共用实现。
 *
 * `stripPath` 只控制**模型段内部**的厂商路径：
 * - 渠道目录里的 id 可能带厂商路径段（如 `deepseek/deepseek-v4.1-flash`），
 *   所以规范名要取最后一段；
 * - 客户端请求的模型段同样允许带厂商路径（`loomy/deepseek/deepseek-v4.1-flash`
 *   也认）—— 渠道归属已由第一个 `/` 显式声明，模型段再剥一层不会串渠道。
 *
 * 其余步骤顺序也有讲究：先小写，再转版本号写法，最后去尾部修饰 ——
 * 反过来会把 `deepseek-v4-flash-0731` 里的版本段误当成修饰。
 */
function normalize(raw: string, stripPath: boolean): string {
  let id = raw.trim().toLowerCase();
  // 1. 厂商路径段：`deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
  if (stripPath) {
    const slash = id.lastIndexOf("/");
    if (slash >= 0) id = id.slice(slash + 1);
  }
  // 2. 渠道包装前缀：`sn-deepseek-v4-1-flash` → `deepseek-v4-1-flash`
  for (const prefix of WRAPPER_PREFIXES) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  // 3. 版本号的连字符写法 → 点：`v4-1` → `v4.1`、`5-3` → `5.3`。
  //    只匹配「数字-数字」，所以 `v4-flash` 里的 `4-f` 不会被碰。
  id = id.replace(/(\d)-(\d)/g, "$1.$2");
  // 4. 尾部修饰：`-official` / `-0731`（4 位日期） / `-latest`
  id = id.replace(/-official$/, "").replace(/-\d{4}$/, "").replace(/-latest$/, "");
  return id;
}

/** 渠道目录里的 exposedId → 规范名（会剥掉厂商路径段）。 */
export function canonicalModelId(exposedId: string): string {
  return normalize(exposedId, true);
}

/** 一个候选：某渠道能提供该模型（带渠道目录里的原始 exposedId）。 */
export interface PoolCandidate {
  cid: string;
  channel: Channel;
  /** 渠道目录里命中的那条（交给渠道自己的 `resolveModel()` 换成上游 slug）。 */
  exposedId: string;
}

/**
 * 收集某模型（对外 id 或规范名）的**全部候选渠道** —— 按账号池剩余额度降序。
 *
 * 渠道归属由网关决定：客户端只说「我要 deepseek-v4-flash」，哪家有货、哪家额度多
 * 由这里排。渠道未注册 / 目录里没有这个模型 / 目录读不出来（缓存损坏等）都返回空
 * —— 一个坏渠道只影响自己，不拖垮整池。
 *
 * 匹配用**目录里的原始写法**（不预先小写）：`exposedId` 要原样带回去给
 * 渠道自己的 `resolveModel()`，而上游 slug 可能大小写敏感（TRAE 认
 * `DeepSeek-V4-Flash`，不认全小写）。
 */
export function poolCandidates(model: PoolModel): PoolCandidate[] {
  const canonical = canonicalOf(model);
  if (!canonical) return [];
  return sortByPriority(candidatesOf(canonical, buildCrossModelIndex()), canonical);
}

/**
 * 某规范模型的候选渠道（未经额度排序）。
 *
 * 别名组内的每个名字都查一遍：`deepseek-flash` 与 `deepseek-v4.1-flash` 互为别名，
 * 渠道目录里写哪个都应命中。同一渠道同时暴露两个名字时取先命中的那个。
 *
 * 命中判定走 `findExposed`（索引 → 直扫目录）：渠道目录里没有这个规范名就不进候选。
 */
function candidatesOf(canonical: string, index: CrossModelIndex): PoolCandidate[] {
  const group = aliasGroupOf(canonical);
  const out: PoolCandidate[] = [];
  const cache: ScanCache = new Map();
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const exposedId = findExposed(cid, channel, group, index, cache);
    if (exposedId !== undefined) out.push({ cid, channel, exposedId });
  }
  return out;
}

/**
 * 一次候选收集 / 元数据聚合内的直扫记忆：`cid → (规范名 → 目录里的原始写法)`。
 *
 * 为什么要它：索引没命中时原实现每次调用都读盘 + 解析一遍目录，而「渠道没有某个名字」是常态；
 * 别名组内每个名字都要问一次（如 `deepseek-flash` 与 `deepseek-v4.1-flash`），不共享就会重复读盘。
 *
 * 记忆**只活在单次调用里**（调用方传同一个 Map）：目录在 TTL 内被改过、或测试里换过渠道时，
 * 下一次调用仍会直扫到最新目录 —— 这与直扫回落原本的语义（补索引的陈旧）一致。
 */
type ScanCache = Map<string, Map<string, string>>;

/** 扫一次目录并记住（坏渠道按「什么都没有」处理，与索引构建同底线）。 */
function scannedIdsOf(cid: string, channel: Channel, cache: ScanCache): Map<string, string> {
  const hit = cache.get(cid);
  if (hit) return hit;
  const ids = runInChannel(cid, () => {
    try {
      const out = channel.catalog.exposedIds() as string[];
      logRecovered(console.warn, `pool:exposedIds:${cid}`, `[pool] channel ${cid} catalog recovered`);
      return out;
    } catch (err) {
      // 目录读不出来：按「该渠道没有这些模型」处理（一个坏渠道不该拖垮整池），
      // 但必须留痕 —— 否则失败关闭的抛错会被伪装成「目录里本来就没有模型」
      logThrottled(console.warn, `pool:exposedIds:${cid}`, `[pool] channel ${cid} exposedIds failed: ${String(err)}`);
      return [] as string[];
    }
  });
  const map = new Map<string, string>();
  for (const id of ids) {
    if (typeof id !== "string") continue; // 目录脏数据（非字符串 id）不该让整池抛错
    const canonical = canonicalModelId(id);
    if (!map.has(canonical)) map.set(canonical, id);
  }
  cache.set(cid, map);
  return map;
}

/**
 * 在某渠道目录里找 `names`（一组规范名）里第一个命中的条目，返回目录里的**原始写法**。
 *
 * 先查跨渠道索引（30s 缓存）；索引没命中再直扫目录（TTL 内刚改过 / 新登录的渠道可能还没进索引）。
 * 直扫结果在**同一次调用**内按 `ScanCache` 共享，常态路径不会重复读盘。
 */
function findExposed(
  cid: string,
  channel: Channel,
  names: readonly string[],
  index: CrossModelIndex,
  cache: ScanCache,
): string | undefined {
  for (const name of names) {
    const hit = index.get(name)?.exposed.find((item) => item.cid === cid)?.exposedId;
    if (hit !== undefined) return hit;
  }
  const scanned = scannedIdsOf(cid, channel, cache);
  for (const name of names) {
    const hit = scanned.get(name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * 跨渠道排序：**有效优先级降序** = 剩余额度 × 速度系数 × 可靠性系数
 * （`pool-usage.priorityOf`）。
 *
 * 为什么不用 `scoreOf`（账单已用量）：那是「用得多的优先」，与「谁还有货谁先出」相反；
 * 额度才是路由主键（见 `pool-usage.totalRemainOf`）。
 *
 * 为什么要乘速度系数：同为「有货」，一个 60 t/s 的渠道和一个 180 t/s 的渠道不该等价 ——
 * 慢渠道会把每个请求的等待时间拉长（实测 qodercn 69–95 t/s vs loomy 177 t/s）。
 * 速度取**当天最近 500 条模型请求**的实测均值（TTL 60s），样本不足不罚。
 * 无额度数据的排最后，同分按 cid 码点序。
 */
function sortByPriority(candidates: readonly PoolCandidate[], canonical: string): PoolCandidate[] {
  return [...candidates].sort((a, b) => {
    const pa = priorityOf(a.cid, canonical);
    const pb = priorityOf(b.cid, canonical);
    if (pa === null && pb === null) return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pb !== pa) return pb - pa;
    return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
  });
}

/**
 * 动态元数据：从池模型指向的渠道 catalog 缓存（models.json）中提取。
 *
 * 上游目录**通常不下发**窗口与输出上限 → 缓存里没有 → 问渠道要「已知规格」
 * （`catalog.modelSpec()`，渠道按公开规格维护）。两者都拿不到才回落兜底值。
 *
 * `cross` 传 `buildCrossModelIndex()` 的结果时启用**跨渠道兜底**（只填缺值）。
 * 不传 = 不做跨渠道兜底：单查（转发路径只取倍率）不值得为它扫全池 —— 见 `poolModelMetas()`。
 */
export function getPoolModelMeta(model: string, cross?: CrossModelIndex, modelSpecs?: Record<string, ModelSpecEntry>): PoolModelMeta {
  const canonical = canonicalOf(model) ?? model;
  const index = cross ?? buildCrossModelIndex();
  const specs = modelSpecs ?? readModelSpecs().models;
  const group = aliasGroupOf(canonical);
  const factsList: ChannelFacts[] = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    for (const name of group) {
      if (!index.get(name)?.exposed.some((item) => item.cid === cid)) continue;
      try {
        factsList.push(channelFacts(cid, channel, name));
      } catch {
        // 一个坏渠道只影响自己，不拖垮整池
      }
      break;
    }
  }
  return mergeFacts(factsList, canonical, specs[canonical]);
}

/**
 * 单渠道元数据：控制台的「模型 × 渠道」行用 —— 每行要显示**该渠道**的倍率与规格，
 * 不能用跨渠道聚合值（那会把 loomy 的倍率显示到 raccoon 行上）。
 *
 * `cross` 传 `buildCrossModelIndex()` 的结果时启用跨渠道兜底（该渠道没声明窗口/档位时
 * 取兄弟渠道的保守值，来源标 `cross`）。
 */
export function getChannelModelMeta(cid: string, exposedId: string, cross?: CrossModelIndex): PoolModelMeta {
  const channel = channels().find((c) => c.config.cid === cid);
  if (!channel) return DEFAULT_META;
  const name = canonicalModelId(exposedId);
  let facts: ChannelFacts;
  try {
    facts = channelFacts(cid, channel, name);
  } catch {
    return DEFAULT_META;
  }
  return metaFromFacts(facts, name, cross?.get(name), readModelSpecs().models[name]);
}

/**
 * `poolModelMetas` 的结果缓存（**按入参数组的身份**记忆）。
 *
 * 控制台每 3 秒调一次 `poolModelMetas(this.modelsShown)`，而每次都要为模型
 * 逐条走一遍 `getPoolModelMeta`（读目录缓存 + 查规格 + 四层回落），是实打实的
 * **同步阻塞** —— 事件循环被占住，同页面的 accounts / logs 请求只能排队。
 *
 * 三个失效信号任一变化即重建：入参数组换了（池集合变）、跨渠道索引换了（目录变）、
 * 规格表换了（mtime 变）。都走身份比较，命中成本是一次指针比对。
 */
let metaCache: {
  ids: readonly string[];
  index: CrossModelIndex;
  specs: Record<string, ModelSpecEntry>;
  out: Map<string, PoolModelMeta>;
} | null = null;

/**
 * 枚举池模型的元数据（`ids` 缺省 = 全池）—— **一次**构建跨渠道索引再逐条取值。
 *
 * 返回 `Map` 的迭代顺序即传入顺序（缺省时是 `poolModels()` 的排序结果），
 * 调用方直接照它渲染即可，不必自己再收集一遍目录。
 *
 * 传**同一个数组引用**重复调用时直接返回上次结果（见 `metaCache`）：池集合没变、
 * 目录没变，元数据就不会变。缺省入参（全池）不缓存 —— 它每次都要重新收集池集合。
 */
export function poolModelMetas(ids?: readonly string[]): Map<string, PoolModelMeta> {
  const index = buildCrossModelIndex();
  const specs = readModelSpecs().models;
  if (ids !== undefined && metaCache !== null &&
      metaCache.ids === ids && metaCache.index === index && metaCache.specs === specs) {
    return metaCache.out;
  }
  const out = new Map<string, PoolModelMeta>();
  for (const id of ids ?? poolModels()) out.set(id, getPoolModelMeta(id, index, specs));
  if (ids !== undefined) metaCache = { ids, index, specs, out };
  return out;
}

/** 兼容旧代码的常量形式。 */
export const POOL_MODEL_META: Record<string, PoolModelMeta> = new Proxy({} as Record<string, PoolModelMeta>, {
  get(target, prop, receiver) {
    // 符号键（`Symbol.toPrimitive` 等）与 `Object.prototype` 上的成员（`toString` /
    // `valueOf` / `constructor` …）都不是模型名：一律走默认语义。
    // 把它们送进模型名解析会让字符串化（`String(POOL_MODEL_META)`、模板串）拿到
    // 一个不可调用的对象，最终抛 `TypeError: Cannot convert object to primitive value`。
    // 用 `hasOwn` 而非 `in`：`in` 会走原型链，若同进程任何地方给 `Object.prototype`
    // 挂了属性，这个判据就会把真实模型名误判成「原型成员」而放行到默认语义。
    if (typeof prop !== "string" || Object.hasOwn(Object.prototype, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return getPoolModelMeta(prop);
  },
});

/**
 * 池模型的只读快照（兼容旧调用形态）。
 *
 * 底层是**真实数组**：每次读属性时按当前渠道目录重建，因此 `Object.keys` /
 * `JSON.stringify` / 展开 / 迭代 / 数字索引天然一致（早期用空数组 + Proxy
 * 只会让 `keys` 与 `length` 互相矛盾，序列化时会静默丢内容）。
 */
export const POOL_MODELS: readonly string[] = new Proxy([] as string[], {
  get(_target, prop, receiver) {
    const models = poolModels();
    if (prop === "length") return models.length;
    if (typeof prop === "string" && /^\d+$/.test(prop)) return models[Number(prop)];
    const value = (models as unknown as Record<string | symbol, unknown>)[prop];
    // 函数一律绑定到本次快照：避免 this 落到 Proxy 上导致 sort/push 之类静默失效
    return typeof value === "function" ? value.bind(models) : value;
  },
  has(_target, prop) {
    const models = poolModels();
    if (typeof prop === "string" && /^\d+$/.test(prop)) return Number(prop) < models.length;
    return prop in (models as unknown as object);
  },
  ownKeys() {
    // 让 Object.keys / JSON.stringify / spread 看到真实索引。
    //
    // **必须带 `length`**：Proxy 的不变量要求 `ownKeys` 覆盖目标对象的全部**非可配置**
    // 自有属性，而数组的 `length` 正是其中之一。漏掉它时 `Object.keys()` /
    // `Object.entries()` / `for...in` 一律抛
    // `TypeError: 'ownKeys' on proxy: trap result did not include 'length'`
    // —— 这个对象是对外导出的（见 index.ts），下游任何一次遍历都会炸
    // （2026-11-08 评审复现）。
    return [...poolModels().map((_, i) => String(i)), "length"];
  },
  getOwnPropertyDescriptor(_target, prop) {
    const models = poolModels();
    if (prop === "length") {
      // 数组的 length 不可配置；这里如实报告，否则同样触发不变量检查
      return { value: models.length, writable: true, enumerable: false, configurable: false };
    }
    if (typeof prop === "string" && /^\d+$/.test(prop)) {
      const i = Number(prop);
      if (i < models.length) {
        return { value: models[i], writable: false, enumerable: true, configurable: true };
      }
    }
    return undefined;
  },
});
