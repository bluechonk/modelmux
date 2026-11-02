/**
 * LobsterAI 模型目录：远端模型列表的解析、缓存与用户目录模型表。
 *
 * 关键约束（端点/字段/实测见 docs/channels/lobsterai/PROTOCOL.md）：
 *   - 模型数据（清单 / 窗口 / 输出上限）**在 `models.json`**，代码里不留；首启浇种到
 *     `<root>/channels/lobsterai/models.json`，之后以用户文件为准。
 *   - 远端权威：拉到后写磁盘缓存供新进程直接读（`setRemoteModels`）。
 *   - 产品档位名与服务端 wire 档位不可混用（含 max 的档位需换算），映射缺失时按既定规则兜底（见 reasoningEffortWire）。
 *   - 读取惰性：模块加载期读盘会踩空（channelFile 要求渠道已注册）。
 */

import {
  canonicalModelId,
  ensureChannelModels,
  readCatalogCache,
  writeCatalogCache,
} from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

/** 一条目录条目。 */
interface ModelEntry {
  id: string;
  name: string;
  /** 上下文窗口；兜底表统一填 131072（**桥接层估计值，非逐个实测**）。 */
  context_window: number;
  /**
   * 最大输出 token。
   *
   * 上游 `/api/models/available` **不下发**该字段（实测 2026-10-23：响应里没有 `maxTokens`），
   * 所以只能按公开规格补（`MAX_OUTPUTS`，来源见 `docs/channels/lobsterai/PROTOCOL.md` §9「模型窗口规格」）。
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

let remoteCache: ModelEntry[] | null = null;
let cacheLoaded = false;

/**
 * 用户目录模型表（`channels/lobsterai/models.json`，首启由随包种子浇种）。
 *
 * 模型清单、上下文窗口与最大输出**都是数据**，代码里不保留；这里只做「读 + 归一化」。
 */
let seeded: ModelEntry[] | null = null;
function seedEntries(): ModelEntry[] {
  if (!seeded) {
    seeded =
      ensureChannelModels<ModelEntry>(undefined, [
        bundledSnapshotPath(),
        packageSnapshotPath(import.meta.url),
      ]) ?? [];
  }
  return seeded;
}

/** 按归一化 id 取表内条目（上游写法与池写法不同，先归一）。 */
function entryOf(id: string): ModelEntry | undefined {
  const key = canonicalModelId(id);
  return seedEntries().find(
    (e) => canonicalModelId(e.id) === key || canonicalModelId(e.name) === key,
  );
}

/** 兜底条目：表内数据的拷贝（调用方改了不污染缓存）。 */
function fallbackEntries(): ModelEntry[] {
  return seedEntries().map((e) => ({ ...e }));
}

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
        const maxOutput = entryOf(entry.id)?.max_output;
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
 * `costMultiplier` 是**裸数字**（实测 0.05 / 1.08 / 20）——
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
      context_window: num(rec["contextWindow"]) ?? entryOf(id)?.context_window ?? 0,
      source: "remote",
    };
    const maxOutput = num(rec["maxTokens"]) ?? entryOf(id)?.max_output;
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

/** 当前生效的目录：远端优先，未拉到时用用户目录模型表（缺失则用代码内种子浇种）。 */
function entries(): ModelEntry[] {
  ensureCachedModels();
  return remoteCache && remoteCache.length > 0 ? [...remoteCache] : fallbackEntries();
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * 规格**是数据**，落在 `models.json` 的 `contextWindow` / `maxOutput`；本函数只做查表。
 * `modelId` 是池内的归一化 id，查表前再归一一次（上游与池写法不同）。查不到返回 undefined。
 */
export function modelSpec(
  modelId: string,
):
  | { contextWindow?: number; maxOutputTokens?: number }
  | undefined {
  const entry = entryOf(modelId);
  if (!entry) return undefined;
  return {
    ...(entry.context_window !== undefined ? { contextWindow: entry.context_window } : {}),
    ...(entry.max_output !== undefined ? { maxOutputTokens: entry.max_output } : {}),
  };
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
