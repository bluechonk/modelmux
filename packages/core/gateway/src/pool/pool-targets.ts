/**
 * 公共模型池：对外暴露**全部渠道能提供的真实模型**，id 形态为 `<cid>/<模型>`。
 * 客户端用渠道 id 选池子，网关不跨渠道改路由；**不同渠道的同名模型不互相去重**。
 *
 * 关键约束（设计细节见 docs/POOL-ARCHITECTURE.md）：
 *   - **模型段归一化**（恒小写）后做**精确相等**比较 —— 包含匹配会让
 *     `deepseek-v4-flash` 误命中 `deepseek-v4.1-flash`。
 *   - **图片能力**：各渠道字段名各异，按候选表逐个尝试（`IMAGE_CAPABILITY_KEYS`），
 *     全缺回落 `["text"]`。
 *   - **跨渠道兜底**：取不到窗口/输出/档位时用兄弟渠道同名值兜底
 *     （数值取最小、档位取交集），只填缺值且记录来源。
 */

import { channels, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readCatalogCache } from "../runtime/catalog-cache.js";
import { readModelSpecs, type ModelSpecEntry } from "../runtime/model-specs.js";
import { logRecovered, logThrottled } from "../runtime/logger.js";

/**
 * 对外暴露的模型池（动态收集：各渠道 `exposedIds()` 归一化后挂上 `<cid>/` 前缀）。
 *
 * ⚠ 不做进程内缓存：渠道目录可随登录/刷新变化，每次调用重新收集是刻意的
 * （调用方若需在同一表达式里保持一致快照，应先取一次局部变量）。
 *
 * 空池返回 `[]`（**不硬编码兜底模型**）——共享层不持有任何渠道知识（`AGENTS.md` 的「仓库结构与约束」）；
 * 空池意味着所有渠道目录都读不出来，此时对外公布幻影模型只会让请求必然落空。
 */
export function poolModels(): string[] {
  const out: string[] = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        const exposed = channel.catalog.exposedIds() as string[];
        // 恢复时输出一条状态变化记录（含静默期间的重复次数）
        logRecovered(console.warn, `pool:exposedIds:${cid}`, `[pool] channel ${cid} exposedIds recovered`);
        return exposed;
      } catch (err) {
        // 单个渠道的目录异常不影响整池收集；输出走节流器，避免高频重复占满日志
        logThrottled(
          console.warn,
          `pool:exposedIds:${cid}`,
          `[pool] channel ${cid} exposedIds failed: ${String(err)}`,
        );
        return [] as string[];
      }
    });
    // 渠道内先按规范名去重：同一渠道的不同原始写法收敛到同一个对外 id
    const seen = new Set<string>();
    for (const id of ids) {
      const canonical = canonicalModelId(id);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(`${cid}/${canonical}`);
    }
  }
  return out.sort();
}

/** 池模型 id 的拼装（`<cid>/<规范模型名>`）：渠道目录 → 对外 id 的唯一写法。 */
export function poolModelId(cid: string, exposedId: string): string {
  return `${cid}/${canonicalModelId(exposedId)}`;
}

/**
 * 拆解池模型 id：第一个 `/` 之前是渠道 id，其余是模型段。
 *
 * 渠道段**小写化**（cid 全为小写，请求方大小写笔误照收）；模型段按规范路径归一化
 * （可剥**模型段内部**的厂商路径段：`loomy/deepseek/deepseek-v4.1-flash` →
 * `loomy/deepseek-v4.1-flash`）。格式不合法（无 `/`、段为空）返回 null。
 *
 * ⚠ 只按**第一个** `/` 切：渠道 id 本身不含 `/`，模型段内部的 `/` 属于厂商路径。
 */
export function parsePoolModel(id: string): { cid: string; model: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  const cid = id.slice(0, slash).trim().toLowerCase();
  const model = normalize(id.slice(slash + 1), true);
  if (!cid || !model) return null;
  return { cid, model };
}

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
    // 让 Object.keys / JSON.stringify / spread 看到真实索引
    return poolModels().map((_, i) => String(i));
  },
  getOwnPropertyDescriptor(_target, prop) {
    const models = poolModels();
    if (typeof prop === "string" && /^\d+$/.test(prop)) {
      const i = Number(prop);
      if (i < models.length) {
        return { value: models[i], writable: false, enumerable: true, configurable: true };
      }
    }
    return undefined;
  },
});

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
   * ⚠ 刻意可空：渠道目录**普遍不下发**思考档位（实测只有 catpaw 的 `effort`、
   * loomy / traecn / lobsterai 的 `efforts` 数组有真值）。
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
 * - `upstream`：本渠道目录（上游返回）里有这个字段；
 * - `spec`：本渠道按公开规格维护的 `catalog.modelSpec()`（窗口 / 输出 / **官方文档给的思考档位**）；
 * - `cross`：兄弟渠道同 model id 的已知值（数值取 min / 档位取交集）；
 * - `default`：谁都没有 → 占位值（`effort` 为 `null` 时也记 `default`）。
 */
export type MetaSource = "upstream" | "spec" | "cross" | "default";

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
 * - `efforts`：字符串数组，loomy / traecn / lobsterai 写 `["none","low","medium","high"]`，
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
  // 形态二：数组 + 默认档字段（loomy / traecn / lobsterai）
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
 * ⚠ 这里收的是「上游/渠道**可能**用的字段名」，**不是**任何一家的私有协议：
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
  // ⚠ **不收** `supports_image_detail_original`：它的语义是「支持原图细节」，
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

/** 模态数组归一：小写化 + 别名映射 + 去重（保持首次出现的顺序）。 */
function normalizeModalities(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const key = item.trim().toLowerCase();
    if (!key) continue;
    const norm = MODALITY_ALIASES[key] ?? key;
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
 * ⚠ 条目要按渠道自己的 `resolveModel()` 定位：缓存里的 `id` 可能是**上游 key**
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
 * 构建跨渠道索引：把全部渠道的对外模型按**规范模型名**对齐，聚出缺值候补。
 *
 * 只读磁盘目录缓存 + 渠道表，不联网、不落盘，也**不缓存结果** —— 渠道目录会随
 * 登录 / 刷新变化，与 `poolModels()` 同一口径（每次重新收集）。
 * 调用方若要在一次枚举里反复用，应只建一次（见 `poolModelMetas()`）。
 */
export function buildCrossModelIndex(): CrossModelIndex {
  interface Bucket {
    ctxs: number[];
    outs: number[];
    efforts: { supportedLevels: string[]; defaultLevel: string }[];
  }
  const acc = new Map<string, Bucket>();
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        return channel.catalog.exposedIds() as string[];
      } catch {
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
      const bucket = acc.get(model) ?? { ctxs: [], outs: [], efforts: [] };
      const ctx = facts.contextWindow ?? facts.spec?.contextWindow ?? null;
      const out = facts.maxOutputTokens ?? facts.spec?.maxOutputTokens ?? null;
      // 档位同样收「上游声明」与「渠道规格」两种来源：只认上游会让没有目录端点的渠道
      // （官方档位在规格表里）在别的渠道缺档位时帮不上忙。
      const effort = facts.effort ?? facts.spec?.effort ?? null;
      if (ctx !== null) bucket.ctxs.push(ctx);
      if (out !== null) bucket.outs.push(out);
      if (effort) bucket.efforts.push(effort);
      acc.set(model, bucket);
    }
  }
  const index = new Map<string, CrossModelFallback>();
  for (const [model, bucket] of acc) {
    index.set(model, {
      contextWindow: bucket.ctxs.length > 0 ? Math.min(...bucket.ctxs) : null,
      maxOutputTokens: bucket.outs.length > 0 ? Math.min(...bucket.outs) : null,
      effort: intersectEfforts(bucket.efforts),
    });
  }
  return index;
}

/**
 * 拼装对外元数据：**本渠道上游 → 本渠道公开规格 → 跨渠道兜底 → 占位值**，
 * 并逐项记下取值来源（`sources`）。
 *
 * ⚠ 顺序不能换：本渠道规格（渠道按公开规格维护，见 `docs/MODEL-SPECS.md`）比兄弟渠道
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
              ? "spec"
              : facts.spec?.contextWindow !== undefined
                ? "spec"
                : "cross",
      maxOutputTokens:
        out === null
          ? "default"
          : facts.maxOutputTokens !== null
            ? "upstream"
            : modelSpecs?.maxOutputTokens !== undefined
              ? "spec"
              : facts.spec?.maxOutputTokens !== undefined
                ? "spec"
                : "cross",
      effort:
        effort === null
          ? "default"
          : facts.effort !== null
            ? "upstream"
            : modelSpecs?.effort !== undefined
              ? "spec"
              : facts.spec?.effort !== undefined
                ? "spec"
                : "cross",
    },
  };
}

/**
 * 动态元数据：从池模型 id 指向的渠道 catalog 缓存（models.json）中提取。
 *
 * ⚠ 上游目录**通常不下发**窗口与输出上限 → 缓存里没有 → 问渠道要「已知规格」
 * （`catalog.modelSpec()`，渠道按公开规格维护）。两者都拿不到才回落兜底值。
 *
 * `cross` 传 `buildCrossModelIndex()` 的结果时启用**跨渠道兜底**（只填缺值）。
 * 不传 = 不做跨渠道兜底：单查（转发路径只取倍率）不值得为它扫全池 —— 见 `poolModelMetas()`。
 */
export function getPoolModelMeta(model: string, cross?: CrossModelIndex, modelSpecs?: Record<string, ModelSpecEntry>): PoolModelMeta {
  const parsed = parsePoolModel(model);
  if (!parsed) return DEFAULT_META;
  const channel = findChannel(parsed.cid);
  if (!channel) return DEFAULT_META;
  let facts: ChannelFacts;
  try {
    facts = channelFacts(channel.config.cid, channel, parsed.model);
  } catch {
    facts = EMPTY_FACTS;
  }
  return metaFromFacts(facts, model, cross?.get(parsed.model), modelSpecs?.[parsed.model]);
}

/**
 * 枚举池模型的元数据（`ids` 缺省 = 全池）—— **一次**构建跨渠道索引再逐条取值。
 *
 * 返回 `Map` 的迭代顺序即传入顺序（缺省时是 `poolModels()` 的排序结果），
 * 调用方直接照它渲染即可，不必自己再收集一遍目录。
 */
export function poolModelMetas(ids?: readonly string[]): Map<string, PoolModelMeta> {
  const index = buildCrossModelIndex();
  const specs = readModelSpecs().models;
  const out = new Map<string, PoolModelMeta>();
  for (const id of ids ?? poolModels()) out.set(id, getPoolModelMeta(id, index, specs));
  return out;
}

/** 按渠道 id（大小写不敏感）找已注册渠道（未注册返回 undefined）。 */
function findChannel(cid: string): Channel | undefined {
  const wanted = cid.toLowerCase();
  return channels().find((c) => c.config.cid.toLowerCase() === wanted);
}

/** 兼容旧代码的常量形式。 */
export const POOL_MODEL_META: Record<string, PoolModelMeta> = new Proxy({} as Record<string, PoolModelMeta>, {
  get(_target, prop: string) {
    return getPoolModelMeta(prop);
  },
});

/** 渠道包装前缀（去掉后才可能命中池内模型）。 */
const WRAPPER_PREFIXES = ["sn-", "z-ai-", "bytedance-"];

/**
 * 归一化的共用实现。
 *
 * ⚠ `stripPath` 只控制**模型段内部**的厂商路径：
 * - 渠道目录里的 id 可能带厂商路径段（如 `deepseek/deepseek-v4.1-flash`），
 *   所以规范名要取最后一段；
 * - 客户端请求的模型段同样允许带厂商路径（`loomy/deepseek/deepseek-v4.1-flash`
 *   也认）—— 渠道归属已由第一个 `/` 显式声明，模型段再剥一层不会串渠道。
 *
 * ⚠ 其余步骤顺序也有讲究：先小写，再转版本号写法，最后去尾部修饰 ——
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

/**
 * 客户端请求的模型名归一化；**必须**是 `<cid>/<模型>` 形态，否则返回 null。
 *
 * 渠道段改小写、模型段走归一化路径（见上）。裸模型名（不带渠道前缀）判 null
 * —— 这是「渠道由请求方指定」的一面：网关不知道裸名该去哪家。
 *
 * 全模型池：不再限制只匹配固定 2 个 flash，而是动态匹配渠道目录里的一切。
 * 渠道未注册 / 目录未命中由 poolCandidates 的空检查兜底。
 */
export function asPoolModel(name: string): PoolModel | null {
  const parsed = parsePoolModel(name);
  if (!parsed) return null;
  return `${parsed.cid}/${parsed.model}`;
}

/** 一个候选：某渠道能提供该池模型（带渠道目录里的原始 exposedId）。 */
export interface PoolCandidate {
  cid: string;
  channel: Channel;
  /** 渠道目录里命中的那条（交给渠道自己的 `resolveModel()` 换成上游 slug）。 */
  exposedId: string;
}

/**
 * 收集某池模型 id（`<cid>/<模型>`）的候选渠道 —— **最多一条**：渠道已由请求方指定。
 *
 * 渠道按 id 大小写不敏感匹配；该渠道目录里第一条规范名命中的就是对外名
 * （渠道自己排的优先级）。渠道未注册 / 目录里没有这个模型 / 目录读不出来
 * （缓存损坏等）都返回空 —— 一个坏渠道只影响指向它的请求。
 *
 * ⚠ 匹配用**目录里的原始写法**（不预先小写）：`exposedId` 要原样带回去给
 * 渠道自己的 `resolveModel()`，而上游 slug 可能大小写敏感（TRAE 认
 * `DeepSeek-V4-Flash`，不认全小写）。
 */
export function poolCandidates(model: PoolModel): PoolCandidate[] {
  const parsed = parsePoolModel(model);
  if (!parsed) return [];
  const channel = findChannel(parsed.cid);
  if (!channel) return [];
  const cid = channel.config.cid;
  const ids = runInChannel(cid, () => {
    try {
      return channel.catalog.exposedIds();
    } catch {
      return [] as string[];
    }
  });
  const hit = ids.find((id) => canonicalModelId(id) === parsed.model);
  return hit === undefined ? [] : [{ cid, channel, exposedId: hit }];
}
