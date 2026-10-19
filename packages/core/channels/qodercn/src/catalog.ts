/**
 * Qoder 模型目录：**动态拉取**（COSY 签名）+ 静态兜底。
 *
 * ## 对外名 ≠ 上游 key
 *
 * Qoder 的模型 id 是**短 key**（`gfmodel` 等），不是模型名，所以本模块做一层映射：
 * 已知 key 走显式映射（`gfmodel` → `glm-5.3-flash`），其余用上游展示名归一化。
 *
 * ## 全模型池
 *
 * 上游目录里的模型**全部**对外暴露（不再按 flash 家族过滤）。
 *
 * ## 三源优先级（参考实现同款）
 *
 * 1. 动态 `GET /algo/api/v2/model/list?Encode=1`（COSY 签名，`refresh()` 拉）
 * 2. 本机磁盘缓存 `cache/models.json`（上一次拉到的结果，**离线可用**）
 * 3. 内置兜底表（连缓存都没有时）
 *
 * 之所以需要 2：网关启动时可能未登录 / 上游不可达，此时仍要能列出模型，
 * 否则「池子为空」会被误读成渠道坏了。
 */

import { readCatalogCache, writeCatalogCache } from "@modelmux/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 一条模型条目（本渠道内部形态）。 */
export interface ModelEntry {
  /** 上游 key（`x-model-key` / 请求体 `model_config.key` 用它）。 */
  key: string;
  /** 对外 id（池内名）。 */
  id: string;
  displayName: string;
  isReasoning: boolean;
  isVl: boolean;
  maxInputTokens: number;
  /** 最大输出 token（上游不下发，按公开规格补；见 `MAX_OUTPUTS`）。 */
  maxOutput?: number;
}

/**
 * 已知模型的**最大输出 token**（上游目录不下发，按公开规格补）。
 *
 * ⚠ 只列**真实模型**：`auto` / `efficient` / `ultimate` 等是平台的**策略档位**
 * （按账号档位路由到不同底层模型），没有单一规格，故不列。
 *
 * ⚠ 公开规格是**模型上限**，上游可能更严（超限回 400）—— 客户端应能降档重试。
 * 数值与来源见 `docs/MODEL-SPECS.md`（唯一事实源；渠道表在本文件的 `MAX_OUTPUTS`）。
 */
const MAX_OUTPUTS: Readonly<Record<string, number>> = {
  "deepseek-flash": 393_216,
  "deepseek-v4-pro": 393_216,
  "glm-5.2": 131_072,
  "glm-5.3": 131_072,
  "glm-5.3-flash": 131_072,
  "kimi-k3": 1_048_576,
  "minimax-m2.7": 131_072,
  "minimax-m3": 131_072,
  "qwen3.7-flash": 131_072,
  "qwen3.7-max": 131_072,
  "qwen3.7-plus": 131_072,
  "qwen3.8-flash": 131_072,
  "qwen3.8-max": 131_072,
};

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * `modelId` 是池内的**归一化 id**（与 `exposedIds()` 同形），故直接查表。
 * **查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const maxOutputTokens = MAX_OUTPUTS[modelId.toLowerCase()];
  if (maxOutputTokens === undefined) return undefined;
  return { maxOutputTokens };
}

/**
 * 上游 key → 池内 id 的**已知映射**。
 *
 * 只列「上游 key 与展示名对不上」的条目（如 `gfmodel` → `glm-5.3-flash`）；
 * 未列出的 key 用上游展示名归一化后作为对外 id（见 `toEntry`）。
 *
 * 全模型池：不再把非映射条目标在池外 —— 上游目录里的模型都会暴露。
 */
const POOL_KEY_MAP: Record<string, string> = {
  gfmodel: "glm-5.3-flash",
};

/**
 * 兜底表：连磁盘缓存都没有时用（未登录 / 上游不可达时的离线目录）。
 *
 * **数据来源**：国内版官方目录静态快照（14 条），抄自
 * `reference/shuishuipingan_qoder2api-hub/qoder_catalog_cn.json`
 * （上游仓库 `shuishuipingan/qoder2api-hub`；2026-10-20 随参考实现克隆时抄录）。
 * [参考]
 *
 * ⚠ **只抄数据**（`key` / `display_name` / `is_vl` / `is_reasoning` / `max_input_tokens`），
 * 不抄参考实现的任何逻辑；归一化仍走本文件的 `toEntry`，
 * 保证兜底表与动态目录产出**完全同形**的对外 id。
 *
 * ⚠ `context_config`（1M / 200K / 400K 多窗口）与 `price_factor` **不抄**：
 * 池层是从**磁盘缓存**的原始条目读档位表与倍率的
 * （`packages/core/gateway/src/pool/pool-targets.ts:249-264`、`:287`），
 * 兜底表不落缓存、进不了那条路径，抄进来只是死数据。
 *
 * ⚠ `auto` 是平台的**策略档位**（按账号档位路由到不同底层模型），
 * 没有单一规格，故 `MAX_OUTPUTS` 不列它 —— 但上游目录里有它，兜底表也要有，
 * 否则兜底态的池子比刷新态少一条。
 */
const FALLBACK_RAW: ReadonlyArray<Record<string, unknown>> = [
  { key: "auto", display_name: "Auto", is_vl: true, is_reasoning: true, max_input_tokens: 200_000 },
  {
    key: "qmodel_38max",
    display_name: "Qwen3.8-Max",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "qfmodel",
    display_name: "Qwen3.8-Flash",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "qmodel_latest",
    display_name: "Qwen3.7-Max",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "qmodel",
    display_name: "Qwen3.7-Plus",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "q37fmodel",
    display_name: "Qwen3.7-Flash",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "dmodel",
    display_name: "DeepSeek-V4-Pro",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 96_000,
  },
  {
    key: "dfmodel",
    display_name: "DeepSeek-Flash",
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 180_000,
  },
  {
    key: "gmodel",
    display_name: "GLM-5.3",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "gfmodel",
    display_name: "GLM-5.3-Flash",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 1_000_000,
  },
  {
    key: "gm51model",
    display_name: "GLM-5.2",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "kmodel_latest",
    display_name: "Kimi-K3",
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 180_000,
  },
  {
    key: "kmodel",
    display_name: "Kimi-K2.8-Preview",
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000,
  },
  {
    key: "mmodel",
    display_name: "MiniMax-M2.7",
    is_vl: false,
    is_reasoning: false,
    max_input_tokens: 180_000,
  },
];

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 展示名 → 对外 id（小写、空格与下划线转连字符）。 */
function toPublicId(displayName: string, key: string): string {
  const base = displayName.trim() || key;
  return base.toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * 官方目录条目 → 内部条目。
 *
 * 全模型池：**所有**目录条目都保留 —— 已知 key 走 `POOL_KEY_MAP` 的显式映射，
 * 其余用展示名归一化作为对外 id（无展示名时退回 key 本身）。
 */
function toEntry(raw: Record<string, unknown>): ModelEntry | null {
  const key = str(raw["key"]) || str(raw["id"]);
  if (!key) return null;
  const displayName = str(raw["display_name"]) || str(raw["name"]) || key;
  const id = POOL_KEY_MAP[key] ?? toPublicId(displayName, key);
  // 规格表优先；缓存行里已带 maxOutput 的（刷新时写入的）也认。
  const spec = MAX_OUTPUTS[id.toLowerCase()];
  const cached = num(raw["maxOutput"], 0);
  const maxOutput = spec ?? (cached > 0 ? cached : undefined);
  return {
    key,
    id,
    displayName,
    isReasoning: raw["is_reasoning"] === true,
    isVl: raw["is_vl"] === true,
    maxInputTokens: num(raw["max_input_tokens"], 180_000),
    ...(maxOutput === undefined ? {} : { maxOutput }),
  };
}

/** 读目录：磁盘缓存优先，缓存缺失/为空时退回内置表。 */
export function loadCatalog(): ModelEntry[] {
  try {
    // 缓存条目运行期带着渠道自己的字段（key / display_name…），类型上只保证 `id`
    const cached = readCatalogCache();
    if (cached && cached.length > 0) {
      const mapped = cached
        .map((item) => toEntry(item as unknown as Record<string, unknown>))
        .filter((entry): entry is ModelEntry => entry !== null);
      if (mapped.length > 0) return mapped;
    }
  } catch {
    /* 缓存读不出来就用兜底表 —— 目录不可用不该让整个渠道消失 */
  }
  // 兜底表走同一条 `toEntry` 归一化：对外 id 与动态目录完全一致
  const fallback = FALLBACK_RAW.map((raw) => toEntry(raw)).filter(
    (entry): entry is ModelEntry => entry !== null,
  );
  return fallback;
}

/** 对外暴露的模型 id（池内名；去重、保持目录顺序）。 */
export function exposedIds(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loadCatalog()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}

/** 按对外 id 取完整条目（供 upstream 填 `model_config` 元数据）。 */
export function entryOf(name: string): ModelEntry | null {
  const wanted = name.toLowerCase();
  return loadCatalog().find((entry) => entry.id.toLowerCase() === wanted) ?? null;
}

/**
 * 对外 id（或上游 key）→ 上游 key。
 *
 * 三种输入都认：池内名（`glm-5.3-flash`）、上游 key（`gfmodel`）、
 * 上游展示名（`GLM-5.3-Flash`）—— 排查时手写哪种都能通。未命中则原样返回。
 */
export function resolveModel(name: string): string {
  const wanted = name.toLowerCase();
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
 * 上游返回 `payload.chat[]`，每条以 `key` 为模型 id。落盘走共享的目录缓存
 * （`<root>/qoder/cache/models.json`），**不裁剪字段** —— 以后要放宽池策略时
 * 不必重新拉。
 */
export async function refresh(): Promise<void> {
  const credential = cred.load();
  const payload = await upstream.fetchModels(credential);
  const chat = Array.isArray(payload["chat"]) ? (payload["chat"] as unknown[]) : [];
  const entries = chat
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const key = str(item["key"]);
      const displayName = str(item["display_name"]) || str(item["name"]) || key;
      const id = POOL_KEY_MAP[key] ?? toPublicId(displayName, key);
      // 原始字段全留（不裁剪），另附**按公开规格补的**最大输出（上游不下发）。
      const spec = MAX_OUTPUTS[id.toLowerCase()];
      return { ...item, id: key, ...(spec === undefined ? {} : { maxOutput: spec }) };
    })
    .filter((item) => str(item["id"]) !== "");
  if (entries.length === 0) throw new Error("upstream model list is empty");
  writeCatalogCache(entries);
}
