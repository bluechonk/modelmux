/**
 * AutoClaw 模型目录：远程 model 配置拉取 + 磁盘缓存 + 随包兜底表。
 *
 * 关键约束（端点/字段/实测见 docs/channels/autoclaw/PROTOCOL.md）：
 *   - 对外只暴露 glm-5.3-flash；其余后端模型（zai、zaicoding、tdpsk 各路由）留在目录里
 *     但由 models.json 的 hidden 标记挡在池外（数据在 models.json，机制在共享层）。
 *   - 远程配置的 id 是桌面路由名（zai_glm-5.3-flash），relay 头认的是 glm-5.3-flash，
 *     两者经 POOL_KEY_MAP 收口。
 */

import {
  canonicalModelId,
  ensureChannelModels,
  hiddenModelIds,
  readCatalogCache,
  writeCatalogCache,
} from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 一条模型条目（本渠道内部形态）。 */
interface ModelEntry {
  /** 上游 key（x-openclaw-model 头的值）。 */
  key: string;
  /** 对外 id（池内名）。 */
  id: string;
  displayName: string;
  isReasoning: boolean;
  isVl: boolean;
  maxInputTokens: number;
  /** 最大输出 token（远程配置的 maxTokens；无则按用户目录表补）。 */
  maxOutput?: number;
  /** 对外隐藏（数据在 `models.json`）：目录里保留，但不进对外模型池。 */
  hidden?: boolean;
}

/**
 * 远程配置 id → 对外 id 的**已知映射**。
 *
 * 桌面路由名 `zai_glm-5.3-flash` 与 relay 头实测可用的 `glm-5.3-flash` 指同一后端
 * 模型；对外统一用 relay 实测名（key 同步改写），否则刷新后目录里就没有可暴露行。
 * 其余配置 id 本身就是 relay 可用的后端模型名，恒等映射。
 */
const POOL_KEY_MAP: Record<string, string> = {
  "zai_glm-5.3-flash": "glm-5.3-flash",
};

/** 随包快照候选路径（懒算：渠道上下文建立前 `bundledSnapshotPath()` 拿不到值）。 */
function seedPaths(): Array<string | null> {
  return [bundledSnapshotPath(), packageSnapshotPath(import.meta.url)];
}

/**
 * 对外隐藏的模型集合（数据是 `models.json` 的 `hidden` 标记；并集 / 失败关闭等机制见
 * 共享层 `hiddenModelIds`）。收 id 与上游 key 两种写法：上游改名不该让策略失效。
 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url, ["key"]);
}

/** 按 id 查用户目录模型表里的最大输出（规格是数据，落 `models.json`；查不到不编造）。 */
function specOf(modelId: string): { maxOutputTokens?: number } | undefined {
  const k = modelId.toLowerCase();
  const row = ensureChannelModels<ModelEntry>(undefined, seedPaths())?.find(
    (e) => e.id.toLowerCase() === k,
  );
  return row?.maxOutput === undefined ? undefined : { maxOutputTokens: row.maxOutput };
}

/** 已知模型规格（供池层 `/v1/models` 透出；`modelId` 是池内归一化 id）。 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = specOf(modelId)?.maxOutputTokens;
  if (maxOutputTokens === undefined) return undefined;
  return { maxOutputTokens };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 缓存条目：运行期带着上游原始字段，类型上只保证 `id`（见共享层 `catalog-cache.ts`）。 */
type CacheRow = Record<string, unknown> & { id: string };

/**
 * 远程配置条目 → 内部条目。
 *
 * **所有**目录条目都保留（已知 id 走 `POOL_KEY_MAP`，其余恒等映射）—— 是不是对外
 * 暴露由 `hiddenIds()` 事后过滤。多模态/推理标记：远程配置的 reasoning 字段可信，
 * 图文能力沿参考实现的模型说明标注。
 */
function toEntry(raw: Record<string, unknown>): ModelEntry | null {
  const configId = str(raw["id"]) || str(raw["name"]);
  if (!configId) return null;
  const id = POOL_KEY_MAP[configId] ?? configId;
  const displayName = str(raw["name"]) || configId;
  const spec = specOf(id)?.maxOutputTokens;
  const cached = num(raw["maxTokens"], 0);
  const maxOutput = spec ?? (cached > 0 ? cached : undefined);
  return {
    key: id,
    id,
    displayName,
    isReasoning: raw["reasoning"] === true,
    isVl: true,
    maxInputTokens: num(raw["contextWindow"], 200_000),
    ...(maxOutput === undefined ? {} : { maxOutput }),
  };
}

/** 读目录：磁盘缓存优先（每次映射走同一套），缓存缺失/为空时退回随包兜底表。 */
function loadCatalog(): ModelEntry[] {
  try {
    const cached = readCatalogCache();
    if (cached && cached.length > 0) {
      const mapped = cached
        .map((item) => toEntry(item as unknown as CacheRow))
        .filter((entry): entry is ModelEntry => entry !== null);
      if (mapped.length > 0) return mapped;
    }
  } catch {
    /* 缓存读不出来就用兜底表 —— 目录不可用不该让整个渠道消失 */
  }
  // 兜底走用户目录模型表（首启由随包 models.json 浇种）：条目已是归一化产物，直接读
  return ensureChannelModels<ModelEntry>(undefined, seedPaths()) ?? [];
}

/** 对外暴露的模型 id（池内名；去重、保持目录顺序；`hidden` 的不暴露）。 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loadCatalog()) {
    // 三种写法都判：id（小写）、上游 key、归一化规范名 —— 池层会把尾饰变体归一进
    // 同一家族，只按原始 id 匹配会被绕过
    if (hidden.has(entry.id.toLowerCase())) continue;
    if (hidden.has(entry.key.toLowerCase())) continue;
    if (hidden.has(canonicalModelId(entry.id))) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}

/**
 * 对外 id（或上游 key）→ 上游 key（x-openclaw-model 头的值）。
 *
 * 三种输入都认：池内名（`glm-5.3-flash`）、上游 key、上游展示名 —— 排查时手写哪种
 * 都能通。未命中则原样返回。
 */
export function resolveModel(name: string): string {
  const wanted = name.trim().toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === wanted) return entry.key;
    if (entry.key.toLowerCase() === wanted) return entry.key;
    if (entry.displayName.toLowerCase() === wanted) return entry.key;
  }
  return name;
}

/**
 * 强制从上游重拉目录并落盘（CLI 的 `--refresh` 用；失败**抛错**）。
 *
 * 落盘走共享的目录缓存（`<root>/autoclaw/cache/models.json`），**不裁剪字段**。
 * 拉到的表必须仍含可暴露的 glm-5.3-flash（映射后），否则视为上游表变了 ——
 * 抛错保留旧缓存，绝不把渠道自己的供给模型刷没。
 */
export async function refresh(): Promise<void> {
  const credential = cred.load();
  const payload = await upstream.fetchModels(credential);
  const models = Array.isArray(payload["models"]) ? (payload["models"] as unknown[]) : [];
  const entries: Array<Record<string, unknown>> = [];
  for (const item of models) {
    const raw = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!raw) continue;
    const entry = toEntry(raw);
    if (!entry) continue;
    // 原始字段全留（不裁剪），附上归一化的 id/key 供下次 toEntry 直读
    entries.push({ ...raw, id: entry.id, key: entry.key });
  }
  if (entries.length === 0) throw new Error("upstream model config is empty");
  if (!entries.some((item) => str(item["id"]) === "glm-5.3-flash")) {
    throw new Error("upstream model config no longer contains glm-5.3-flash; keeping the previous catalog");
  }
  // 缓存条目的类型下限就是「有 id」（其余字段原样保留，见 CachedModel）
  writeCatalogCache(entries as Array<Record<string, unknown> & { id: string }>);
}
