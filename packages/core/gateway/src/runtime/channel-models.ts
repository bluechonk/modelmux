/**
 * 渠道模型表（**用户目录里的 JSON**）：`<root>/channels/<cid>/models.json`。
 *
 * 模型清单与规格是**数据**，不该写死在渠道代码里 —— `catalog.ts` 只留
 * 「怎么取 / 怎么归一化 / id↔upstreamId 映射」。本模块是那份数据的读写口：
 * 首启从**随包种子**（渠道包根 `models.json`）浇一次，之后以用户文件为准（可手改、可被覆写）。
 *
 * 与 `catalog-cache.ts` 分工（同目录下的两个文件，勿混淆）：
 * `models.json` 是渠道自己的模型表（人可读可改）；`cache/models.json` 是上游目录的原样缓存。
 *
 * 铁律：读失败回 `null`（不抛错，调用方回落）；写走共享层原子写 + `0600`。
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { bundledSnapshotPath, packageSnapshotPath } from "./snapshot.js";
import { channelDir, channelFile, ensureDir } from "./paths.js";
import { writeAtomicFile } from "./secret-file.js";

/** 渠道模型表文件名（落在渠道层根，见 docs/STORAGE-CONVENTION.md §3）。 */
export const CHANNEL_MODELS_FILE = "models.json";

/** 表条目的**最小约束**：只要有 `id`；其余字段渠道自定义，JSON 往返原样保留。 */
export interface ChannelModelEntry {
  id: string;
}

/** 这份表从哪来 —— 排查「为什么模型变了」时第一眼要看的字段。 */
export type ChannelModelsSource = "seed" | "upstream" | "manual";

/** 文件信封：版本 + 来源 + 写入时刻 + 条目。 */
interface ChannelModelsEnvelope<T> {
  version: 1;
  source: ChannelModelsSource;
  fetched_at: string | null;
  models: T[];
}

function isEntry(value: unknown): value is ChannelModelEntry {
  return Boolean(value) && typeof value === "object" && typeof (value as ChannelModelEntry).id === "string";
}

/** 渠道模型表的绝对路径（不创建文件）。 */
export function channelModelsPath(cid?: string): string {
  return channelFile(CHANNEL_MODELS_FILE, cid);
}

/** 解析任意形状的 JSON 里的 `models` 数组；不是数组或为空 → `null`。 */
function parseModels<T extends ChannelModelEntry>(raw: string): T[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const models = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { models?: unknown }).models
      : null;
  if (!Array.isArray(models)) return null;
  const entries = models.filter(isEntry) as T[];
  return entries.length > 0 ? entries : null;
}

/** 读渠道模型表；文件缺失 / 损坏 / 空数组 → `null`。 */
export function readChannelModels<T extends ChannelModelEntry>(cid?: string): T[] | null {
  try {
    return parseModels<T>(readFileSync(channelModelsPath(cid), "utf8"));
  } catch {
    return null;
  }
}

/** 从候选路径里读第一份可用种子（缺失 / 空 → 试下一个）；全落空回 `null`。 */
export function readSeedFrom<T extends ChannelModelEntry>(paths: ReadonlyArray<string | null>): T[] | null {
  for (const path of paths) {
    if (!path) continue;
    try {
      const entries = parseModels<T>(readFileSync(path, "utf8"));
      if (entries) return entries;
    } catch {
      /* 该候选不可读：继续试下一个 */
    }
  }
  return null;
}

/** 参与隐藏匹配的行：`hidden` 标记 + 渠道自定义的可匹配键字段（上游 key、对外名等）。 */
type HiddenRow = ChannelModelEntry & Record<string, unknown>;

/**
 * 对外隐藏的模型 id 集合（数据是渠道 `models.json` 条目的 `hidden: true` 标记）。
 *
 * 收 **id 与 `fields` 指定的键**两种写法（小写）：对外 id 常由展示名派生，上游改名会让
 * 按 id 的匹配失效，按上游 key 匹配才稳。
 *
 * 并集读**用户表**与**随包快照**：用户表可手改（新增隐藏）；随包快照保证已存在的老安装
 * （首启已浇种、之后不再更新）也遵守同一策略。并集是**单向**的：任一来源标了隐藏就一定
 * 不暴露，用户表解除不了（策略优先于本地改动）。
 *
 * 随包快照路径**调用时现算**（bundle 布局与渠道包布局各一候选）—— 提前算成模块常量会在
 * 渠道上下文建立前求值，`bundledSnapshotPath()` 永远拿到 null。
 *
 * **随包快照读不到就抛错**（失败关闭）：隐藏策略的兜底来源没了还照常暴露，等于把该隐藏的
 * 模型悄悄放回池里；调用方会把异常按「目录读失败」处理，不会静默放行。只对「随包确实带
 * models.json」的渠道安全，没有快照的渠道不要用；快照**存在但 `models` 为空**同样抛错
 * （第三态，`parseModels` 对空表回 null）。已知边界：用户表**损坏**与**不存在**不可区分
 * （读失败回 null），此时用户手改追加的隐藏行会失效，策略退回随包快照口径。
 *
 * @param metaUrl 调用方模块的 `import.meta.url`（定位渠道包根的 models.json）
 * @param fields 条目里可作匹配键的额外字段（如上游 key、对外名）
 */
export function hiddenModelIds(metaUrl: string, fields: readonly string[] = []): Set<string> {
  const seed = readSeedFrom<HiddenRow>([bundledSnapshotPath(), packageSnapshotPath(metaUrl)]);
  if (seed === null) {
    throw new Error("bundled models.json unreadable; refusing to expose models with a broken hidden policy");
  }
  const out = new Set<string>();
  for (const row of [...(readChannelModels<HiddenRow>() ?? []), ...seed]) {
    if (row["hidden"] !== true) continue;
    for (const value of [row.id, ...fields.map((field) => row[field])]) {
      const key = typeof value === "string" ? value.toLowerCase() : "";
      if (key !== "") out.add(key);
    }
  }
  return out;
}

/**
 * 写渠道模型表（原子替换 + `0600`）。
 *
 * **写前先做快照**：覆盖会把旧表抹掉，而上游偶尔会返回空表 / 残缺表；
 * 没有快照就无从回退（用户会看到模型全消失）。快照失败不阻断写入 —— 它只是保险。
 *
 * @param source 这份表从哪来（`seed` / `upstream` / `manual`），写进信封供排查。
 * @returns 是否写成功
 */
export function writeChannelModels<T extends ChannelModelEntry>(
  entries: readonly T[],
  cid?: string,
  source: ChannelModelsSource = "manual",
): boolean {
  if (entries.length === 0) return false;
  const envelope: ChannelModelsEnvelope<T> = {
    version: 1,
    source,
    fetched_at: new Date().toISOString(),
    models: [...entries],
  };
  try {
    ensureDir(cid);
    snapshotChannelModels(cid);
    writeAtomicFile(channelModelsPath(cid), `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** 快照文件的保留份数（每份几十 KB，留 3 份足够跨越一次坏刷新）。 */
export const CHANNEL_MODELS_SNAPSHOTS = 3;

/** 快照文件名（与被保护文件同目录、同前缀，回退只需改后缀）。 */
function snapshotName(stamp: string, cid?: string): string {
  return `${channelModelsPath(cid)}.bak.${stamp}`;
}

/**
 * 把当前模型表复制成快照（覆盖前调用）。
 *
 * 时间戳精确到秒；**同一秒内重复快照时加序号后缀**（`-2`、`-3`…）——
 * 否则同秒的连续刷新会互相覆盖，只剩 1 份快照（单测逮到过）。
 *
 * @returns 快照路径；源文件不存在或复制失败 → `null`（不阻断主流程）
 */
export function snapshotChannelModels(cid?: string, at: Date = new Date()): string | null {
  const src = channelModelsPath(cid);
  if (!existsSync(src)) return null;
  const stamp = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let dest = snapshotName(stamp, cid);
  let seq = 2;
  while (existsSync(dest)) {
    dest = snapshotName(`${stamp}-${seq}`, cid);
    seq += 1;
    if (seq > 99) return null; // 异常防护：同一秒上百次刷新不是正常使用
  }
  try {
    copyFileSync(src, dest);
    pruneChannelModelsSnapshots(cid, CHANNEL_MODELS_SNAPSHOTS);
    return dest;
  } catch {
    return null;
  }
}

/** 只保留最近 `keep` 份快照（按文件名里的时间戳排序，删更旧的）。 */
export function pruneChannelModelsSnapshots(cid?: string, keep = CHANNEL_MODELS_SNAPSHOTS): void {
  const dir = channelDir(cid);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(`${CHANNEL_MODELS_FILE}.bak.`));
  } catch {
    return;
  }
  names.sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* 删不掉不影响主流程 */
    }
  }
}

/** 所有快照（按时间从新到旧）。 */
export function listChannelModelsSnapshots(cid?: string): string[] {
  try {
    return readdirSync(channelDir(cid))
      .filter((n) => n.startsWith(`${CHANNEL_MODELS_FILE}.bak.`))
      .sort()
      .reverse()
      .map((n) => join(channelDir(cid), n));
  } catch {
    return [];
  }
}

/**
 * 回退到最近一份**可用**快照（跳过空表 / 损坏文件）。
 *
 * @returns 回退用的快照路径；没有可用快照 → `null`
 */
export function rollbackChannelModels(cid?: string): string | null {
  for (const path of listChannelModelsSnapshots(cid)) {
    let entries: ChannelModelEntry[] | null = null;
    try {
      entries = parseModels<ChannelModelEntry>(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!entries) continue;
    try {
      copyFileSync(path, channelModelsPath(cid));
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 取渠道模型表：**用户文件优先，缺失则用随包种子浇一次**。
 *
 * @param seedPaths 候选种子路径，按序试第一个可用的；缺省只试 bundle 布局
 *   （`bundledSnapshotPath()`）。非 bundle 运行的渠道应再传入
 *   [`packageSnapshotPath(import.meta.url)`](../runtime/snapshot.js) 作为第二候选。
 * @returns 表条目；用户文件与种子都没有 → `null`（调用方按空表处理）
 */
export function ensureChannelModels<T extends ChannelModelEntry>(
  cid?: string,
  seedPaths: ReadonlyArray<string | null> = [bundledSnapshotPath()],
): T[] | null {
  const existing = readChannelModels<T>(cid);
  if (existing) return existing;
  const seeded = readSeedFrom<T>(seedPaths);
  if (!seeded) return null;
  writeChannelModels(seeded, cid, "seed");
  return seeded;
}

/**
 * 首启浇种：把构造好的兜底条目写进用户文件（**只在文件不存在时**）。
 *
 * 给「既有快照解析、又有代码内兜底表」的渠道用：先按渠道自己的解析链拿到条目，
 * 首次运行时固化成 `<root>/channels/<cid>/models.json`，之后一律读该文件。
 *
 * @returns 落定后的表条目（写入成功返回入参，已有文件则返回文件内容）
 */
export function seedChannelModels<T extends ChannelModelEntry>(
  entries: readonly T[],
  cid?: string,
): T[] | null {
  const existing = readChannelModels<T>(cid);
  if (existing) return existing;
  if (entries.length === 0) return null;
  writeChannelModels(entries, cid, "seed");
  return [...entries];
}
export function channelModelsMeta(cid?: string): { source: string | null; fetched_at: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(channelModelsPath(cid), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const e = parsed as Partial<ChannelModelsEnvelope<unknown>>;
    return {
      source: typeof e.source === "string" ? e.source : null,
      fetched_at: typeof e.fetched_at === "string" ? e.fetched_at : null,
    };
  } catch {
    return null;
  }
}
