/**
 * Raccoon 模型目录：兜底表、图片能力白名单、倍率展示与远端解析。
 *
 * 关键约束（端点/字段/实测见 docs/channels/raccoon/PROTOCOL.md）：
 *   - 远端模型 id 在 `name` 字段里（`id` 是无关字段）；兜底表不含 `Raccoon-Auto`（客户端「自动选模」入口，直发会 404）。
 *   - `tags` 是选模偏好标签、不是图片能力契约：图片能力 = 显式白名单覆盖已确认个案 + tags 含 vision/image 等。
 *   - 展示价 1 倍也要显示：0 → 「免费」，低于原价 → `x原价→x折后价`，其余（含 1 倍）→ `x生效价`。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";
import { canonicalModelId, readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

/** 实测确认能读图、但远端未声明 vision 的个案（显式白名单，不是「恒 true」）。 */
const IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = new Set([
  "sn-deepseek-v4-1-flash",
  "sn-glm-5-3-flash",
]);

/** 远端 tags 的图片特征词。 */
const IMAGE_TAGS = ["vision", "image", "image-understanding"];

/** 远端目录成功结果的缓存时长。 */
const REMOTE_TTL_MS = 5 * 60 * 1000;
/** 远端失败/空结果的冷却时长。 */
const REMOTE_FAIL_COOLDOWN_MS = 30 * 1000;

interface ModelEntry {
  id: string;
  name: string;
  /** 上下文窗口（**远端声明**：`params.context_window`）。 */
  contextWindow: number;
  /** 单次回复最大输出（**远端声明**：`params.max_tokens`）。 */
  maxOutput: number;
  supportsImage: boolean;
  /** 当前生效倍率；null = 未知。 */
  effectiveMultiplier: number | null;
  /** 原价倍率；null = 未知。 */
  multiplier: number | null;
  billingStatus: string;
  billingStatusNote: string;
  source: "remote" | "fallback";
}

/**
 * 已知模型规格（上下文窗口 / 单次回复最大输出）。
 *
 * ⚠ 上游目录**自带**这两个数（实测 `params.context_window` / `params.max_tokens`，
 * 见 docs/channels/raccoon/PROTOCOL.md §5.2）—— 有上游声明时以**上游为准**
 * （docs/MODEL-SPECS.md §5「三层取值：上游声明优先」）。
 * 本表只在**上游没下发**时兜底（目录缓存缺失 / 新型号未声明）。
 *
 * ⚠ 键是**归一后的规范模型名**（`sn-glm-5-3-flash` → `glm-5.3-flash`），
 * 不是目录里的原始写法。
 *
 * ⚠ `sensenova-6.8-flash` / `sensenova-6.8-flash-lite` **不列**：官方未公开数值
 * （docs/MODEL-SPECS.md §4「没有公开规格的」）—— 不编造数字，让网关回落兜底值。
 *
 * 来源：`docs/MODEL-SPECS.md` §3（联网核实的唯一事实源）。
 */
const MODEL_SPECS: Readonly<Record<string, { contextWindow: number; maxOutputTokens: number }>> = {
  "deepseek-v4.1-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "glm-5.3": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3-flash": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "kimi-k3": { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 },
};

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**规范模型名**（`canonicalModelId` 归一后的结果）；
 * 这里再归一一次，保证目录里的原始写法（`sn-glm-5-3-flash`）也命中同一张表。
 * **查不到返回 undefined**（= 上游与公开资料都没有，不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const spec = MODEL_SPECS[canonicalModelId(modelId)];
  if (!spec) return undefined;
  return { contextWindow: spec.contextWindow, maxOutputTokens: spec.maxOutputTokens };
}

/**
 * 兜底静态模型表（6 个 `visible: true` 的模型）。
 *
 * 来源：真实实测 `GET /api/web/llm/v2/model_catalog`（见 docs/channels/raccoon/PROTOCOL.md）。
 * ⚠ 不含 `Raccoon-Auto`（发给 chat 会 404），也不含 3 个 `visible:false` 的内部模型。
 */
const FALLBACK_MODELS: ModelEntry[] = [
  {
    id: "sn-sensenova-6-8-flash",
    name: "SenseNova-6.8-Flash",
    contextWindow: 256_000,
    maxOutput: 63_999,
    supportsImage: true,
    effectiveMultiplier: 0,
    multiplier: 0.5,
    billingStatus: "limited_free",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-sensenova-6-8-flash-lite",
    name: "SenseNova-6.8-Flash-Lite",
    contextWindow: 256_000,
    maxOutput: 63_999,
    supportsImage: true,
    effectiveMultiplier: 0,
    multiplier: 0.5,
    billingStatus: "limited_free",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-glm-5-3",
    name: "GLM-5-3",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 0.75,
    multiplier: 0.75,
    billingStatus: "normal",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-kimi-k3",
    name: "Kimi-K3",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 1,
    multiplier: 1,
    billingStatus: "normal",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-glm-5-3-flash",
    name: "GLM-5-3-Flash",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 0.1,
    multiplier: 0.2,
    billingStatus: "discount",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-deepseek-v4-1-flash",
    name: "DeepSeek-V4.1-Flash",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 0.25,
    multiplier: 0.25,
    billingStatus: "normal",
    billingStatusNote: "",
    source: "fallback",
  },
];

/** 内部模型 / 自动选模入口：即使远端下发也不暴露。 */
const EXCLUDED_IDS = new Set(["Raccoon-Auto"]);

let snapshot: ModelEntry[] | null = null;
/** 本进程是否已自动刷过一次（保持「每进程只刷一次」的原有语义）。 */
let refreshAttempted = false;
let remoteCache: { entries: ModelEntry[]; at: number } | null = null;
let refreshing = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ── 图片能力 ──────────────────────────────────────────────────────────────────

/**
 * 图片能力判定（见文件头注释 2）。
 *
 * ⚠ 用**显式白名单**而不是「恒 true」：只覆盖**实测确认**的个案。
 */
function supportsImage(modelId: string, tags: unknown): boolean {
  if (IMAGE_CAPABILITY_OVERRIDES.has(modelId)) return true;
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => IMAGE_TAGS.includes(String(tag).toLowerCase()));
}

// ── 远端解析 ──────────────────────────────────────────────────────────────────

/** `billing_status` 三态映射：`discount` / `limited_free` / 其它 → `normal`。 */
function mapBillingStatus(value: unknown): string {
  const text = str(value);
  return text === "discount" || text === "limited_free" ? text : "normal";
}

/**
 * 解析 `model_catalog` 的 `data`。
 *
 * 规则：只取 `categories[].type === 'chat'`，过滤 `visible === false`（**缺省视为可见**），
 * 按 id（即 `name` 字段）去重，**剔除 `Raccoon-Auto`**。
 */
function parseRemoteModels(data: unknown): ModelEntry[] {
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  const categories = isRecord(data) ? data["categories"] : null;
  if (!Array.isArray(categories)) return out;

  for (const category of categories) {
    if (!isRecord(category) || category["type"] !== "chat") continue;
    const models = category["models"];
    if (!Array.isArray(models)) continue;
    for (const item of models) {
      if (!isRecord(item)) continue;
      if (item["visible"] === false) continue; // 缺省视为可见
      const id = str(item["name"]); // ⚠ 模型 id 在 name 字段里，不是 id
      if (!id || seen.has(id) || EXCLUDED_IDS.has(id)) continue;
      seen.add(id);
      const params = isRecord(item["params"]) ? item["params"] : {};
      const effectiveMultiplier = num(item["billing_effective_multiplier"]);
      const multiplier = num(item["billing_multiplier"]);
      const fallback = FALLBACK_MODELS.find((m) => m.id === id);
      out.push({
        id,
        name: str(item["description"]) || fallback?.name || id,
        contextWindow: num(params["context_window"]) ?? num(item["context_window"]) ?? fallback?.contextWindow ?? 0,
        maxOutput: num(params["max_tokens"]) ?? fallback?.maxOutput ?? 0,
        // ⚠ tags 不是能力契约：白名单 + tags 特征词（见文件头注释 2）
        supportsImage: supportsImage(id, item["tags"]),
        effectiveMultiplier,
        multiplier,
        billingStatus: mapBillingStatus(item["billing_status"]),
        billingStatusNote: str(item["billing_status_note"]),
        source: "remote",
      });
    }
  }
  return out;
}

/** 兜底表（每次现算）。 */
function fallbackEntries(): ModelEntry[] {
  return FALLBACK_MODELS.map((m) => ({ ...m }));
}

/**
 * 异步刷新远端目录。失败/空结果保留上一次快照（从未成功 → 兜底表），并进入冷却
 * （与 Loomy 同构：只缓存**真实远端目录**，兜底表每次现算）。
 */
async function refreshCatalog(): Promise<void> {
  const now = Date.now();
  const cached = remoteCache;
  if (!(cached && now - cached.at < (cached.entries.length > 0 ? REMOTE_TTL_MS : REMOTE_FAIL_COOLDOWN_MS))) {
    let entries: ModelEntry[] = [];
    try {
      const c = cred.load();
      const payload = await upstream.fetchModels(c);
      const data = isRecord(payload["data"]) ? payload["data"] : {};
      entries = parseRemoteModels(data);
    } catch {
      entries = []; // 远端不可用 → 整表保底，绝不抛到调用方
    }
    remoteCache = { entries, at: now };
    if (entries.length > 0) writeCatalogCache(entries);
  }
  const fresh = remoteCache;
  if (!fresh) {
    snapshot = fallbackEntries();
    return;
  }
  snapshot = fresh.entries.length > 0 ? fresh.entries : fallbackEntries();
}

/**
 * 磁盘缓存里的目录**先顶上**（新进程 / 离线 / 未登录时也能显示真实目录），
 * 随后的真实刷新会覆盖它 —— 所以这里只负责"有东西可显示"，不负责新鲜度。
 */
function seedFromDiskCache(): void {
  if (snapshot) return;
  try {
    const cached = readCatalogCache<ModelEntry>();
    if (cached) snapshot = cached;
  } catch {
    /* 读不到就继续走兜底表 */
  }
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
  const c = cred.load();
  const payload = await upstream.fetchModels(c);
  const data = isRecord(payload["data"]) ? payload["data"] : {};
  const entries = parseRemoteModels(data);
  if (entries.length === 0) throw new Error("Upstream returned an empty model catalog");
  remoteCache = { entries, at: Date.now() };
  writeCatalogCache(entries);
  snapshot = entries;
}

function ensureRefresh(): void {
  if (refreshAttempted) return; // 每进程只自动刷一次（原语义）
  refreshAttempted = true;
  seedFromDiskCache();
  refreshing = true;
  void refreshCatalog()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
    });
}

function currentEntries(): ModelEntry[] {
  if (!snapshot) {
    ensureRefresh();
    // ensureRefresh() 会先用磁盘缓存顶上；只有连磁盘缓存都没有时才退回内置表。
    // 直接 return fallbackEntries() 会让「新进程显示真实目录」失效 ——
    // 多数 CLI 调用只问一次目录，这一次就决定了用户看到什么。
    return snapshot ?? fallbackEntries();
  }
  return snapshot;
}

/** 对外暴露的模型 id。 */
export function exposedIds(): string[] {
  // 全模型池：catalog 内全部模型都对外暴露（Raccoon 的 id 带渠道前缀 `sn-`）。
  return currentEntries().map((e) => e.id);
}

/** 模型 id → 上游 slug：Raccoon 的 id 就是 slug，**未知原样返回**。 */
export function resolveModel(name: string): string {
  return name;
}
