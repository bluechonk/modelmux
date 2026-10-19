/**
 * CodeArts 模型目录与 benefit 集合。
 *
 * ## 三个端点合并去重
 *
 * | # | 端点 | 提取路径 | 条目字段 | 开关 |
 * |---|---|---|---|---|
 * | 1 | `opengw.../api/v1/gateway/config` | `result.models[]` | `model_id` / `model_name` | 常开 |
 * | 2 | `{snap}/v1/model/builtin` | `builtinModels[]` | `model_id` / `model_name` / `credit` | 常开 |
 * | 3 | `{snap}/v1/agent-center/agents/detail` | `gpts.models[]` | `model_id` / `model_parameters` | **默认关** |
 *
 * 归一化：去掉末尾 `-` + 4 位数字（`deepseek-v4-flash-0731` → `deepseek-v4-flash`）——
 * chat 端点只认不带后缀的 id（`InferHub.002002009.404 model is not registered`）。
 * 视觉模型（id 含 `-VL-` 或以 `-VL` 结尾）过滤掉：上下文小、不支持工具调用，
 * 不适合当 agent 主模型。
 *
 * ## benefit 集合：`maas_type: benefit` 的判据
 *
 * gateway/config 返回的就是 benefit（免费额度）模型；这些模型 chat 时**必须**
 * 带 `maas_type: benefit`（且**参与签名**），否则 404 未注册。
 * 而 `/v1/model/builtin` 的模型带上该头反而 `unsupported model`。
 *
 * ⚠️ **只记录归一化未改写的 id**：带日期后缀的 `-0731` 与无后缀在后端是
 * **两个不同模型、benefit 属性相反**（实测：`-0731` 不带 maas_type → 404；
 * 无后缀的不带 → 成功、带上 → `unsupported model`）。记录被改写过的 id 会把
 * 无后缀模型错误标成 benefit，导致它反而调用失败。
 *
 * ## benefit 集合**按账号**存
 *
 * benefit 是**按账号授予**的（[参考]
 * reference/HITZY2002_codearts2api/internal/upstream/models.go:11-12）：
 * 池里 A 账号有、B 账号没有时共用一份集合会互相污染 ——
 * A 少带 `maas_type` 报 404 未注册，B 多带报 `unsupported model`。
 * 故每个账号一份 `{benefit, regular}` 快照，键是账号维度键（`cred.uid`）。
 *
 * 缓存文件落在渠道层内：`<存储根>/codearts/cache/models.json`（共享信封）、
 * `benefit-models.json`（全局并集，兜底用）、`benefit-accounts.json`（按账号）
 * （`DSH_CODEARTS_CACHE_DIR` / `CODEARTS_CACHE_DIR` 可显式覆盖），
 * **同步读写**：chat 签名前要读它。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cacheDir as sharedCacheDir,
  canonicalModelId,
  readCatalogCache,
  writeCatalogCache,
} from "@modelmux/gateway";

/** 一条目录条目。 */
export interface ModelEntry {
  id: string;
  name: string;
  /** 上下文窗口（仅静态表里有值；远端不下发时留 undefined 让后端默认裁剪）。 */
  context_window?: number;
  /** 最大输出 token（远端不下发，按公开规格补；见 `MAX_OUTPUTS`）。 */
  max_output?: number;
  /** 消耗倍率（来自 builtin 端点 `credit` 档位的 `ratio_display`）；benefit 模型无此字段。 */
  multiplier?: number;
  source: "fallback" | "remote";
}

/**
 * 静态兜底模型表（9 个）。
 *
 * 远端两个端点都拉不到时（未登录 / 网络问题）仍要让用户看到模型 ——
 * 否则渠道在选择器里凭空消失。
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5",
  "glm-5.3-flash",
  "openpangu-2.0-flash",
  "openpangu-2.0-pro",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
];

/** 上下文窗口表（仅这几个模型公开了容量；其余留 undefined 让后端默认裁剪）。 */
export const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["GLM-5.2", 202_752],
  ["glm-5.3-flash", 1_048_576],
  ["glm-5.3", 1_048_576],
  ["openpangu-2.0-flash", 524_288],
  ["openpangu-2.0-pro", 524_288],
  ["deepseek-v4-flash", 1_048_576],
  ["deepseek-v4-pro", 1_048_576],
  ["deepseek-v4.1-flash", 1_000_000],
]);

/**
 * 已知模型的**最大输出 token**（远端不下发，按公开规格补）。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回 400）—— 客户端应能降档重试。
 * 数值与来源见 `docs/MODEL-SPECS.md`（唯一事实源；渠道表在本文件的 `MAX_OUTPUTS`）。
 */
const MAX_OUTPUTS: Readonly<Record<string, number>> = {
  "deepseek-v4-flash": 393_216,
  "deepseek-v4-pro": 393_216,
  "deepseek-v4.1-flash": 393_216,
  "glm-5": 131_072,
  "glm-5.1": 131_072,
  "glm-5.2": 131_072,
  "glm-5.3": 131_072,
  "glm-5.3-flash": 131_072,
};

/** 取已知最大输出（按 id 小写匹配）。 */
function maxOutputOf(id: string): number | undefined {
  return MAX_OUTPUTS[id.toLowerCase()];
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（上游 `GLM-5.2` → `glm-5.2`），故两张表都按归一化
 * 形态比对。**查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const wanted = canonicalModelId(modelId);
  let contextWindow: number | undefined;
  for (const [key, window] of CONTEXT_WINDOWS) {
    if (canonicalModelId(key) === wanted) {
      contextWindow = window;
      break;
    }
  }
  const maxOutputTokens = maxOutputOf(wanted);
  if (contextWindow === undefined && maxOutputTokens === undefined) return undefined;
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export const FALLBACK_MODELS: readonly ModelEntry[] = FALLBACK_MODEL_IDS.map((id) => {
  const window = CONTEXT_WINDOWS.get(id);
  const maxOutput = maxOutputOf(id);
  return {
    id,
    name: id,
    ...(window === undefined ? {} : { context_window: window }),
    ...(maxOutput === undefined ? {} : { max_output: maxOutput }),
    source: "fallback" as const,
  };
});

/**
 * benefit 静态兜底集合（2 个）。
 *
 * 权威来源是 gateway/config，但首次启动 / 未登录 / 远端失败时拿不到，
 * 故保留这份来自真实 IDE 抓包 + 逐一实测的兜底。
 */
export const BENEFIT_FALLBACK: readonly string[] = ["glm-5.3-flash", "deepseek-v4.1-flash"];

const BENEFIT_CACHE_FILENAME = "benefit-models.json";
/** 按账号的 benefit 快照文件（`{账号键: {benefit, regular}}`）。 */
const BENEFIT_ACCOUNTS_FILENAME = "benefit-accounts.json";

/**
 * 缓存目录：`DSH_CODEARTS_CACHE_DIR`（或 `CODEARTS_CACHE_DIR`）可显式覆盖，
 * 默认落在渠道层内（`<存储根>/codearts/cache/`）。
 */
export function cacheDir(): string {
  const override = process.env["DSH_CODEARTS_CACHE_DIR"] ?? process.env["CODEARTS_CACHE_DIR"];
  if (override && override.trim()) return override.trim();
  return sharedCacheDir();
}

/** 读缓存。 */
function readCache(filename: string): unknown[] | null {
  return readCacheArray(join(cacheDir(), filename));
}

/** 写缓存：一律写新位置/新名（写不进去不影响主流程）。 */
function writeCache(filename: string, value: unknown): void {
  writeCacheArray(join(cacheDir(), filename), value);
}

/** 读一个 JSON 对象缓存（不是数组的那种）。 */
function readCacheObject(filename: string): Record<string, unknown> | null {
  try {
    const path = join(cacheDir(), filename);
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 写一个 JSON 对象缓存。 */
function writeCacheObject(filename: string, value: unknown): void {
  try {
    mkdirSync(dirname(join(cacheDir(), filename)), { recursive: true });
    writeFileSync(join(cacheDir(), filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

function readCacheArray(path: string): unknown[] | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCacheArray(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

/** 去重记录器（跨两个端点共用，保证同名模型只出现一次）。 */
export type SeenSet = Set<string>;

/**
 * 去掉模型 id 末尾的日期版本后缀：`deepseek-v4-flash-0731` → `deepseek-v4-flash`。
 *
 * 只匹配末尾 `-NNNN`（4 位数字），避免误去 `glm-5.3-flash` 这类合法 id。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5);
    if (suffix.startsWith("-") && /^\d{4}$/.test(suffix.slice(1))) return id.slice(0, -5);
  }
  return id;
}

/** 视觉（VL）模型：从列表隐藏（只通过 analyzeImage 类工具间接调用）。 */
export function isVisionModel(id: string): boolean {
  return id.includes("-VL-") || id.endsWith("-VL");
}

/**
 * 从 builtin 端点的 `credit` 字段解析消耗倍率。
 *
 * 实测 `credit` **本身就是数组**（`[{ratio, ratio_display, input_from, …}]`），
 * 不是序列化字符串；每档含 `ratio`（内部计价系数）与 `ratio_display`（对外展示倍率，
 * 如 `"0.7x"`）。展示倍率才是与其它渠道同口径的值（实测 glm-5.3 的 0.79x 与
 * raccoon / workbuddyai 同模型一致），故取 `ratio_display`，缺失时退回 `ratio`。
 * benefit 模型（gateway/config 端点）不带 `credit` → undefined。
 *
 * 兼容字符串形态：本地缓存 JSON 往返后字段类型不变，但历史排查脚本打印过二次
 * 编码的假象，两种都收。
 */
export function parseCreditRate(credit: unknown): number | undefined {
  let tiers: unknown = credit;
  if (typeof credit === "string" && credit.trim()) {
    try {
      tiers = JSON.parse(credit);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(tiers)) return undefined;
  for (const tier of tiers) {
    if (!tier || typeof tier !== "object") continue;
    const rec = tier as Record<string, unknown>;
    const display = typeof rec["ratio_display"] === "string" ? rec["ratio_display"] : "";
    const fromDisplay = Number.parseFloat(display.replace(/x/i, ""));
    if (Number.isFinite(fromDisplay)) return fromDisplay;
    const ratio = Number(rec["ratio"]);
    if (Number.isFinite(ratio)) return ratio;
  }
  return undefined;
}

/** 解析一组远端模型行（`model_id` / `model_name` / `credit`）。 */
export function parseModelRows(
  rows: readonly unknown[],
  seen: SeenSet = new Set<string>(),
  source: ModelEntry["source"] = "remote",
): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const rawId = typeof rec["model_id"] === "string" ? rec["model_id"] : "";
    if (!rawId) continue;
    const id = normalizeModelId(rawId);
    if (isVisionModel(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const rawName = typeof rec["model_name"] === "string" ? rec["model_name"] : "";
    const entry: ModelEntry = { id, name: rawName ? normalizeModelId(rawName) : id, source };
    const window = CONTEXT_WINDOWS.get(id);
    if (window !== undefined) entry.context_window = window;
    const maxOutput = maxOutputOf(id);
    if (maxOutput !== undefined) entry.max_output = maxOutput;
    const rate = parseCreditRate(rec["credit"]);
    if (rate !== undefined) entry.multiplier = rate;
    out.push(entry);
  }
  return out;
}

// ── 缓存状态 ─────────────────────────────────────────────────────────────────

let remoteCache: ModelEntry[] | null = null;
let benefitCache: string[] | null = null;

/** 一个账号的 benefit 快照。 */
export interface AccountBenefit {
  /** 该账号确认为 benefit（免费额度）的模型 id。 */
  benefit: string[];
  /** 该账号登记为「常规」的模型 id（来自 builtin / agent-center）—— 它们不是 benefit。 */
  regular: string[];
}

/** 按账号的 benefit 快照（账号键 → 快照）。 */
const accountBenefits = new Map<string, AccountBenefit>();

/**
 * 同步读一次磁盘缓存（**惰性**：不在模块加载时读）。
 *
 * `isBenefitModel()` 在 chat 请求签名前被调用（同步路径），若等异步填充会有
 * 窗口期把 benefit 模型当成非 benefit 发出去（404）—— 故这里保持同步，只是把
 * 时机从「模块加载」推到「第一次使用」：仅 import 本模块不应产生读盘副作用
 * （巡检/统计工具会 import 各渠道模块拿 config）。
 */
function loadCaches(): void {
  // models.json 走共享信封（与其它渠道一致），池层 getPoolModelMeta 才读得到倍率。
  const models = readCatalogCache<ModelEntry & Record<string, unknown>>();
  if (models && models.length > 0) {
    const entries: ModelEntry[] = [];
    for (const item of models) {
      if (!item || typeof item !== "object") continue;
      const rec = item;
      const id = typeof rec["id"] === "string" ? rec["id"] : "";
      if (!id) continue;
      const entry: ModelEntry = {
        id,
        name: typeof rec["name"] === "string" && rec["name"] ? rec["name"] : id,
        source: "remote",
      };
      if (typeof rec["context_window"] === "number") entry.context_window = rec["context_window"];
      // 缓存行未带 max_output 时按规格表补（上游目录不下发该字段）。
      const cachedMax = typeof rec["max_output"] === "number" ? rec["max_output"] : undefined;
      const maxOutput = cachedMax ?? maxOutputOf(id);
      if (maxOutput !== undefined) entry.max_output = maxOutput;
      if (typeof rec["multiplier"] === "number") entry.multiplier = rec["multiplier"];
      entries.push(entry);
    }
    if (entries.length > 0) remoteCache = entries;
  }
  const benefit = readCache(BENEFIT_CACHE_FILENAME);
  if (benefit) {
    benefitCache = benefit.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  // 按账号的快照：{账号键: {benefit: [], regular: []}}
  const accounts = readCacheObject(BENEFIT_ACCOUNTS_FILENAME);
  if (accounts) {
    for (const [key, value] of Object.entries(accounts)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>;
      const pick = (field: string): string[] => {
        const raw = rec[field];
        if (!Array.isArray(raw)) return [];
        return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
      };
      accountBenefits.set(key, { benefit: pick("benefit"), regular: pick("regular") });
    }
  }
}

let cachesLoaded = false;

/** 首次使用时同步载入磁盘缓存。 */
function ensureCaches(): void {
  if (cachesLoaded) return;
  cachesLoaded = true;
  loadCaches();
}

/** 一轮目录更新的载荷（由 `upstream.fetchModels` 组装）。 */
export interface CatalogUpdate {
  /** 本轮合并去重后的目录条目。 */
  entries: readonly ModelEntry[];
  /** 本轮从 opengw 拿到的 benefit 模型 id（归一化后）。 */
  benefitIds: readonly string[];
  /** 本轮从 builtin / agent-center 拿到的「常规」模型 id（归一化后）。 */
  regularIds: readonly string[];
  /** 账号维度键（`cred.uid`）。 */
  accountKey: string;
  /** 本轮 benefit 来源是否成功（失败时保留上一轮的 benefit 标记）。 */
  benefitSourceOk: boolean;
}

/**
 * 灌入远端目录与 benefit 集合（由 `upstream.fetchModels` 调用）。
 *
 * ## benefit 标记的更新规则
 *
 * - 本轮 benefit 来源**成功** → 该账号的 benefit 集合**整体替换**
 *   （套餐轮换后旧模型不得残留）。
 * - 本轮 benefit 来源**失败** → 保留上一轮已确认的 benefit 条目，
 *   但**去掉**本轮被 builtin / agent-center 登记的（那说明它已「转正」
 *   成常规模型，带 `maas_type` 会报 `unsupported model`）。
 *   少带一次头就是一次 404，故宁可多带。
 */
export function setRemoteModels(update: CatalogUpdate): void {
  const { entries, benefitIds, regularIds, accountKey, benefitSourceOk } = update;
  // ⚠ 先把磁盘上的既有分桶读进来：本函数可能在任何 `ensureCaches()` 之前被调用
  // （目录刷新是入口），不先读会把**别的账号**的分桶整片覆盖掉。
  ensureCaches();
  if (entries.length > 0) {
    remoteCache = [...entries];
    writeCatalogCache(remoteCache);
  }
  if (benefitIds && benefitIds.length > 0) {
    // ⚠️ 只在确实拿到 benefit 模型时写入，避免用空集合覆盖可用缓存。
    benefitCache = [...new Set(benefitIds)];
    writeCache(BENEFIT_CACHE_FILENAME, benefitCache);
  }

  const prev = accountBenefits.get(accountKey);
  const regular = new Set<string>([...(prev?.regular ?? []), ...regularIds]);
  let benefit: string[];
  if (benefitSourceOk) {
    benefit = [...new Set(benefitIds)];
  } else {
    // 上一轮标记过、且本轮没有被登记为常规的，继续按 benefit 路由。
    benefit = [...new Set((prev?.benefit ?? []).filter((id) => !regular.has(id)))];
  }
  accountBenefits.set(accountKey, { benefit, regular: [...regular] });
  writeCacheObject(BENEFIT_ACCOUNTS_FILENAME, Object.fromEntries(accountBenefits));
}

export function remoteModels(): ModelEntry[] | null {
  ensureCaches();
  return remoteCache ? [...remoteCache] : null;
}

/** 某账号的 benefit 快照（没有记录时返回 null）。 */
export function accountBenefit(accountKey: string): AccountBenefit | null {
  ensureCaches();
  const rec = accountBenefits.get(accountKey);
  return rec ? { benefit: [...rec.benefit], regular: [...rec.regular] } : null;
}

/** 清空内存与磁盘缓存（测试隔离 / 用户点「刷新目录」）。 */
export function resetRemoteCache(): void {
  remoteCache = null;
  benefitCache = null;
  accountBenefits.clear();
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 解析与落盘已在 `upstream.fetchModels()` 里完成（它调 `setRemoteModels()`，
 * 本渠道用的是自己的 `cache/models.json` + `benefit-models.json`），
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

/** 当前生效的目录：远端优先，未拉到时用兜底表。 */
export function entries(): ModelEntry[] {
  ensureCaches();
  return remoteCache && remoteCache.length > 0 ? [...remoteCache] : [...FALLBACK_MODELS];
}

/** 按 id 取条目；不存在返回 null。 */
export function entryFor(id: string): ModelEntry | null {
  return entries().find((entry) => entry.id === id) ?? null;
}

/** 对外暴露的模型 id。 */
export function exposedIds(): string[] {
  // 全模型池：放行全部模型（不再限制 (deepseek|glm)×flash）
  return entries().map((entry) => entry.id);
}

/**
 * 短名 → 上游模型 id。
 *
 * 上游只认**归一化后的 id**（去掉 `-NNNN` 后缀）：带后缀的形态发给 chat
 * 端点会被 404。已知 id 归一化后返回；未知名称原样透传。
 */
export function resolveModel(name: string): string {
  const id = normalizeModelId(name);
  const known = new Set(entries().map((entry) => entry.id));
  return known.has(id) ? id : name;
}

/**
 * 该模型是否属于 benefit 集合（chat 时必须带 `maas_type: benefit`）。
 *
 * ## 判定顺序（有该账号的记录时）
 *
 * 1. 该账号的 benefit 集合里有 → **是**；
 * 2. 该账号登记为「常规」里有 → **不是**（它已转正成常规模型，
 *    带 `maas_type` 会报 `unsupported model`）；
 * 3. 都没有 → 落到静态兜底 ∪ 全局并集。
 *
 * ## 静态兜底必须算进来
 *
 * 首次启动、远端失败时缓存为空，只靠缓存会让所有 benefit 模型 404。
 *
 * @param accountKey 账号维度键（`cred.uid`）；不给就只用全局判据。
 */
export function isBenefitModel(id: string, accountKey?: string): boolean {
  ensureCaches();
  const normalized = normalizeModelId(id);
  if (accountKey) {
    const rec = accountBenefits.get(accountKey);
    if (rec) {
      if (rec.benefit.includes(normalized)) return true;
      if (rec.regular.includes(normalized)) return false;
    }
  }
  if (BENEFIT_FALLBACK.includes(normalized)) return true;
  return (benefitCache ?? []).includes(normalized);
}

/** 当前 benefit 集合（诊断用）；给了账号键就看该账号的那一份。 */
export function benefitModels(accountKey?: string): string[] {
  ensureCaches();
  if (accountKey) {
    const rec = accountBenefits.get(accountKey);
    if (rec) return [...new Set([...BENEFIT_FALLBACK, ...rec.benefit])];
  }
  return [...new Set([...BENEFIT_FALLBACK, ...(benefitCache ?? [])])];
}

/** 详情列表（状态页 / 调试用）。 */
export function details(): Array<Record<string, unknown>> {
  return entries().map((entry) => ({ ...entry }));
}
