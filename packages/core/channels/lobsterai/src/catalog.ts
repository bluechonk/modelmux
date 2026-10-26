/**
 * LobsterAI 模型目录：远端模型列表的解析、缓存与兜底表。
 *
 * 关键约束（端点/字段/实测见 docs/channels/lobsterai/PROTOCOL.md）：
 *   - 兜底表是快照、不能替代远端；远端权威，拉到后写磁盘缓存供新进程直接读（setRemoteModels）。
 *   - 产品档位名与服务端 wire 档位不可混用（含 max 的档位需换算），映射缺失时按既定规则兜底（见 reasoningEffortWire）。
 *   - 读取惰性：模块加载期读盘会踩空（channelFile 要求渠道已注册）。
 */

import { canonicalModelId, readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

/** 一条目录条目。 */
interface ModelEntry {
  id: string;
  name: string;
  /** 上下文窗口；兜底表统一填 131072（**桥接层估计值，非逐个实测**）。 */
  context_window: number;
  /**
   * 最大输出 token。
   *
   * ⚠ 上游 `/api/models/available` **不下发**该字段（实测响应里没有 `maxTokens`），
   * 所以只能按公开规格补（`MAX_OUTPUTS`，来源见 `docs/MODEL-SPECS.md`）。
   */
  max_output?: number;
  supports_image?: boolean;
  supports_thinking?: boolean;
  /** 产品侧档位名（含 `max`），仅展示用。 */
  efforts?: string[];
  /** 档位名 → 服务端 wire 值（`openclawLevel`）。 */
  efforts_wire?: Record<string, string>;
  default_effort?: string;
  cost_multiplier?: number;
  description?: string;
  capabilities?: string[];
  source: "fallback" | "remote";
}

/**
 * 兜底目录：**未登录 / 上游拉不到时**给用户看的那份。
 *
 * ⚠ 这是**快照**不是实时数据：内容来自一次真实拉取
 * （`upstream.fetchModels()`）。真机拉到远端后会用远端目录覆盖它，
 * 并落盘到 `cache/models.json`（见共享层 `catalog-cache.ts`）——
 * 所以正常使用时看到的**不是**这张表。
 *
 * 顺序照抄上游返回顺序，不重排 —— 重排会让「与上游对比」失去可比性。
 * 不含 `costMultiplier`：编译期快照，价格会变，不猜。
 */
const FALLBACK: readonly string[] = [
  "deepseek-flash",
  "deepseek-v4-pro",
  "glm-5.3-flashx",
  "glm-5.3-flash",
  "glm-5.3",
  "MiniMax-M3.1-Flash-Preview",
  "MiniMax-M3",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.8-omni-flash",
  "kimi-k3",
  "kimi-k2.8-preview",
  "kimi-k2.7-code",
  "doubao-seed-2-1-pro-260915",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-flash",
  "MiniMax-M2.7",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus-2026-04-20",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "glm-5",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-2-0-code-preview-260215",
];

/** 兜底上下文窗口估计值（统一填，非逐个实测）。 */
const FALLBACK_CONTEXT_WINDOW = 131_072;

/**
 * 已知模型的**最大输出 token**（上游目录不下发，按公开规格补）。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回 400）—— 客户端应能降档重试。
 * 数值与来源见 `docs/MODEL-SPECS.md`（唯一事实源；渠道表在本文件的 `MAX_OUTPUTS`）。
 */
const MAX_OUTPUTS: Readonly<Record<string, number>> = {
  "deepseek-flash": 393_216,
  "deepseek-v4-flash": 393_216,
  "deepseek-v4-flash-vision-exp": 393_216,
  "deepseek-v4-pro": 393_216,
  "doubao-seed-2.0-code-preview": 131_072,
  "doubao-seed-2.1-pro": 262_144,
  "doubao-seed-2.1-turbo": 262_144,
  "glm-4.7": 131_072,
  "glm-5": 131_072,
  "glm-5.1": 131_072,
  "glm-5.2": 131_072,
  "glm-5.3": 131_072,
  "glm-5.3-flash": 131_072,
  "glm-5.3-flashx": 131_072,
  "glm-5v-turbo": 131_072,
  "kimi-k2.6": 32_768,
  "kimi-k2.7-code": 32_768,
  "kimi-k2.7-code-highspeed": 32_768,
  "kimi-k3": 1_048_576,
  "minimax-m2.7": 131_072,
  "minimax-m3": 131_072,
  "minimax-m3.1-flash": 524_288,
  "qwen3.5-plus": 65_536,
  "qwen3.6-plus": 65_536,
  "qwen3.7-max": 131_072,
  "qwen3.7-plus": 131_072,
  "qwen3.8-flash": 131_072,
  "qwen3.8-max": 131_072,
  "qwen3.8-omni-flash": 131_072,
};

/**
 * 取已知最大输出：按**归一化 id** 查表，再剥掉发布日后缀试一次。
 *
 * ⚠ 上游 id 与池 id 写法不同（上游 `doubao-seed-2-1-pro-260915` / 池 `doubao-seed-2.1-pro-260915`），
 * 故先过一遍 `canonicalModelId` 再查表；发布日（`-260915` / `-2026-04-20`）再剥一层。
 */
function maxOutputOf(id: string): number | undefined {
  const key = canonicalModelId(id);
  const exact = MAX_OUTPUTS[key];
  if (exact !== undefined) return exact;
  return MAX_OUTPUTS[key.replace(/-\d{6}$/, "").replace(/-\d{4}[-.]\d{2}[-.]\d{2}$/, "")];
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（上游 `doubao-seed-2-1-pro-260915` → 池
 * `doubao-seed-2.1-pro-260915`），故按归一化形态 + 去发布日后缀查表。
 * **查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = maxOutputOf(modelId);
  if (maxOutputTokens === undefined) return undefined;
  return { maxOutputTokens };
}

/** 兜底条目（id 与展示名相同）。 */
const FALLBACK_MODELS: readonly ModelEntry[] = FALLBACK.map((id) => ({
  id,
  name: id,
  context_window: FALLBACK_CONTEXT_WINDOW,
  ...(maxOutputOf(id) !== undefined ? { max_output: maxOutputOf(id) } : {}),
  source: "fallback" as const,
}));

let remoteCache: ModelEntry[] | null = null;
let cacheLoaded = false;

/**
 * 首次使用时把**磁盘缓存**（`cache/models.json`）读进来。
 *
 * 惰性而非模块加载时读：`channelFile()` 依赖渠道已注册（`setChannel`），而
 * `channel.ts` 是在 import 本模块**之后**才注册的 —— 模块加载时读会抛错。
 */
function ensureCachedModels(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const cached = readCatalogCache<ModelEntry>();
    // 旧缓存没有 max_output（那是后来按公开规格补的）—— 读时补上，不必等一次刷新。
    if (cached) {
      remoteCache = cached.map((entry) => {
        if (entry.max_output !== undefined) return entry;
        const maxOutput = maxOutputOf(entry.id);
        return maxOutput === undefined ? entry : { ...entry, max_output: maxOutput };
      });
    }
  } catch {
    /* 读不到就回落兜底表 */
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    // 本渠道实测是**裸数字**（0.05 / 1.08 / 20）；buddy 那是 `"x0.05"` 字符串形态，
    // 这里也容忍 `x` 前缀，免得同一个字段两种来源两种行为。
    const text = value.trim().replace(/^[xX]/, "");
    const parsed = Number.parseFloat(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 解析 `thinkingConfig`：把产品档位名与 wire 值分开。
 *
 * 缺失 `openclawLevel` 时该档位不进 `efforts_wire`（宁可不认，也不把
 * `level` 当 wire 值发出去 —— 那正是 `max` 会踩的坑）。
 */
function parseThinkingConfig(raw: unknown): {
  efforts?: string[];
  efforts_wire?: Record<string, string>;
  default_effort?: string;
} {
  if (!raw || typeof raw !== "object") return {};
  const cfg = raw as Record<string, unknown>;
  const options = Array.isArray(cfg["options"]) ? cfg["options"] : [];
  const efforts: string[] = [];
  const wire: Record<string, string> = {};
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const level = str((option as Record<string, unknown>)["level"]);
    if (!level) continue;
    efforts.push(level);
    const openclaw = str((option as Record<string, unknown>)["openclawLevel"]);
    if (openclaw) wire[level] = openclaw;
  }
  const result: ReturnType<typeof parseThinkingConfig> = {};
  if (efforts.length > 0) result.efforts = efforts;
  if (Object.keys(wire).length > 0) result.efforts_wire = wire;
  const defaultLevel = str(cfg["defaultLevel"]);
  if (defaultLevel) result.default_effort = defaultLevel;
  return result;
}

/**
 * 解析远端模型行。
 *
 * 只取协议列出的字段（`modelId` / `modelName` / `contextWindow` / `maxTokens` /
 * `supportsImage` / `supportsThinking` / `thinkingConfig` / `requestCapabilities` /
 * `description` / `costMultiplier`）；**刻意不取** `provider` / `apiFormat` /
 * `runtimeProfile`（那是 IDE 内部的运行时画像，桥接层用不到）。
 *
 * ⚠️ `costMultiplier` 是**裸数字**（实测 0.05 / 1.08 / 20）——
 * 与 buddy 的字符串 `"x0.05"` 形态不同，这里两种都容忍。
 */
export function parseRemoteModels(rows: readonly unknown[]): ModelEntry[] {
  const seen = new Set<string>();
  const entries: ModelEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = str(rec["modelId"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry: ModelEntry = {
      id,
      name: str(rec["modelName"]) || id,
      // 远端没给窗口时用兜底估计值（列表里恒有窗口，比留 0 更有用）。
      context_window: num(rec["contextWindow"]) ?? FALLBACK_CONTEXT_WINDOW,
      source: "remote",
    };
    const maxOutput = num(rec["maxTokens"]) ?? maxOutputOf(id);
    if (maxOutput !== undefined) entry.max_output = maxOutput;
    if (typeof rec["supportsImage"] === "boolean") entry.supports_image = rec["supportsImage"];
    if (typeof rec["supportsThinking"] === "boolean") entry.supports_thinking = rec["supportsThinking"];
    const thinking = parseThinkingConfig(rec["thinkingConfig"]);
    if (thinking.efforts) entry.efforts = thinking.efforts;
    if (thinking.efforts_wire) entry.efforts_wire = thinking.efforts_wire;
    if (thinking.default_effort) entry.default_effort = thinking.default_effort;
    const multiplier = num(rec["costMultiplier"]);
    if (multiplier !== undefined) entry.cost_multiplier = multiplier;
    const description = str(rec["description"]);
    if (description) entry.description = description;
    if (Array.isArray(rec["requestCapabilities"])) {
      entry.capabilities = rec["requestCapabilities"].filter(
        (v): v is string => typeof v === "string",
      );
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 灌入远端目录（由 `upstream.fetchModels` 在拉到列表后调用）。
 *
 * 同时**落盘**到 `cache/models.json`：否则换个新进程就只剩兜底表（实测过这个坑）。
 */
export function setRemoteModels(entries: readonly ModelEntry[]): void {
  remoteCache = entries.length > 0 ? [...entries] : null;
  cacheLoaded = true;
  if (entries.length > 0) writeCatalogCache(entries);
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 解析与落盘已在 `upstream.fetchModels()` 里完成（它调 `setRemoteModels()`），
 * 这里只负责「要一次真实的拉取，并且失败要抛出去」。
 *
 * 与自动路径的区别：**失败抛错**。用户显式要求刷新时必须知道成没成，
 * 而不是看到一张旧表还以为刷成功了。
 */
export async function refresh(): Promise<void> {
  // 动态 import：`upstream.ts` 静态依赖本模块（它调 `setRemoteModels`），
  // 这里再静态反向依赖会形成环。函数体内延迟取，运行时两边都已求值完毕。
  const [upstream, cred] = await Promise.all([import("./upstream.js"), import("./cred.js")]);
  const c = cred.load();
  const data = await upstream.fetchModels(c);
  const models = data["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("upstream returned an empty model catalog");
  }
}

/** 当前生效的目录：远端优先，未拉到时用兜底表。 */
function entries(): ModelEntry[] {
  ensureCachedModels();
  return remoteCache && remoteCache.length > 0 ? [...remoteCache] : [...FALLBACK_MODELS];
}

/** 按 id 取条目；不存在返回 null（不编造）。 */
export function entryFor(id: string): ModelEntry | null {
  return entries().find((entry) => entry.id === id) ?? null;
}

/** 对外暴露的模型 id（短名；本渠道短名即上游 id）。 */
export function exposedIds(): string[] {
  // 全模型池：catalog 内全部模型都对外暴露。
  return entries().map((entry) => entry.id);
}

/**
 * 短名 → 上游 slug。
 *
 * LobsterAI 的上游 id 就是短名（没有 buddy 那种 alias 层），故这里是恒等映射；
 * 保留该函数是为了满足契约，并给「兜底表里没有、但远端有」的 id 一个明确通路
 * ——未知名**原样返回**，由上游自己判定。
 */
export function resolveModel(name: string): string {
  return name;
}

/**
 * `reasoning_effort` 的 wire 值换算。
 *
 * 产品档位名可能含 `max`（UI 档位），而服务端只认 `openclawLevel`
 * （`off/minimal/low/medium/high/xhigh`）。优先用该模型的映射表；
 * 没有映射表时只做一处**有实测依据**的兜底：`max` → `xhigh`
 * （远端实测的映射），其余原样返回。
 */
export function reasoningEffortWire(model: string, level: string): string {
  const entry = entryFor(model);
  const mapped = entry?.efforts_wire?.[level];
  if (mapped) return mapped;
  return level === "max" ? "xhigh" : level;
}
