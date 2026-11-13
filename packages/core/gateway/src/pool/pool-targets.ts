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

import { channels, getChannel, hasChannel, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readCatalogCache } from "../runtime/catalog-cache.js";
import { readModelSpecs, type ModelSpecEntry } from "../runtime/model-specs.js";
import { aliasGroupOf, canonicalOf, POOL_EXPOSED_IDS } from "./model-family.js";
import { providersOf, registryModelOf, upstreamIdOf } from "./model-registry.js";
import { preferredChannelOf } from "./model-prefs.js";
import { priorityOf, totalRemainOf } from "./pool-usage.js";

/** 渠道目录暴露模型的内存缓存时长：`exposedIds()` 要读盘，逐个请求读 17 份太贵。 */
const EXPOSED_TTL_MS = 30_000;
const exposedCache = new Map<string, { ids: string[]; at: number }>();

/** 读某渠道目录暴露的模型 id（带 TTL 缓存）。 */
function exposedIdsOf(cid: string, channel: Channel): string[] {
  const now = Date.now();
  const hit = exposedCache.get(cid);
  if (hit && now - hit.at < EXPOSED_TTL_MS) return hit.ids;
  const ids = runInChannel(cid, () => channel.catalog.exposedIds());
  exposedCache.set(cid, { ids, at: now });
  return ids;
}

/** 清掉某渠道（或全部）的目录缓存 —— 目录刷新后调用，避免最长 TTL 的滞后。 */
export function invalidateExposedCache(cid?: string): void {
  if (cid === undefined) exposedCache.clear();
  else exposedCache.delete(cid);
}

/** 渠道目录是否暴露某规范模型（大小写 / 上游包装归一到家族名后精确相等）。 */
function channelExposes(canonical: string, cid: string, channel: Channel): boolean {
  return exposedIdsOf(cid, channel).some((id) => canonicalOf(id) === canonical);
}

/**
 * 对外暴露的模型池：家族表里**至少有一家渠道目录声明**的 id，按家族表顺序。
 *
 * 供给范围**运行时问各渠道目录**（`catalog.exposedIds()`），不写死在注册表或代码里 ——
 * 渠道目录变了（上游加/下模型、用户改 `hidden`）候选自动跟着变。
 */
export function poolModels(): string[] {
  return POOL_EXPOSED_IDS.filter((id) => poolCandidates(id).length > 0);
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
export type MetaSource = "upstream" | "spec" | "web_search" | "cross" | "registry" | "default";

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

/** 渠道包装前缀（去掉后才可能命中池内模型）。 */
const WRAPPER_PREFIXES = ["sn-", "z-ai-", "bytedance-"];

/**
 * 模型面变更的失效钩子（登录/登出、目录刷新、快照重建后由调用方触发）。
 *
 * 注册表是**磁盘静态文件、每次读取都重新读盘**，没有进程内缓存可失效 ——
 * 这个函数因此是空操作。留着它是为了让调用方不必关心底层有没有缓存：
 * 将来若给注册表加缓存，失效点已经接好，不必回头找调用方。
 */
export function invalidateCrossModelIndex(): void {
  // 有意为空：见上方说明
}

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

/** 一个候选：某渠道能提供该模型。 */
export interface PoolCandidate {
  cid: string;
  channel: Channel;
  /** 对外模型名（规范名）；上游 id 由 `resolvePoolModel()` 从注册表查。 */
  exposedId: string;
}

/**
 * 收集某模型（对外 id 或规范名）的**全部候选渠道** —— 按账号池剩余额度降序。
 *
 * 候选 = **渠道目录现算** ∪ **注册表声明**：
 *  - 目录（`catalog.exposedIds()`）是上游能力的实时事实 —— 上游加/下模型、用户改
 *    `hidden`，候选立刻跟着变，不必改注册表或代码；
 *  - 注册表是**兜底**：新装 / 未登录 / 目录还没拉到时目录可能是空的，这时按注册表
 *    声明兜住，不至于让本来能跑的渠道从候选里消失。
 *
 * 只返回**已注册**的渠道：没装的渠道包不进候选，不必报错。
 */
export function poolCandidates(model: PoolModel): PoolCandidate[] {
  const canonical = canonicalOf(model);
  if (!canonical) return [];
  const declared = new Set(providersOf(canonical));
  const out: PoolCandidate[] = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    if (!declared.has(cid) && !channelExposes(canonical, cid, channel)) continue;
    out.push({ cid, channel, exposedId: canonical });
  }
  return sortByPriority(out, canonical);
}

/**
 * 跨渠道排序：**先按档位，再按有效优先级降序**。
 *
 * 档位（`priorityTier`，数值越小越优先）是**硬**的：不同档位的渠道永不按额度比较 ——
 * 低档位只要还有额度就一定排在前面。用于「额度当天清零、必须在别的渠道之前用掉」的
 * 渠道；乘法权重做不到这一点（实测 loomy 1020×2 < traecn 2329×1，易失额度照样留着）。
 *
 * 档位内按**有效优先级** = 剩余额度 × 速度系数 × 可靠性系数（`pool-usage.priorityOf`）。
 * 为什么不用 `scoreOf`（账单已用量）：那是「用得多的优先」，与「谁还有货谁先出」相反；
 * 额度才是路由主键（见 `pool-usage.totalRemainOf`）。
 *
 * 为什么要乘速度系数：同为「有货」，一个 60 t/s 的渠道和一个 180 t/s 的渠道不该等价 ——
 * 慢渠道会把每个请求的等待时间拉长（实测 qodercn 69–95 t/s vs loomy 177 t/s）。
 * 速度取**当天最近 500 条模型请求**的实测均值（TTL 60s），样本不足不罚。
 * 无额度数据的排最后，同分按 cid 码点序。
 */
function sortByPriority(candidates: readonly PoolCandidate[], canonical: string): PoolCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    const ta = tierOf(a.cid);
    const tb = tierOf(b.cid);
    if (ta !== tb) return ta - tb;
    // 排队渠道往后放（同档位内）：上游会排队的渠道不作为「有货就先用」的对象，
    // 但**仍在候选里** —— 真撞到排队时网关立即换下一条（不等待）。
    const qa = queueOf(a.cid) ? 1 : 0;
    const qb = queueOf(b.cid) ? 1 : 0;
    if (qa !== qb) return qa - qb;
    const pa = priorityOf(a.cid, canonical);
    const pb = priorityOf(b.cid, canonical);
    if (pa === null && pb === null) return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pb !== pa) return pb - pa;
    return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
  });
  // 模型级偏好**置顶**：用户指定「这个模型就走这家」，优先于一切自动排序。
  // 只是换顺序，不改候选集 —— 被偏好的渠道冷却 / 额度耗尽时，后面几家照常顶上。
  const preferred = preferredChannelOf(canonical);
  if (preferred === null) return sorted;
  const at = sorted.findIndex((c) => c.cid.toLowerCase() === preferred.toLowerCase());
  if (at <= 0) return sorted; // 没这家（未注册 / 不供该模型）或已在首位
  return [sorted[at]!, ...sorted.slice(0, at), ...sorted.slice(at + 1)];
}

/** 渠道的选路档位（缺省 1；渠道未注册也按 1）。 */
function tierOf(cid: string): number {
  if (!hasChannel(cid)) return 1;
  const t = getChannel(cid).config.priorityTier;
  return typeof t === "number" && Number.isFinite(t) ? t : 1;
}

/** 渠道上游是否可能排队（能力位 `capabilities.queue`，缺省 false）。 */
function queueOf(cid: string): boolean {
  return hasChannel(cid) && getChannel(cid).config.capabilities?.queue === true;
}

/**
 * 池模型的元数据：**直接读统一注册表**（`<root>/models.json`）。
 *
 * 不再逐渠道聚合。此前是「各渠道目录声明的最大/最小值」，那些数字大多不是上游
 * 真给的（实测 traecn 上游根本不返回输出上限，报出的 65,536 是共享层兜底常量），
 * 聚合出来的值既不代表能力也不代表可跑。现在规格是产品决策，写在注册表里，
 * `/v1/models` 原样返回。
 *
 * 倍率仍然逐渠道实测（它随账号与时段变），从账本与渠道规格里取，不属于注册表。
 */
export function getPoolModelMeta(model: string): PoolModelMeta {
  const canonical = canonicalOf(model) ?? model;
  const row = registryModelOf(canonical);
  if (!row) return DEFAULT_META;
  return {
    name: canonical,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutput,
    inputModalities: row.inputModalities,
    outputModalities: DEFAULT_META.outputModalities,
    effort: null,
    multiplier: null,
    marketing: "",
    sources: { contextWindow: "registry", maxOutputTokens: "registry", effort: "default" },
  };
}

/**
 * 单渠道元数据：控制台的「模型 × 渠道」行用 —— 每行要显示**该渠道**的倍率与规格。
 *
 * 窗口与输出取注册表值（同一模型对所有渠道一致，否则客户端按渠道算预算就会出现
 * 「换个渠道上下文就变」的假象）；倍率逐渠道从账本实测。
 */
export function getChannelModelMeta(cid: string, exposedId: string): PoolModelMeta {
  const canonical = canonicalModelId(exposedId);
  const row = registryModelOf(canonical);
  if (!row) return DEFAULT_META;
  // 倍率按渠道实测（价格随时段与账号变，不进注册表）
  return { ...getPoolModelMeta(canonical), multiplier: channelMultiplierOf(cid, canonical) };
}

/**
 * 渠道维度的消耗倍率：先看渠道 `modelSpec()` 的实测声明，没有就 `null`（未知）。
 *
 * 不跨渠道取值：把 loomy 的倍率显示到 raccoon 行上会误导用户对账单的预期。
 */
function channelMultiplierOf(cid: string, canonical: string): number | null {
  const channel = channels().find((c) => c.config.cid === cid);
  if (!channel) return null;
  const fromSpec = readModelSpecs().models[canonical]?.multiplier;
  if (fromSpec !== undefined) return fromSpec;
  return runInChannel(cid, () => {
    try {
      return channel.catalog.modelSpec?.(canonical)?.multiplier ?? null;
    } catch {
      return null;
    }
  });
}


/**
 * 枚举池模型的元数据（`ids` 缺省 = 全池）—— 逐条读注册表。
 *
 * 返回 `Map` 的迭代顺序即传入顺序（缺省时是 `poolModels()` 的排序结果），
 * 调用方直接照它渲染即可。
 */
export function poolModelMetas(ids?: readonly string[]): Map<string, PoolModelMeta> {
  const out = new Map<string, PoolModelMeta>();
  for (const id of ids ?? poolModels()) out.set(id, getPoolModelMeta(id));
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
