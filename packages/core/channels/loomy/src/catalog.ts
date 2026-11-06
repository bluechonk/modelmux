/**
 * Loomy 模型目录：倍率归一化、远端目录缓存与档位注册。
 *
 * 关键约束（端点/字段/实测见 docs/channels/loomy/PROTOCOL.md）：
 *   - 倍率在模型名字符串里（无独立字段），三种括号风格混用，必须归一化且只认末尾的倍率。
 *   - 过滤判据是模型类型（chat），不能按图片能力字段过滤；远端档位要清洗，默认档用本插件自己的 high。
 *   - 目录是「快照 + 异步刷新」：exposedIds 同步返回当前快照，首次访问触发后台刷新，失败保留上次快照。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";
import { ensureChannelModels, hiddenModelIds, readCatalogCache, writeCatalogCache } from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

/** 档位词表（展示名必须与官方 IDE 一致 —— Loomy 基于 opencode 构建）。 */
const EFFORT_VOCABULARY = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 本插件自己的默认档（**不采信**远端的 `default_reasoning_effort`）。 */
const DEFAULT_EFFORT = "high";

/** 档位排序（用于挑「最接近 high」的档位）。 */
const EFFORT_RANK: string[] = [...EFFORT_VOCABULARY];


/** 远端目录成功结果的缓存时长。 */
const REMOTE_TTL_MS = 5 * 60 * 1000;
/** 远端失败/空结果的冷却时长。 */
const REMOTE_FAIL_COOLDOWN_MS = 30 * 1000;

interface FallbackModel {
  id: string;
  name: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string;
}

/** 一条目录条目。 */
interface CatalogEntry {
  id: string;
  name: string;
  rate: string;
  /** 消耗倍率数值（由 `rate` 字符串解析，失败为 undefined）。供 `model_info.multiplier` 使用。 */
  multiplier?: number;
  contextWindow: number;
  /** 最大输出 token（远端不下发，按用户目录模型表补）。 */
  maxOutput?: number;
  reasoning: boolean;
  vision: boolean;
  efforts: string[];
  defaultEffort: string;
  /** 远端声明的默认档，仅留作排查（**不采信**）。 */
  remoteDefaultEffort: string;
  source: "remote" | "fallback";
}

/**
 * 用户目录模型表（`channels/loomy/models.json`，首启由随包种子浇种）。
 *
 * 清单、窗口、输出上限、档位**都是数据**；代码只做「读 + 归一化」。
 */
let seedCache: CatalogEntry[] | undefined;
function seedTable(): CatalogEntry[] {
  if (!seedCache) {
    seedCache =
      ensureChannelModels<CatalogEntry>(undefined, [
        bundledSnapshotPath(),
        packageSnapshotPath(import.meta.url),
      ]) ?? [];
  }
  return seedCache.map((e) => ({ ...e, efforts: [...e.efforts] }));
}

/** 按 id 取表内条目（小写比较）。 */
function rowOf(id: string): CatalogEntry | undefined {
  return seedTable().find((e) => e.id.toLowerCase() === id.toLowerCase());
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（如上游的 `DeepSeek-V4.1-Flash` → `deepseek-v4.1-flash`），
 * 故查表前先小写化。**查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const row = rowOf(modelId);
  if (!row || row.maxOutput === undefined) return undefined;
  return { maxOutputTokens: row.maxOutput };
}

interface Snapshot {
  entries: CatalogEntry[];
  catalogVersion: string;
}

let snapshot: Snapshot | null = null;
/** 本进程是否已自动刷过一次（保持「每进程只刷一次」的原有语义）。 */
let refreshAttempted = false;
let remoteCache: { entries: CatalogEntry[]; version: string; at: number } | null = null;
let refreshing = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

// ── 倍率归一化 ────────────────────────────────────────────────────────────────

const TRAILING_PAREN_RATE = /^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$/i;
const NORMALIZED_RATE = /^(.*?)\s*·\s*(x\s*[\d.]+)\s*$/i;

/** 拆分末尾倍率 → `[主体, 倍率]`（无倍率时倍率为空串）。 */
function splitRate(name: string): [string, string] {
  const paren = TRAILING_PAREN_RATE.exec(name);
  if (paren?.[1]?.trim()) return [paren[1].trim(), paren[2]!.replace(/\s+/g, "")];
  const normalized = NORMALIZED_RATE.exec(name);
  if (normalized?.[1]?.trim()) return [normalized[1].trim(), normalized[2]!.replace(/\s+/g, "")];
  // 主体为空（畸形数据）→ 原样保留
  return [name, ""];
}

/** 展示名：`{name} · {rate}`（无倍率时不追加分隔符）；幂等。 */
function displayName(name: string): string {
  const [base, rate] = splitRate(name);
  return rate ? `${base} · ${rate}` : name;
}

// ── 远端解析 ──────────────────────────────────────────────────────────────────

/** 清洗远端档位：只留词表内的字符串、去重、保持顺序。 */
function cleanEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!(EFFORT_VOCABULARY as readonly string[]).includes(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

/** 默认档必须落在该模型的 efforts 内；efforts 为空时退回 `high`。 */
function pickDefaultEffort(efforts: string[]): string {
  if (efforts.length === 0) return DEFAULT_EFFORT;
  if (efforts.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  const highRank = EFFORT_RANK.indexOf(DEFAULT_EFFORT);
  let best = efforts[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const effort of efforts) {
    const distance = Math.abs(EFFORT_RANK.indexOf(effort) - highRank);
    if (distance < bestDistance) {
      best = effort;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 解析模型数组：**只保留 `type === 'chat'`**，过滤脏数据。
 *
 * 图片能力来自 `capabilities.input_modalities` 含 `image`；`capabilities.reasoning`
 * 必须**严格 `=== true`**（字符串 `'yes'` 不算）；兜底表不声明图片能力（宁可少报）。
 *
 * 上游新旧格式由 `parseModelsResponse()` 统一收敛：旧格式读 `data.models`（包在信封里），
 * 新格式读顶层 `data` 数组。本函数只见模型数组，不感知信封。
 */
function parseRemoteModels(models: unknown[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  if (!Array.isArray(models)) return entries;

  for (const item of models) {
    if (!isRecord(item)) continue;
    // 过滤判据是 type === 'chat'，不能看 input_modalities
    if (item["type"] !== "chat") continue;
    const id = str(item["id"]);
    if (!id) continue;
    const capabilities = isRecord(item["capabilities"]) ? item["capabilities"] : {};
    const modalities = capabilities["input_modalities"];
    const vision =
      Array.isArray(modalities) &&
      modalities.some((m) => String(m).toLowerCase() === "image");
    const remoteEfforts = cleanEfforts(item["reasoning_efforts"]);
    const fallback = rowOf(id);
    const efforts = remoteEfforts.length > 0 ? remoteEfforts : (fallback?.efforts ?? []);
    // 最大输出：上游 `max_output_tokens` 优先（实测 2026-10-23：spark-x2.6 131072、
    // MiniMax-M3 512000、DeepSeek-V4.1-Flash 384000），上游没给才回落公开规格表
    const remoteMaxOutput = num(item["max_output_tokens"]);
    const rawName = str(item["name"]) || id;
    const [, rate] = splitRate(rawName);
    const multiplier = rate ? Number.parseFloat(rate.replace(/^x/i, "")) : undefined;
    entries.push({
      id,
      name: displayName(rawName),
      rate,
      ...(multiplier !== undefined && Number.isFinite(multiplier) ? { multiplier } : {}),
      contextWindow: num(item["context_length"]) || fallback?.contextWindow || 0,
      ...((remoteMaxOutput || rowOf(id)?.maxOutput) !== undefined
        ? { maxOutput: remoteMaxOutput || rowOf(id)?.maxOutput }
        : {}),
      reasoning: capabilities["reasoning"] === true,
      vision,
      efforts,
      defaultEffort: pickDefaultEffort(efforts),
      remoteDefaultEffort: str(item["default_reasoning_effort"]),
      source: "remote",
    });
  }
  return entries;
}

/**
 * 兜底条目（每次现算一份拷贝，永不被当成「已加载的远端目录」）。
 *
 * 数据在 `<root>/channels/loomy/models.json`（首启由随包种子浇种），代码里不留。
 */
function fallbackEntries(): CatalogEntry[] {
  return seedTable();
}

/** 代码内种子 → 目录条目的固定换算（倍率从展示名里的 `xN.N` 取）。 */
function toCatalogEntry(m: FallbackModel): CatalogEntry {
  const rate = splitRate(m.name)[1];
  const multiplier = rate ? Number.parseFloat(rate.replace(/^x/i, "")) : undefined;
  return {
    id: m.id,
    name: m.name,
    rate,
    ...(multiplier !== undefined && Number.isFinite(multiplier) ? { multiplier } : {}),
    contextWindow: m.contextWindow,
    ...(rowOf(m.id)?.maxOutput !== undefined
      ? { maxOutput: rowOf(m.id)?.maxOutput }
      : {}),
    reasoning: true,
    vision: false, // 兜底不声明图片能力（宁可少报）
    efforts: [...m.efforts],
    defaultEffort: m.defaultEffort,
    remoteDefaultEffort: "",
    source: "fallback" as const,
  };
}

/** 把档位登记进 upstream（避免 upstream <-> catalog 循环依赖）。 */
function publish(entries: CatalogEntry[]): void {
  for (const entry of entries) {
    upstream.setModelEfforts(entry.id, entry.efforts, entry.defaultEffort);
  }
}

/**
 * 异步刷新远端目录。失败/空结果**保留上一次快照**（从未成功过 → 兜底表），
 * 并进入冷却，避免被逐模型放大成请求风暴。
 */
async function refreshCatalog(): Promise<void> {
  const cfg = upstream.loadConfig()[0];
  const now = Date.now();
  const cached = remoteCache;
  if (!(cached && now - cached.at < (cached.entries.length > 0 ? REMOTE_TTL_MS : REMOTE_FAIL_COOLDOWN_MS))) {
    let entries: CatalogEntry[] = [];
    let version = "";
    try {
      const c = cred.load();
      const payload = await upstream.fetchModels(c, cfg);
      const { items, version: v } = upstream.parseModelsResponse(payload);
      entries = parseRemoteModels(items);
      version = v;
    } catch {
      // 远端不可用（未登录 / 网络 / 业务码）→ 整表保底，绝不抛到调用方
      entries = [];
      version = "";
    }
    remoteCache = { entries, version, at: now };
    if (entries.length > 0) writeCatalogCache(entries);
  }
  const fresh = remoteCache;
  if (!fresh) {
    snapshot = { entries: fallbackEntries(), catalogVersion: "" };
    publish(snapshot.entries);
    return;
  }
  const chosen = fresh.entries.length > 0 ? fresh.entries : fallbackEntries();
  snapshot = { entries: chosen, catalogVersion: fresh.version };
  publish(chosen);
}

/**
 * 磁盘缓存里的目录**先顶上**（新进程 / 离线 / 未登录时也能显示真实目录），
 * 随后的真实刷新会覆盖它 —— 所以这里只负责"有东西可显示"，不负责新鲜度。
 */
function seedFromDiskCache(): void {
  if (snapshot) return;
  try {
    const cached = readCatalogCache<CatalogEntry>();
    if (cached) {
      // 旧缓存没有 maxOutput（那是后来按公开规格补的）—— 读时补上，不必等一次刷新。
      const entries = cached.map((entry) => {
        if (entry.maxOutput !== undefined) return entry;
        const maxOutput = rowOf(entry.id)?.maxOutput;
        return maxOutput === undefined ? entry : { ...entry, maxOutput };
      });
      snapshot = { entries, catalogVersion: "" };
      publish(entries);
    }
  } catch {
    /* 读不到就继续走兜底表 */
  }
}

/** 首次同步访问时触发后台刷新；返回**种入后的快照**（磁盘缓存可能已顶上）。 */
function ensureRefresh(): Snapshot | null {
  if (refreshAttempted) return snapshot; // 每进程只自动刷一次（原语义）
  refreshAttempted = true;
  seedFromDiskCache();
  refreshing = true;
  void refreshCatalog()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
    });
  return snapshot;
}

function currentEntries(): CatalogEntry[] {
  if (!snapshot) {
    // ensureRefresh() 会先用磁盘缓存顶上；只有连磁盘缓存都没有时才退回内置表。
    // 直接 return fallbackEntries() 会让「新进程显示真实目录」失效 ——
    // 多数 CLI 调用只问一次目录，这一次就决定了用户看到什么。
    const seeded = ensureRefresh();
    if (seeded) return seeded.entries;
    const entries = fallbackEntries();
    publish(entries);
    return entries;
  }
  return snapshot.entries;
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 与 `refreshCatalog()` 的两点不同，都是「用户显式要求」带来的：
 * 1. **绕过 TTL / 冷却**：不查 `remoteCache.at`，直接打一次上游；
 * 2. **失败抛错**：`refreshCatalog` 静默回落是为了不打扰自动路径，但用户敲了
 *    `--refresh` 却看到旧表会以为刷新成功 —— 必须让失败可见。
 *
 * 失败时**不写** `remoteCache`：否则会把一次失败记成冷却期，反而挡住后续自动刷新。
 */
export async function refresh(): Promise<void> {
  const cfg = upstream.loadConfig()[0];
  const c = cred.load();
  const payload = await upstream.fetchModels(c, cfg);
  const { items, version } = upstream.parseModelsResponse(payload);
  const entries = parseRemoteModels(items);
  if (entries.length === 0) throw new Error("upstream returned an empty model catalog");
  remoteCache = { entries, version, at: Date.now() };
  writeCatalogCache(entries);
  snapshot = { entries, catalogVersion: version };
  publish(entries);
}

/** 远端 catalog 版本（`reasoning_catalog_version`）。 */
function catalogVersion(): string {
  return snapshot?.catalogVersion ?? "";
}

// ── 别名（models.json 可选覆盖）───────────────────────────────────────────────

const ALIAS_FIELDS = ["alias", "short", "shortName", "exposed_id"] as const;

interface AliasCache {
  key: string;
  pairs: Array<[string, string]>;
}

let aliasCache: AliasCache | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["LOOMY_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  // 单文件 bundle 里的随包快照（按 cid 分文件，见共享层 runtime/snapshot.ts）
  const bundled = bundledSnapshotPath();
  if (bundled) paths.push(bundled);
  return paths;
}

function loadAliases(): Array<[string, string]> {
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (aliasCache && aliasCache.key === key) return aliasCache.pairs;
    const pairs: Array<[string, string]> = [];
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      const models = isRecord(data) ? data["models"] : null;
      if (Array.isArray(models)) {
        for (const model of models) {
          if (!isRecord(model)) continue;
          const slug = str(model["slug"]);
          if (!slug) continue;
          let short = "";
          for (const field of ALIAS_FIELDS) {
            const value = str(model[field]).trim();
            if (value) {
              short = value;
              break;
            }
          }
          if (short) pairs.push([short, slug]);
        }
      }
    } catch {
      /* 文件损坏 → 无别名，不阻塞 */
    }
    aliasCache = { key, pairs };
    return pairs;
  }
  return [];
}

/** 对外隐藏的模型 id（数据是 `models.json` 的 `hidden` 标记；机制见共享层 `hiddenModelIds`）。 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url);
}

/**
 * 对外暴露的模型 id（短名最前；被别名覆盖的原始 id 不再重复暴露）。
 *
 * `hidden` 的条目不暴露，**指向它的别名一并撤下** —— 短名不该成为绕过隐藏策略的后门。
 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  const ids = currentEntries()
    .filter((e) => !hidden.has(e.id.toLowerCase()))
    .map((e) => e.id);
  const aliases = loadAliases().filter(([, slug]) => !hidden.has(slug.toLowerCase()));
  const all =
    aliases.length === 0
      ? ids
      : (() => {
          const covered = new Set(aliases.map(([, slug]) => slug));
          return [...aliases.map(([short]) => short), ...ids.filter((id) => !covered.has(id))];
        })();
  return all;
}

/** 短名 → 上游 slug；未知名称**原样返回**。 */
export function resolveModel(name: string): string {
  for (const [short, slug] of loadAliases()) {
    if (short === name) return slug;
  }
  return name;
}
