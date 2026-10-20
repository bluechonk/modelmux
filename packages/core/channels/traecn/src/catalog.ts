/**
 * TRAE 模型目录：通道白名单过滤 + 硬过滤 + 合并优先级 + 兜底表。
 *
 * ## 通道白名单机制（docs/channels/traecn/PROTOCOL.md §5.2，重点）
 *
 * 15 个通道的**顺序即优先级**，它同时是白名单与排序表：
 * 不在表内的通道**整组丢弃**（连同其独有模型）。
 * 稳定被拒的 `chat`（4023）/ `builder`（4001）/ `inline_chat`（3003）绝不列入。
 *
 * 同一模型被多个白名单通道列出时的合并规则：
 *   ① 空档位不得覆盖有档位 → ② 两侧都有档位时取更靠前者 → ③ 其余「后覆盖前」。
 *
 * 硬过滤：`usage !== 'chat_completion'` 剔除、`config_switch === false` 剔除、
 * `is_invisible_to_user === true` 剔除；`is_custom_model === true` 也剔除
 * （实测 5/5 报 4001）。
 *
 * 目录来源优先级：远端目录（`mergeRemote` 写入的缓存）→ 仓库根 `models.json`
 * → 内置兜底表（32 条，含 4 条官方隐藏）。**兜底是必需的**：未登录或上游目录
 * 失败时用户仍应看到模型，否则渠道在选择器里凭空消失。
 *
 * ## 窗口 / 输出上限：目录只写**上游声明**，其余按公开规格补
 *
 * 目录条目里的 `context_window` / `max_output` **只写上游真实声明的值**
 * （Remote 目录的 `context_window_tokens`、Solo 目录的 `model_detail_list`），
 * 上游没声明就是 0（= 未声明）—— **不写渠道估值**，否则估值会挡住公开规格
 * （`modelSpec` 钩子），`/v1/models` 就会一直报那个估值。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalModelId, readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

/** 缺省通道（`function` 字段）。 */
export const DEFAULT_FUNCTION = "solo_work_lite";

/**
 * 通道白名单（15 个，顺序即优先级）。
 *
 * ⚠ 可用 `TRAE_CHANNELS`（逗号分隔）覆盖整张表 —— 上游调整通道时不必改代码。
 */
export const DEFAULT_CHANNEL_WHITELIST: string[] = [
  "solo_agent",
  "solo_work_lite",
  "solo_agent_remote",
  "solo_work_remote",
  "solo_agent_lite",
  "chat_v3",
  "builder_v3",
  "solo_coder",
  "solo_design_lite",
  "solo_design_remote",
  "git_ai",
  "code_reviewer",
  "code_review_summary",
  "multimodal",
  "system_diagnosis",
];

/** 当前白名单（含环境变量覆盖）。 */
export function channelWhitelist(): string[] {
  const env = process.env["TRAE_CHANNELS"];
  if (env) {
    const list = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return [...DEFAULT_CHANNEL_WHITELIST];
}

export interface ModelEntry {
  /** 对外暴露的 id。 */
  id: string;
  /** 上游 config_name（请求体 model / config_name 用它）。 */
  model: string;
  name: string;
  /** 该模型所属通道（请求体 function）。 */
  function: string;
  /** 上下文窗口（**上游声明**；0 = 上游未声明，按公开规格表补）。 */
  context_window: number;
  /** 单次回复最大输出（**上游声明**；0 = 上游未声明，按公开规格表补）。 */
  max_output: number;
  max_max_tokens?: number;
  /** 消耗倍率（features.consumption_rate；活动期取 activity_discount 折后值）。 */
  multiplier?: number;
  max_mode: boolean;
  multimodal: boolean;
  tiered: boolean;
  efforts: string[];
  default_effort: string;
  hidden: boolean;
}

/**
 * 已知模型规格（上下文窗口 / 单次回复最大输出）。
 *
 * ⚠ 键是**归一后的规范模型名**（`DeepSeek-V4-Flash-Official` → `deepseek-v4-flash`、
 * `Doubao-Seed-2.1-Pro` → `doubao-seed-2.1-pro`）。
 * ⚠ `qwen-3.7-plus` 在本文写作 `qwen3.7-plus`（同一个模型，键按本渠道的规范名）。
 *
 * ⚠ **不列**官方未公开数值的型号（`doubao-seed-code` / `doubao-seed-2.0-code` /
 * `glm-5-turbo` / `sagitta` / `aquila` / 各 `custom_model_*` 等）——
 * 见 `docs/MODEL-SPECS.md` §4「没有公开规格的」；不编造数字。
 *
 * 来源：`docs/MODEL-SPECS.md` §3（联网核实的唯一事实源）。
 */
const MODEL_SPECS: Readonly<Record<string, { contextWindow: number; maxOutputTokens: number }>> = {
  "deepseek-v4-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v4-pro": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v4.1-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "doubao-seed-2.1-pro": { contextWindow: 1_048_576, maxOutputTokens: 262_144 },
  "doubao-seed-2.1-turbo": { contextWindow: 262_144, maxOutputTokens: 262_144 },
  "doubao-seed-evolving": { contextWindow: 1_048_576, maxOutputTokens: 262_144 },
  "glm-5": { contextWindow: 202_752, maxOutputTokens: 131_072 },
  "glm-5.2": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3-flash": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3-flashx": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "kimi-k2.6": { contextWindow: 262_144, maxOutputTokens: 32_768 },
  "kimi-k2.7-code": { contextWindow: 262_144, maxOutputTokens: 32_768 },
  "kimi-k3": { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 },
  "mimo-v2.6-flash": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "mimo-v2.6-pro": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "minimax-m3": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "minimax-m3.1-flash": { contextWindow: 1_000_000, maxOutputTokens: 524_288 },
  "qwen-3.7-plus": { contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  "qwen3.8-max": { contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  "step-5-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
};

/**
 * Max 模式（1M 上下文）成套下发时的**窗口兜底**。
 *
 * ⚠ 上游目录没声明窗口时用它（`context_window_size` 必须成套下发，见 upstream.ts）。
 * ⚠ **只给请求体用** —— 目录条目里的 `context_window` 只写上游声明，不写这个估值。
 */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * ## 优先级：目录（上游声明）→ 规格表
 *
 * 1. **目录**：`context_window` / `max_output` 是上游**真实声明**的值（Remote 目录的
 *    `context_window_tokens`、Solo 目录的 `model_detail_list`）—— 上游声明最权威
 *    （`docs/MODEL-SPECS.md` §5「上游声明优先」）。
 *    ⚠ **只认远端目录**：内置兜底表里没有声明（0），不算数。
 * 2. **规格表**：上游没声明的字段按**公开规格**补（`docs/MODEL-SPECS.md` §3）——
 *    Remote 目录**不下发输出上限**，故绝大多数型号的输出上限来自这张表。
 * 3. 都没有 → 返回 undefined（= 未知，回落网关兜底值，不编造）。
 *
 * ⚠ **查不到返回 undefined**（不编造数字）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const wanted = canonicalModelId(modelId);
  // ① 远端目录里的上游声明（磁盘缓存 / mergeRemote 灌入的那份）
  const entry = remoteEntries().find((e) => canonicalModelId(e.id) === wanted);
  const dirContext = entry && entry.context_window > 0 ? entry.context_window : undefined;
  const dirMaxOutput = entry && entry.max_output > 0 ? entry.max_output : undefined;
  // ② 公开规格表（上游没声明的字段用它补）
  const spec = MODEL_SPECS[wanted];
  const contextWindow = dirContext ?? spec?.contextWindow;
  const maxOutputTokens = dirMaxOutput ?? spec?.maxOutputTokens;
  if (contextWindow === undefined && maxOutputTokens === undefined) return undefined;
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

/** 32 条兜底模型（含 4 条官方隐藏 —— 隐藏条目不在 exposedIds 里）。 */
const FALLBACK_NAMES: Array<[string, boolean]> = [
  ["DeepSeek-V4-Flash-Official", false],
  ["Doubao-Seed-2.1-Pro", false],
  ["seed-code-pro-0430", false],
  ["Doubao-Seed-2.1-Turbo", false],
  ["Doubao-Seed-2.0-Code", false],
  ["browser_use_subagent", true],
  ["glm-5.2", false],
  ["glm-5-turbo", false],
  ["glm-5", false],
  ["DeepSeek-V4-Pro", false],
  ["DeepSeek-V4-Flash", false],
  ["kimi-k3", false],
  ["kimi-k2.7-code", false],
  ["kimi-k2.6", false],
  ["minimax-m3", false],
  ["qwen-3.7-plus", false],
  ["sagitta", false],
  ["aquila", false],
  ["custom_model_gemini", false],
  ["custom_model_placeholder", false],
  ["custom_model_1M_text", false],
  ["custom_model_1M", false],
  ["custom_model_kimi", false],
  ["custom_model_claude", false],
  ["custom_model_gpt-5", false],
  ["custom_model_no-fc", false],
  ["custom_model_deepseek_chat", false],
  ["custom_model_deepseek_reasoner", false],
  ["custom_model_deepseek_v4", false],
  ["explore_sub_agent_v13", true],
  ["explore_sub_agent_v2", true],
  ["summary", true],
];

/**
 * 内置兜底模型表（**只有 id**，不带窗口 / 输出上限）。
 *
 * ⚠ 窗口与输出上限**不写估值**：内置表不是上游声明，写了就会挡住公开规格
 * （`modelSpec` 钩子）—— 数值一律由 `modelSpec` 按公开规格给。
 */
export const FALLBACK_MODELS: ModelEntry[] = FALLBACK_NAMES.map(([id, hidden]) => ({
  id,
  model: id,
  name: id,
  function: DEFAULT_FUNCTION,
  context_window: 0, // 上游未声明（内置表不是声明源）
  max_output: 0, // 上游未声明
  max_mode: false,
  multimodal: false,
  tiered: false,
  efforts: [],
  default_effort: "",
  hidden,
}));

// ── 远端目录解析 ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" && value ? value : "";
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 目录里**上游声明**的上下文窗口（`context_window_tokens{dev,max}`）。
 *
 * ⚠ 取两档的**较大者**：档位表报的是**能力上限**（与共享层「档位表取上限」一致）——
 * 只报 `dev`（默认档）会把 1M 档的模型误判成 200k。
 * ⚠ 上游没声明 → 0（= 未声明），不写渠道估值。
 */
function declaredContextWindow(value: unknown): number {
  const windows = isRecord(value) ? value : {};
  const dev = numberOr(windows["dev"], 0);
  const max = numberOr(windows["max"], 0);
  return Math.max(dev, max);
}

/** `display_contact_config` 是 JSON **字符串**，必须二次 parse。 */
function parseContactConfig(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 展示名带倍率（活动期 `名称 · x0.80→x0.08`；`rate === 0` 显示「免费」）。 */
function decorateName(base: string, contact: Record<string, unknown>): string {
  const rate = typeof contact["consumption_rate"] === "number" ? contact["consumption_rate"] : null;
  const discount =
    typeof contact["activity_discount"] === "number" ? contact["activity_discount"] : null;
  if (rate === null) return discount === null ? base : `${base} · x${discount.toFixed(2)}`;
  if (rate === 0) return `${base} · 免费`;
  if (discount !== null && discount !== rate) {
    return `${base} · x${discount.toFixed(2)}→x${rate.toFixed(2)}`;
  }
  return `${base} · x${rate.toFixed(2)}`;
}

/**
 * 从 `features`（JSON 字符串）提取消耗倍率。
 *
 * 基础倍率在 `consumption_rate`；活动期（`activity_discount.enable === true`）
 * 取 `data.current.consumption_rate`（折后生效价）。取不到返回 undefined（不猜）。
 */
function parseFeatureRate(features: unknown): number | undefined {
  const f = parseContactConfig(features);
  const ad = isRecord(f["activity_discount"]) ? (f["activity_discount"] as Record<string, unknown>) : null;
  if (ad && ad["enable"] === true) {
    const data = isRecord(ad["data"]) ? (ad["data"] as Record<string, unknown>) : null;
    const current = data && isRecord(data["current"]) ? (data["current"] as Record<string, unknown>) : null;
    if (typeof current?.["consumption_rate"] === "number") return current["consumption_rate"];
  }
  return typeof f["consumption_rate"] === "number" ? f["consumption_rate"] : undefined;
}

/**
 * 解析单个 config_info 条目；被硬过滤时返回 null。
 *
 * 硬过滤：usage（若给出且非 chat_completion）、config_switch === false、
 * is_invisible_to_user === true、is_custom_model === true。
 */
function parseConfigEntry(functionName: string, raw: unknown): ModelEntry | null {
  if (!isRecord(raw)) return null;
  const usage = nonEmpty(raw["usage"]);
  if (usage && usage !== "chat_completion") return null;
  if (raw["config_switch"] === false) return null;
  if (raw["is_invisible_to_user"] === true) return null;

  const display = isRecord(raw["display_config"]) ? raw["display_config"] : {};
  if (display["is_custom_model"] === true) return null; // 实测 5/5 报 4001

  const model = nonEmpty(raw["config_name"]);
  if (!model) return null;

  // context_window 取 max（有档位时更靠 max）；上游没声明就是 0（= 未声明）
  const contextWindow = declaredContextWindow(raw["context_window_tokens"]);

  // model_detail_list 的 __dev / __max 后缀区分档位明细
  // ⚠ 上游没给 __dev 明细时输出上限算**未声明**（0）—— 不写渠道估值，
  // 否则估值会挡住公开规格（见 modelSpec）。
  let maxOutput = 0;
  let maxMaxTokens: number | undefined;
  const details = raw["model_detail_list"];
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const name = nonEmpty(detail["model_name"]);
      const tokens = typeof detail["max_tokens"] === "number" ? detail["max_tokens"] : null;
      if (tokens === null) continue;
      if (name.endsWith("__max")) maxMaxTokens = tokens;
      else if (name.endsWith("__dev")) maxOutput = tokens;
    }
  }

  // 思考档位：options 是单值字符串（既展示名也是 wire 值），键序即展示顺序
  const reasoning = isRecord(raw["reasoning_effort_config"]) ? raw["reasoning_effort_config"] : {};
  const efforts = Array.isArray(reasoning["options"])
    ? reasoning["options"].filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];
  const defaultLevel = nonEmpty(reasoning["default_level"]);
  // ⚠ 默认档采信上游 default_level，但它可能不在 options 里（实测下发 'max'）——
  // 此时必须退到最强档（options 末位，键序即强度序），不能照抄。
  const defaultEffort = efforts.length
    ? efforts.includes(defaultLevel)
      ? defaultLevel
      : efforts[efforts.length - 1]!
    : "";

  const baseName = nonEmpty(display["display_name"]) || model;
  return {
    id: model,
    model,
    name: decorateName(baseName, parseContactConfig(raw["display_contact_config"])),
    function: functionName,
    context_window: contextWindow,
    max_output: maxOutput,
    max_max_tokens: maxMaxTokens,
    max_mode: display["max_mode"] === true,
    multimodal: display["multimodal"] === true,
    tiered: efforts.length > 0,
    efforts,
    default_effort: defaultEffort,
    hidden: false,
  };
}

/**
 * 解析 `batch_get_detail_param` 载荷。
 *
 * 白名单外的通道**整组丢弃**；白名单内按合并规则去重。
 */
export function parseRemoteCatalog(payload: Record<string, unknown>): ModelEntry[] {
  const configs = payload["function_configs"];
  if (!Array.isArray(configs)) return [];
  const byFunction = new Map<string, unknown[]>();
  for (const item of configs) {
    if (!isRecord(item)) continue;
    const fn = nonEmpty(item["function"]);
    const list = item["config_info_list"];
    if (!fn || !Array.isArray(list)) continue;
    byFunction.set(fn, [...(byFunction.get(fn) ?? []), ...list]);
  }

  const merged = new Map<string, ModelEntry>();
  for (const fn of channelWhitelist()) {
    for (const raw of byFunction.get(fn) ?? []) {
      const entry = parseConfigEntry(fn, raw);
      if (!entry) continue;
      const existing = merged.get(entry.id);
      if (!existing) {
        merged.set(entry.id, entry);
        continue;
      }
      // ① 空档位不得覆盖有档位
      if (!existing.tiered && entry.tiered) {
        merged.set(entry.id, entry);
        continue;
      }
      // ② 两侧都有档位时取更靠前者（白名单顺序即优先级）⇒ 保持 existing
      if (existing.tiered && entry.tiered) continue;
      // ③ 其余「后覆盖前」
      merged.set(entry.id, entry);
    }
  }
  return [...merged.values()];
}

/** 远端目录缓存（由 `mergeRemote` 写入；`refreshRemote` 在调用方拼装）。 */
let remoteCache: ModelEntry[] | null = null;
let cacheLoaded = false;

/**
 * 首次使用时把**磁盘缓存**（`cache/models.json`）读进来。
 *
 * 惰性而非模块加载时读：`channelFile()` 依赖渠道已注册，而 `channel.ts` 是在
 * import 本模块**之后**才注册的。没有磁盘缓存时行为与以前一致（往下走文件/兜底表）。
 */
function ensureCachedModels(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const cached = readCatalogCache<ModelEntry>();
    if (cached) remoteCache = cached;
  } catch {
    /* 读不到就继续走文件/兜底表 */
  }
}

/**
 * 灌入远端目录（由 `refreshCatalog` 拉到后调用）。
 *
 * 同时**落盘**到 `cache/models.json` —— 否则换个新进程就只剩兜底表（实测过这个坑）。
 */
export function mergeRemote(entries: ModelEntry[]): void {
  remoteCache = entries.length > 0 ? entries : null;
  cacheLoaded = true;
  if (entries.length > 0) writeCatalogCache(entries);
}

/** 清空远端缓存（仅测试/重登时用）。 */
export function resetRemoteCache(): void {
  remoteCache = null;
}

/**
 * 从 `features`（JSON 字符串）提取消耗倍率。
 *
 * 实测顶层 `consumption_rate` 是**对象** `{enable:true, data:{rate:0.8}}`；
 * 活动开启时（`activity_discount.enable`）优先取 `data.current.consumption_rate`
 * 的折后值（实测 subsidy 活动 0.4→0.2）。兼容裸数字的旧形态。
 * 解析不出数字返回 undefined（不猜）。
 */
function rateFromFeatures(features: unknown): number | undefined {
  const parsed = parseContactConfig(features);
  const activity = isRecord(parsed["activity_discount"]) ? parsed["activity_discount"] : undefined;
  if (activity?.["enable"] === true) {
    const data = isRecord(activity["data"]) ? activity["data"] : undefined;
    const current = data && isRecord(data["current"]) ? data["current"] : undefined;
    const discounted = current?.["consumption_rate"];
    if (typeof discounted === "number" && Number.isFinite(discounted)) return discounted;
  }
  const base = parsed["consumption_rate"];
  if (typeof base === "number" && Number.isFinite(base)) return base;
  if (isRecord(base)) {
    const inner = isRecord(base["data"]) ? base["data"]["rate"] : undefined;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  }
  return undefined;
}

/**
 * 解析 Remote 网页目录载荷（协议 §5.0）：
 * `{data:{list:[{function, models:[{name,…}]}]}}` —— 三组模型按载荷里的组序合并，
 * 同名后不覆盖前（**先出现的组胜出**；实测载荷顺序是 design → work → agent）。
 *
 * ⚠ **上下文窗口取各组声明的最大值**：同一个模型在三组里的窗口档位不同
 * （实测 `Doubao-Seed-2.1-Pro`：`solo_design_remote` 232768 / `solo_work_remote`
 * 256000 / `solo_agent_remote` 256000 **+ max 档 1000000**），
 * 只取先出现的那组会丢掉 1M 档 —— 对客户端报**能力上限**更准
 * （与共享层「档位表取上限」一致）。
 * ⚠ 通道（`function`）等其余字段仍取**先出现**的那组（改动会改变请求路由）。
 *
 * ⚠ Remote 目录**不下发输出上限** ⇒ `max_output` = 0（未声明），
 * 数值由 `modelSpec` 按公开规格补。
 */
export function parseWebCatalog(payload: Record<string, unknown>): ModelEntry[] {
  const list = (payload["data"] as Record<string, unknown> | undefined)?.["list"];
  if (!Array.isArray(list)) return [];
  const entries: ModelEntry[] = [];
  const byName = new Map<string, ModelEntry>();
  for (const group of list) {
    if (!isRecord(group)) continue;
    const models = group["models"];
    if (!Array.isArray(models)) continue;
    for (const raw of models) {
      if (!isRecord(raw)) continue;
      const name = nonEmpty(raw["name"]);
      if (!name) continue;
      const declared = declaredContextWindow(raw["context_window_tokens"]);
      const existing = byName.get(name);
      if (existing) {
        if (declared > existing.context_window) existing.context_window = declared;
        continue;
      }
      const entry: ModelEntry = {
        id: name,
        model: name,
        name,
        function: nonEmpty(group["function"]) ?? nonEmpty(group["agent_type"]) ?? "solo_agent_remote",
        context_window: declared,
        max_output: 0, // Remote 目录不下发输出上限 → 未声明
        multiplier: rateFromFeatures(raw["features"]),
        max_mode: false,
        multimodal: false,
        tiered: false,
        efforts: [],
        default_effort: "",
        hidden: false,
      };
      byName.set(name, entry);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 与自动路径的区别：**失败抛错**。用户显式要求刷新时必须知道成没成，
 * 而不是看到一张旧表还以为刷成功了。
 *
 * 主来源是 Remote 网页目录（§5.0）；Remote 拿不到时回落 Solo batch（§5.1，
 * 对新账号通常已 2001，仅对老账号兜底）。
 */
export async function refresh(): Promise<void> {
  // 动态 import：避免 catalog ↔ upstream/cred 的静态环
  const [upstream, cred] = await Promise.all([import("./upstream.js"), import("./cred.js")]);
  const c = cred.load();
  try {
    const payload = await upstream.fetchRemoteModels(c);
    const entries = parseWebCatalog(payload);
    if (entries.length > 0) {
      mergeRemote(entries);
      return;
    }
  } catch {
    /* Remote 失败：回落 Solo 目录 */
  }
  const payload = await upstream.fetchModels(c);
  const entries = parseRemoteCatalog(payload);
  if (entries.length === 0) throw new Error("Upstream returned an empty model catalog (or every channel was filtered out by the whitelist)");
  mergeRemote(entries);
}

// ── models.json 兜底与对外接口 ───────────────────────────────────────────────

interface FileCacheEntry {
  key: string;
  catalog: ModelEntry[];
}

let fileCache: FileCacheEntry | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["TRAE_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function parseCatalogFile(path: string): ModelEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(data)) return [];
  const models = data["models"];
  if (!Array.isArray(models)) return [];

  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!isRecord(model)) continue;
    const slug = nonEmpty(model["slug"]);
    if (!slug) continue;
    const id = nonEmpty(model["alias"]) || nonEmpty(model["short"]) || slug;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      model: slug,
      name: nonEmpty(model["name"]) || slug,
      function: nonEmpty(model["function"]) || nonEmpty(model["channel"]) || DEFAULT_FUNCTION,
      context_window: numberOr(model["context_window"], 0),
      max_output: numberOr(model["max_output"], 0),
      max_mode: model["max_mode"] === true,
      multimodal: model["multimodal"] === true,
      tiered: false,
      efforts: [],
      default_effort: "",
      hidden: model["hidden"] === true,
    });
  }
  return entries;
}

/** 当前目录（远端缓存 → models.json → 兜底表）。 */
export function loadCatalog(): ModelEntry[] {
  ensureCachedModels();
  if (remoteCache) return remoteCache.map((e) => ({ ...e }));
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (fileCache && fileCache.key === key) return fileCache.catalog.map((e) => ({ ...e }));
    const entries = parseCatalogFile(path);
    if (entries.length > 0) {
      fileCache = { key, catalog: entries };
      return entries.map((e) => ({ ...e }));
    }
  }
  return FALLBACK_MODELS.map((e) => ({ ...e }));
}

/**
 * **远端**目录条目（磁盘缓存 / `mergeRemote` 灌入的那份）。
 *
 * ⚠ **不含**内置兜底表与 models.json 快照 —— 那两份不是上游声明，
 * 里面的数值只是估值，不能当「上游声明」用（见 `modelSpec` 的优先级）。
 */
function remoteEntries(): ModelEntry[] {
  ensureCachedModels();
  return remoteCache ?? [];
}

/** 对外暴露的模型 ID 列表（隐藏条目不在其中）。 */
export function exposedIds(): string[] {
  return loadCatalog()
    .filter((e) => !e.hidden)
    // `custom_model_*` 是官方客户端的「自定义模型」模板占位（让用户填自己的
    // endpoint），**不是可调用模型** —— 实测选中它们 5/5 报 `4001 param is invalid`。
    // 列出来只会让用户点到必然失败的条目，故排除。
    .filter((e) => !e.id.startsWith("custom_model"))
    .map((e) => e.id);
}

/** 短名 → 上游 config_name；未知名称原样透传。 */
export function resolveModel(name: string): string {
  const entries = loadCatalog();
  for (const entry of entries) {
    if (entry.id === name || entry.model === name) return entry.model;
  }
  const folded = name.toLowerCase();
  for (const entry of entries) {
    if (entry.id.toLowerCase() === folded || entry.model.toLowerCase() === folded) return entry.model;
  }
  return name;
}

/** 取模型所属通道（请求体 `function` 字段）；未知回退缺省通道。 */
export function channelFor(name: string): string {
  const entries = loadCatalog();
  for (const entry of entries) {
    if (entry.id === name || entry.model === name) return entry.function;
  }
  const folded = name.toLowerCase();
  for (const entry of entries) {
    if (entry.model.toLowerCase() === folded) return entry.function;
  }
  return DEFAULT_FUNCTION;
}

/** 目录条目提示（供 buildChatBody 的 Max 模式成套下发）。 */
export function entryFor(name: string): ModelEntry | null {
  const entries = loadCatalog();
  return (
    entries.find((e) => e.id === name || e.model === name) ??
    entries.find((e) => e.model.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

/**
 * 供状态页/UI 使用的目录详情。
 *
 * ⚠ 窗口 / 输出上限报**生效值**：上游声明优先，其次公开规格（`modelSpec`）——
 * 与 `/v1/models` 的口径一致（上游没声明时目录条目里是 0）。
 */
export function details(): Array<Record<string, unknown>> {
  return loadCatalog()
    .filter((e) => !e.hidden)
    .map((e) => {
      const spec = modelSpec(e.id);
      return {
        id: e.id,
        name: e.name,
        model: e.model,
        function: e.function,
        context_window: e.context_window > 0 ? e.context_window : (spec?.contextWindow ?? 0),
        max_output: e.max_output > 0 ? e.max_output : (spec?.maxOutputTokens ?? 0),
        max_max_tokens: e.max_max_tokens ?? null,
        max_mode: e.max_mode,
        tiered: e.tiered,
        efforts: e.efforts,
        default_effort: e.default_effort,
      };
    });
}

/** 仅供测试：清空 models.json 缓存。 */
export function clearCache(): void {
  fileCache = null;
}
