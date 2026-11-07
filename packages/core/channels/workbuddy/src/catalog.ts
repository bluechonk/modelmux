/**
 * WorkBuddy 国内版模型目录。
 *
 * 关键约束（端点/字段/实测见 docs/channels/workbuddy/PROTOCOL.md）：
 *   - 对外暴露 id 就是上游模型名 `slug`（条目显式给了 alias/short/shortName/exposed_id 时用该字段），不做短名花活。
 *   - `LEGACY_ALIASES` 只用于输入兼容（老客户端短名仍能解析），不会出现在 `/v1/models`。
 *   - 目录按 远端缓存 → 用户目录模型表（`channels/workbuddy/models.json`，随包快照浇种）解析；
 *     非对话前缀（`nes-`/`completion-`/`codewise-`）条目一律不入目录。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalModelId,
  ensureChannelModels,
  hiddenModelIds,
  readCatalogCache,
  writeCatalogCache,
} from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

/**
 * 历史短名 → 上游 slug（**仅输入兼容**，不作为对外名）。
 *
 * 改名的理由：短名让「列表里的 id」和「上游收到的 model」不一致，出问题时得多查一层。
 */
const LEGACY_ALIASES: Record<string, string> = {
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** 一条目录条目。`id` 必填（共享层缓存契约只要求这一个字段）。 */
interface ModelEntry {
  /** 上游模型名（发给上游的 `model` 字段）。 */
  id: string;
  /** 对外名（默认等于 `id`；快照里给了 alias 时才不同）。 */
  exposed: string;
  /** 展示名。 */
  name: string;
  context_window?: number;
  max_output?: number;
  /**
   * 这个模型**能不能吃图**（判据见 `supportsImageOf`）。
   *
   * 与上游的 `supports_image_detail_original`（**原图细节**）无关，别混用。
   */
  supports_image?: boolean;
  /** 倍率展示文案（如 `"x0.34"`）；上游 `credits` 字段为空时缺省。 */
  rate?: string;
  /** 倍率数值（由 `rate` 解析）；供共享层 `PoolModelMeta.multiplier` 使用。 */
  multiplier?: number;
  source: "fallback" | "snapshot" | "remote";
}

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
  const spec = specOf(canonicalModelId(modelId));
  if (!spec) return undefined;
  return {
    contextWindow: spec.contextWindow,
    ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
  };
}

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
  // 单文件 bundle 里的随包快照（按 cid 分文件，见共享层 runtime/snapshot.ts）
  const bundled = bundledSnapshotPath();
  if (bundled) paths.push(bundled);
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
 * `input_modalities` 里代表「图片」的写法（小写化后比对）。
 *
 * 口径对齐共享层 `pool-targets.ts` 的模态别名表（`image` / `images` / `img` / `vision`）。
 */
const IMAGE_MODALITY_ALIASES = new Set(["image", "images", "img", "vision"]);

/**
 * 判定「这个模型能不能吃图」。
 *
 * 判据（按优先级，先到先得）：
 * 1. **数组形态** `input_modalities` / `inputModalities` —— 含 `image` 即为真
 *    （随包快照走的就是这种形态：`["text","image"]`）；
 * 2. **布尔形态** `supportsImages` / `supportsImage` / `supports_image`
 *    （`/v3/config` 与企业窄表走的就是这种形态）。
 *
 * `supports_image_detail_original` **不作判据**：它的语义是「支不支持**原图细节**」，
 * 与「支不支持图片」是两回事。把它当判据，会把同时下发
 * `input_modalities:["text","image"]` 与 `supports_image_detail_original:false` 的型号
 * （随包快照的 `deepseek-v4.1-flash` 就是这样）报成纯文本 → 客户端不再给它发图片。
 *
 * 取不到判据 → 返回 undefined（条目不填该字段），由汇聚层回落纯文本（宁可少报）。
 */
function supportsImageOf(rec: Record<string, unknown>): boolean | undefined {
  for (const key of ["input_modalities", "inputModalities"]) {
    const value = rec[key];
    if (!Array.isArray(value)) continue;
    return value.some(
      (item) => typeof item === "string" && IMAGE_MODALITY_ALIASES.has(item.trim().toLowerCase()),
    );
  }
  for (const key of ["supportsImages", "supportsImage", "supports_image"]) {
    const value = rec[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * 把一行上游模型载荷解析成条目。
 *
 * 两个口径都要认（同一个产品的两张目录）：
 * - `/v3/config` 的 `models[]`：`id` / `name` / `maxInputTokens` / `maxOutputTokens` /
 *   `supportsImages`（**能不能吃图的判据**）
 * - 随包快照（旧插件端点）：`slug` / `display_name` / `context_window` / `max_output_tokens` /
 *   `input_modalities`（**能不能吃图的判据**）
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
  const image = supportsImageOf(rec);
  if (image !== undefined) entry.supports_image = image;
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

/** 当前生效的目录：远端 → 用户目录模型表（首启由随包 `models.json` 浇种）。 */
function entries(): ModelEntry[] {
  ensureRemoteLoaded();
  if (remote && remote.length > 0) return [...remote];
  return seedTable();
}

/** 用户目录模型表（首启由随包种子浇种）。 */
let seedCache: ModelEntry[] | null = null;
function seedTable(): ModelEntry[] {
  if (!seedCache) {
    seedCache =
      ensureChannelModels<ModelEntry>(undefined, [
        bundledSnapshotPath(),
        packageSnapshotPath(import.meta.url),
      ]) ?? [];
  }
  return seedCache.map((e) => ({ ...e }));
}

/** 按归一化 id 查规格（规格是数据，落在 models.json）。 */
function specOf(modelId: string): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const row = seedTable().find((e) => canonicalModelId(e.id) === canonicalModelId(modelId));
  if (!row) return undefined;
  return {
    ...(row.context_window !== undefined ? { contextWindow: row.context_window } : {}),
    ...(row.max_output !== undefined ? { maxOutputTokens: row.max_output } : {}),
  };
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

/** 对外隐藏的模型 id（数据是 `models.json` 的 `hidden` 标记；机制见共享层 `hiddenModelIds`）。 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url, ["exposed"]);
}

/** 对外暴露的模型 ID 列表（`hidden` 的不暴露；对外名是 `exposed`，与上游 id 双匹配防改名绕过）。 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  return entries()
    .filter(
      (entry) =>
        !hidden.has(entry.id.toLowerCase()) &&
        !hidden.has(entry.exposed.toLowerCase()) &&
        !hidden.has(canonicalModelId(entry.id)),
    )
    .map((entry) => entry.exposed);
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
