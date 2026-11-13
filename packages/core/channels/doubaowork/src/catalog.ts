/**
 * 豆包工作模型目录：`/alice/slot/action_bar_v3/brief_list` 的菜单树 → 池模型表。
 *
 * 关键约束（端点/字段/实测见 docs/channels/doubaowork/PROTOCOL.md）：
 *   - 目录是**账号级**的（不同套餐/白名单看到不同模型），所以只在登录后拉，
 *     落盘做缓存；`refresh()` 强制重拉。
 *   - 模型 id 用上游 `model_item_key`（如 `person-deepseek-v4-1-flash-261017`），
 *     展示名用 `name`；`resolveModel` 只认表内条目，表外原样返回。
 *   - `deep_think` / `agent_mode` / `mode_id` 是发对话的必填项，随目录一起存进
 *     `upstream` 的规格缓存（见 upstream.ts 的 `setModelSpecs`）。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalModelId,
  cacheDir,
  ensureDir,
  exposedIdsForChannel,
  writeJsonFile,
} from "@modelmux/gateway";

/** 目录缓存目录（渠道层 `cache/`，见 docs/STORAGE-CONVENTION.md）。 */
function modelsCacheDir(): string {
  return cacheDir();
}

/** 目录缓存文件路径。 */
function modelsCachePath(): string {
  return join(modelsCacheDir(), "models.json");
}

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 目录缓存 TTL：5 分钟（模型菜单变更不频繁，避免每次请求都拉）。 */
const TTL_MS = 5 * 60 * 1000;

/** 单条模型。 */
export interface ModelEntry {
  /** 上游 `model_item_key`（发对话用）。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** `menu_type` / `item_id` 推出的思考档位基值。 */
  readonly deepThink: number;
  /** 任务模式（0 = 普通对话，1 = 工作任务）。 */
  readonly agentMode: number;
  /** 模式 id（`aggregate_params.mode_id`）。 */
  readonly modeId: string;
  /** `model_extra_params`（原样回传上游）。 */
  readonly extra: Record<string, unknown>;
}

interface CatalogFile {
  fetchedAt: number;
  botId: string;
  models: ModelEntry[];
}

let memory: CatalogFile | null = null;

/** 数字或数字字符串 → number。 */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 字符串或数字 → string。 */
function idOf(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 从一条菜单项构造模型。 */
function toEntry(row: Record<string, unknown>): ModelEntry | null {
  const id = idOf(row["model_item_key"]) || idOf(row["item_id"]);
  if (!id) return null;
  const name = typeof row["name"] === "string" && row["name"].trim() ? row["name"].trim() : id;

  let extra: Record<string, unknown> = {};
  const rawExtra = row["model_extra_params"];
  if (typeof rawExtra === "string") {
    try {
      const parsed = JSON.parse(rawExtra) as unknown;
      if (parsed && typeof parsed === "object") extra = parsed as Record<string, unknown>;
    } catch {
      /* 不是 JSON 就丢掉，别让脏数据进请求体 */
    }
  } else if (rawExtra && typeof rawExtra === "object") {
    extra = rawExtra as Record<string, unknown>;
  }

  const agentMode = num(row["agent_mode"]) ?? 0;
  const modeId = idOf(row["default_mode"]);
  // 思考档位只认 `menu_type`（0..7）。`item_id` / `model_item_key` 是菜单项编号
  // （如 10001），不是档位 —— 拿它当档位会被上游拒（`common invalid param`）。
  let deepThink = num(row["menu_type"]) ?? 0;
  if (deepThink < 0 || deepThink > 7) deepThink = 0;
  // 实测：mode_id=2 且 menu_type=4 时上游要的是 3
  if (modeId === "2" && deepThink === 4) deepThink = 3;

  return { id, name, deepThink, agentMode, modeId, extra };
}

/** 从 `brief_list` 响应里抽模型（含 `menu_conf.item_list`）。 */
export function parseCatalog(body: Record<string, unknown>): ModelEntry[] {
  const data = body["data"] as Record<string, unknown> | undefined;
  const entries = data?.["entry_list"];
  if (!Array.isArray(entries)) return [];
  const seen = new Map<string, ModelEntry>();
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const conf = entry["active_switch_conf"] as Record<string, unknown> | undefined;
    const menu = conf?.["menu_conf"] as Record<string, unknown> | undefined;
    const items = menu?.["item_list"];
    if (!Array.isArray(items)) continue;
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const model = toEntry(rawItem as Record<string, unknown>);
      if (model) seen.set(model.id, model);
    }
  }
  return [...seen.values()];
}

/** 把目录写进 upstream 的规格缓存（发对话要用）。 */
function publish(file: CatalogFile): void {
  upstream.setBotId(file.botId);
  const specs = new Map<
    string,
    { deepThink: number; agentMode: number; modeId: string; extra: Record<string, unknown> }
  >();
  for (const model of file.models) {
    specs.set(model.id, {
      deepThink: model.deepThink,
      agentMode: model.agentMode,
      modeId: model.modeId,
      extra: model.extra,
    });
  }
  upstream.setModelSpecs(specs);
}

/** 读磁盘缓存（不存在或损坏返回 null）。 */
function readCache(): CatalogFile | null {
  try {
    const raw = readFileSync(modelsCachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CatalogFile>;
    if (!Array.isArray(parsed.models) || !parsed.models.length) return null;
    return {
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      botId: typeof parsed.botId === "string" ? parsed.botId : "",
      models: parsed.models.filter((m) => m && typeof m.id === "string"),
    };
  } catch {
    /* 缓存文件损坏或格式过旧：当作没有缓存，让上层去上游拉一次 */
    return null;
  }
}

/** 拉一次上游目录并落盘。 */
async function fetchCatalog(credential: cred.Credentials): Promise<CatalogFile> {
  const botId = await upstream.fetchBotId(credential);
  const body = await upstream.fetchBriefList(credential, botId);
  const models = parseCatalog(body);
  if (!models.length) {
    throw new Error("豆包工作返回的模型目录为空或格式已变化");
  }
  const file: CatalogFile = { fetchedAt: Date.now(), botId, models };
  ensureDir();
  mkdirSync(modelsCacheDir(), { recursive: true });
  writeJsonFile(modelsCachePath(), file);
  return file;
}

/** 取目录（内存 → 磁盘 → 上游），失败时回落到已有缓存。 */
async function ensureCatalog(credential?: cred.Credentials): Promise<CatalogFile | null> {
  if (memory && Date.now() - memory.fetchedAt < TTL_MS) {
    publish(memory);
    return memory;
  }
  const disk = readCache();
  if (disk) {
    memory = disk;
    publish(disk);
    if (Date.now() - disk.fetchedAt < TTL_MS) return disk;
  }
  try {
    const c = credential ?? cred.load();
    const fresh = await fetchCatalog(c);
    memory = fresh;
    publish(fresh);
    return fresh;
  } catch {
    // 拉失败就用旧表，让已有模型继续可用；真没有才返回 null
    return memory ?? disk;
  }
}

/**
 * 对外暴露的模型 id（同步契约）。
 *
 * 返回的是**池模型名**（`deepseek-v4.1-flash` 这类家族名），不是上游
 * `model_item_key` —— 网关拿池名查统一注册表（`models.json` 的 `channels` 段）
 * 决定供给，再经 `resolveModel` 换成上游 id。返回上游 id 会让查表全部落空。
 *
 * 池名 → 上游 id 的映射由注册表持有（`models.json`），本模块只负责按注册表
 * 反查「上游 id 属于哪个池模型」。
 */
export function exposedIds(): string[] {
  return exposedIdsForChannel("doubaowork").map(([pool]) => pool);
}

/** 池模型名 → 上游 `model_item_key`；表外原样返回（共享层判定「不供」）。 */
export function resolveModel(name: string): string {
  const key = canonicalModelId(name);
  for (const [pool, upstream] of exposedIdsForChannel("doubaowork")) {
    if (pool === name || canonicalModelId(pool) === key) return upstream;
  }
  // 注册表没有时回落到目录里按展示名 / 上游 id 匹配（目录可能比注册表新）
  const current = memory ?? readCache();
  if (!current) return name;
  for (const model of current.models) {
    if (model.id === name || canonicalModelId(model.id) === key) return model.id;
    if (canonicalModelId(model.name) === key) return model.id;
  }
  return name;
}

/** 强制从上游重拉目录并落盘（`mx doubaowork models --refresh`）。 */
export async function refresh(): Promise<void> {
  const credential = cred.load();
  const fresh = await fetchCatalog(credential);
  memory = fresh;
  publish(fresh);
}

/**
 * 模型规格（供池层 `/v1/models` 透出）。
 *
 * 上游目录不带窗口 / 输出上限 / 倍率 —— 一律省略，让池层回落默认，
 * 不编造数字（编造会让客户端按假窗口算钱）。
 */
export function modelSpec(_modelId: string): undefined {
  void _modelId;
  return undefined;
}

/** 供 billing / 上游侧读当前目录（内部用）。 */
export async function currentModels(credential?: cred.Credentials): Promise<ModelEntry[]> {
  const file = await ensureCatalog(credential);
  return file?.models ?? [];
}

/** 供 chat 侧保证 bot_id 与规格已就绪。 */
export async function prepare(credential?: cred.Credentials): Promise<void> {
  await ensureCatalog(credential);
}

/** 测试用：清空内存缓存。 */
export function resetMemory(): void {
  memory = null;
}
