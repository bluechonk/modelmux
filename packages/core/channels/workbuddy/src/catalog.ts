/**
 * 模型目录（国内版）。
 *
 * **对外暴露的 id 就是上游模型名**（`models` 载荷的 `slug`，如 `deepseek-v4.1-flash`）——
 * 不做短名花活：客户端看到的与服务端实际收到的保持一致，排查时少一层心算。
 * 若某条模型显式给了 `alias` / `short` / `shortName` / `exposed_id`，则用该字段作对外名。
 *
 * `LEGACY_ALIASES`：**只用于输入兼容**。早期版本对外用过 `deepseek-flash` 这个短名，
 * 老客户端配置里若还写着它，进来仍能解析到 slug；但它**不会**出现在 `/v1/models` 里。
 *
 * ## 三份目录的优先级
 *
 * 1. **远端**（`<cid>/cache/models.json`，由 `upstream.fetchModels()` 每次成功拉取后落盘）——
 *    权威来源，`/v1/models` 与 `mx model` 正常看到的就是它；
 * 2. **随包快照**（渠道根 `models.json`）—— 未登录 / 上游拉不到时的兜底；
 * 3. **内置兜底表**（`LEGACY_ALIASES` 的值）—— 连快照都缺失时的最后一道。
 *
 * ⚠ 快照会**过期**：随包那份只是某个时刻的截图，与国际版同样只有极少数条目。
 * 故远端目录必须落盘（见共享层 `runtime/catalog-cache.ts`），否则换个新进程
 * （`mx model`、`mx model list`）就又只剩快照。
 *
 * 非对话条目（`nes-` / `completion-` / `codewise-` 前缀）**一律不入目录**：
 * 它们列出来也选不中（选中后上游回 `code=11102`）。
 *
 * ## 已知规格表
 *
 * `MODEL_SPECS` 按**公开规格**（`docs/MODEL-SPECS.md` §3）给已知型号补上下文窗口与
 * 单次回复上限，经 `modelSpec()` 钩子供池层 `/v1/models` 透出；
 * 上游目录自己声明的值优先，本表只在目录没声明时兜底。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalModelId, readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

/**
 * 历史短名 → 上游 slug（**仅输入兼容**，不作为对外名）。
 *
 * 改名的理由：短名让「列表里的 id」和「上游收到的 model」不一致，出问题时得多查一层。
 */
export const LEGACY_ALIASES: Record<string, string> = {
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** 一条目录条目。`id` 必填（共享层缓存契约只要求这一个字段）。 */
export interface ModelEntry {
  /** 上游模型名（发给上游的 `model` 字段）。 */
  id: string;
  /** 对外名（默认等于 `id`；快照里给了 alias 时才不同）。 */
  exposed: string;
  /** 展示名。 */
  name: string;
  context_window?: number;
  max_output?: number;
  supports_image?: boolean;
  /** 倍率展示文案（如 `"x0.34"`）；上游 `credits` 字段为空时缺省。 */
  rate?: string;
  /** 倍率数值（由 `rate` 解析）；供共享层 `model_info.multiplier` 使用。 */
  multiplier?: number;
  source: "fallback" | "snapshot" | "remote";
}

/**
 * 已知模型规格（上下文窗口 / 单次回复上限）。
 *
 * 来源：`docs/MODEL-SPECS.md` §3（联网核实的唯一事实源）—— 数值必须与那份表一致，
 * 改规格先改那份文档。
 *
 * ⚠ **键是池 id 里的规范模型名**（`canonicalModelId()` 归一后的结果），
 * 不是上游目录里的原始写法（目录 `kimi-k3-1` → 池 id `kimi-k3.1`）。
 *
 * ⚠ 两个数不是一回事：`contextWindow` = 上下文（输入 + 输出），
 * `maxOutputTokens` = **单次回复**上限。官方没公布输出上限的型号只填 `contextWindow`，
 * 输出留空 → 网关回落兜底值（不猜数字）。
 *
 * ⚠ 只列公开规格表里有的型号：档位别名（`auto` / `default`）与官方无公开规格的型号
 * （`hy3-x` / `space-bunny` / `kimi-k2.7` / `kimi-k3.1`）一律不列，
 * 逐条理由见 `docs/channels/workbuddy/PROTOCOL.md` 的「模型窗口规格」。
 */
const MODEL_SPECS: Readonly<Record<string, { contextWindow: number; maxOutputTokens?: number }>> = {
  "deepseek-v4.1-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v4-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v4-pro": { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  "glm-5.3": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.3-flash": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.2": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.1": { contextWindow: 202_752, maxOutputTokens: 131_072 },
  // 目录里叫 `glm-5.0`（展示名 GLM-5.0），公开规格表记作 `glm-5`
  "glm-5.0": { contextWindow: 202_752, maxOutputTokens: 131_072 },
  "glm-4.7": { contextWindow: 202_752, maxOutputTokens: 131_072 },
  "glm-5v-turbo": { contextWindow: 202_752, maxOutputTokens: 131_072 },
  "hy3": { contextWindow: 262_144 },
  "hy4-preview": { contextWindow: 1_048_576 },
  // 目录里带 `-x` 后缀（路由变体），展示名同 `hy4-preview`
  "hy4-preview-x": { contextWindow: 1_048_576 },
  "kimi-k2.5": { contextWindow: 262_144 },
  "kimi-k2.6": { contextWindow: 262_144, maxOutputTokens: 32_768 },
  "kimi-k2.8-preview": { contextWindow: 1_048_576 },
  "minimax-m3": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "minimax-m3.1-flash": { contextWindow: 1_000_000, maxOutputTokens: 524_288 },
  "mimo-v2.6-pro": { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  "step-5-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  // 目录里叫 `hunyuan-chat`，展示名是 Hunyuan-Turbos（公开规格表记作 `hunyuan-turbos`）
  "hunyuan-chat": { contextWindow: 262_144 },
};

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * 取值优先级：**上游目录声明 > 本表 > 兜底值**（共享层 `pool-targets.ts` 的
 * `metaFromEntry` 就是这个顺序）。目录条目里的 `context_window` / `max_output`
 * 是**上游自己声明的**（`/v3/config` 的 `maxInputTokens` / `maxOutputTokens`），
 * 比公开规格更贴近「这条渠道实际能吃多少」，故本表只在目录没声明时兜底。
 *
 * `modelId` 是池 id 里的**规范模型名**（`canonicalModelId()` 归一后的结果），
 * 故查表前再归一一次。**查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const spec = MODEL_SPECS[canonicalModelId(modelId)];
  if (!spec) return undefined;
  return {
    contextWindow: spec.contextWindow,
    ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
  };
}

/** 内置兜底表（快照与远端都拿不到时用）：对外名 = 上游名。 */
const FALLBACK_MODELS: readonly ModelEntry[] = [...new Set(Object.values(LEGACY_ALIASES))].map(
  (slug) => ({ id: slug, exposed: slug, name: slug, source: "fallback" as const }),
);

/**
 * 非对话模型前缀（上游目录里的补全 / 图片生成等条目）。
 *
 * 这些条目**出现在目录里但选不中**：客户端选中后上游回 `code=11102`（该后端无此模型）。
 * 参考 go `internal/upstream/client.go:1470-1473`（nonChatModel 规则过滤）`[参考]`。
 */
const NON_CHAT_MODEL_PREFIXES = ["nes-", "completion-", "codewise-"] as const;

/**
 * 该 id 是否是对话模型（非对话条目一律挡在目录外）。
 *
 * 目录出口的**唯一漏斗**：`parseRow` 走这里，远端 / 快照 / 兜底三条路都受管。
 */
export function isChatModelId(id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (!lower) return false;
  return !NON_CHAT_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** `models` 载荷中可用的对外名字段名（按优先级；都不给就用 slug）。 */
const EXPOSED_FIELDS = ["alias", "short", "shortName", "exposed_id"] as const;

interface SnapshotCache {
  key: string;
  entries: ModelEntry[];
}

let snapshot: SnapshotCache | null = null;
let remote: ModelEntry[] | null = null;
let remoteLoaded = false;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["WB_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  // dist/catalog.js → 上两级是项目根
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 解析上游 `credits` 字段得到倍率（与 workbuddyai 同一 `/v3/config` 端点、同一口径）。
 *
 * 形如 `"x0.34 credits"`；`x0.00` 视为免费（0）；Auto 这类不给倍率的条目是空串。
 * 取不到数字就返回 null（不猜）。
 */
function parseCreditsRate(credits: string): { rate: string; multiplier: number } | null {
  const text = credits.trim();
  if (!text) return null;
  if (/free|免费/i.test(text)) return { rate: "免费", multiplier: 0 };
  const m = /x?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return { rate: "免费", multiplier: 0 };
  return { rate: `x${value}`, multiplier: value };
}

/**
 * 把一行上游模型载荷解析成条目。
 *
 * 两个口径都要认（同一个产品的两张目录）：
 * - `/v3/config` 的 `models[]`：`id` / `name` / `maxInputTokens` / `maxOutputTokens` / `supportsImages`
 * - 随包快照（旧插件端点）：`slug` / `display_name` / `context_window` / `max_output_tokens`
 *
 * 只取列表与用量判断要用的字段；内部运行时画像（`base_instructions`、
 * `service_tiers` 等几十个键）不落盘 —— 缓存是给人看的，不是上游载荷的副本。
 *
 * 非对话条目（`nes-` / `completion-` / `codewise-` 前缀）在这里挡掉：它们
 * 出现在目录里但选不中，选中后上游回 `code=11102`（见 `isChatModelId`）。
 */
function parseRow(row: unknown, source: ModelEntry["source"]): ModelEntry | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  const id = str(rec["slug"]) || str(rec["id"]);
  if (!id) return null;
  if (!isChatModelId(id)) return null;

  let exposed = "";
  for (const field of EXPOSED_FIELDS) {
    const value = rec[field];
    if (typeof value === "string" && value.trim()) {
      exposed = value.trim();
      break;
    }
  }
  if (!exposed) exposed = id;

  const entry: ModelEntry = {
    id,
    exposed,
    name: str(rec["display_name"]) || str(rec["name"]) || id,
    source,
  };
  const context =
    num(rec["context_window"]) ??
    num(rec["max_context_window"]) ??
    num(rec["maxInputTokens"]) ??
    num(rec["max_input_tokens"]);
  if (context !== undefined) entry.context_window = context;
  const output =
    num(rec["max_output_tokens"]) ?? num(rec["max_tokens"]) ?? num(rec["maxOutputTokens"]);
  if (output !== undefined) entry.max_output = output;
  const image = rec["supports_image_detail_original"] ?? rec["supportsImages"];
  if (typeof image === "boolean") entry.supports_image = image;
  const rate = parseCreditsRate(str(rec["credits"]));
  if (rate) {
    entry.rate = rate.rate;
    entry.multiplier = rate.multiplier;
  }
  return entry;
}

/** 解析一组上游行，按对外名去重（同渠道不同原始写法收敛为一个 id）。 */
function parseRows(rows: readonly unknown[], source: ModelEntry["source"]): ModelEntry[] {
  const seen = new Set<string>();
  const entries: ModelEntry[] = [];
  for (const row of rows) {
    const entry = parseRow(row, source);
    if (!entry || seen.has(entry.exposed)) continue;
    seen.add(entry.exposed);
    entries.push(entry);
  }
  return entries;
}

/** 读随包快照（按 (路径, mtime, 大小) 缓存，未变化不重复解析）。 */
function snapshotEntries(): ModelEntry[] {
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (snapshot && snapshot.key === key) return snapshot.entries;
    let rows: unknown = [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      rows = parsed["models"];
    } catch {
      rows = [];
    }
    const entries = Array.isArray(rows) ? parseRows(rows, "snapshot") : [];
    snapshot = { key, entries };
    if (entries.length > 0) return entries;
  }
  return [];
}

/**
 * 首次使用时把磁盘缓存（`<cid>/cache/models.json`）读进来。
 *
 * 惰性而非模块加载时读：`readCatalogCache()` 依赖渠道已注册（`setChannel`），
 * 而 `channel.ts` 是在 import 本模块**之后**才注册的 —— 模块加载期读会踩空。
 */
function ensureRemoteLoaded(): void {
  if (remoteLoaded) return;
  remoteLoaded = true;
  try {
    const cached = readCatalogCache<ModelEntry>();
    if (cached) remote = cached;
  } catch {
    /* 读不到就走快照 */
  }
}

/** 当前生效的目录：远端 → 快照 → 内置兜底。 */
export function entries(): ModelEntry[] {
  ensureRemoteLoaded();
  if (remote && remote.length > 0) return [...remote];
  const snap = snapshotEntries();
  if (snap.length > 0) return [...snap];
  return [...FALLBACK_MODELS];
}

/** 灌入远端目录并落盘（由 `upstream.fetchModels()` 在拉到列表后调用）。 */
export function setRemoteModels(rows: readonly unknown[]): ModelEntry[] {
  const parsed = parseRows(rows, "remote");
  if (parsed.length === 0) return [];
  remote = parsed;
  remoteLoaded = true;
  writeCatalogCache(parsed);
  return [...parsed];
}

/**
 * 强制从上游重拉目录（`mx model <cid> --refresh`）。
 *
 * 走 `/v3/config`（桌面端选择器的那份目录），解析与落盘由 `fetchCatalog()` 完成；
 * 失败**必须抛出去** —— 用户显式要求刷新时，看到一张旧表却以为刷成功了是最坏的结果。
 */
export async function refresh(): Promise<void> {
  // 动态 import：`upstream.ts` 静态依赖本模块（它调 setRemoteModels），
  // 这里再静态反向依赖会形成环。
  const [upstream, cred] = await Promise.all([import("./upstream.js"), import("./cred.js")]);
  await upstream.fetchCatalog(cred.load());
}

/** 对外暴露的模型 ID 列表（全模型池）。 */
export function exposedIds(): string[] {
  return entries().map((entry) => entry.exposed);
}

/**
 * 把客户端请求里的模型名解析为上游名。
 *
 * 顺序：目录命中（对外名 → slug）→ 历史短名（`LEGACY_ALIASES`）→ 原样透传。
 */
export function resolveModel(name: string): string {
  for (const entry of entries()) {
    if (entry.exposed === name) return entry.id;
  }
  const legacy = LEGACY_ALIASES[name];
  if (legacy) return legacy;
  return name;
}

/** 仅供测试：清空目录缓存（快照与远端都清）。 */
export function clearCache(): void {
  snapshot = null;
  remote = null;
  remoteLoaded = false;
}
