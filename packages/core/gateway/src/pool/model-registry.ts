/**
 * 统一模型注册表（`<root>/models.json`）：卖哪几个模型、各家上游怎么叫、规格多少。
 *
 * 一份文件承载规格、供给范围、上游 id 映射三件事；**不按渠道拆分** —— 规格是产品
 * 决策，拆开后同一模型会出现十几个不同数字，聚合值与实际能不能跑无关（2026-11-08
 * 实测 traecn 上游不返回输出上限，报出的 65,536 是共享层兜底常量）。
 *
 * 落点见 docs/STORAGE-CONVENTION.md；字段契约见 docs/CONTRACT-TS.md §4.1。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POOL_EXPOSED_IDS, POOL_MODEL_IDS, canonicalOf } from "./model-family.js";
import { rootFile } from "../runtime/paths.js";

/** 一个模型在注册表里的声明。 */
export interface RegistryModel {
  /** 上下文窗口（对外报值，客户端按它算预算）。 */
  contextWindow: number;
  /** 单次回复最大输出。 */
  maxOutput: number;
  /** 输入模态（`text` / `image`）。 */
  inputModalities: string[];
  /** 渠道 cid → 该渠道上游的模型 id（请求体里的真名）。 */
  channels: Record<string, string>;
}

/** 注册表文件结构。 */
export interface ModelRegistry {
  version: 1;
  models: Record<string, RegistryModel>;
}

/** 注册表文件名（根级，与 `pool-usage.json` 并列）。 */
export const MODEL_REGISTRY_FILE = "models.json";

/**
 * 注册表的绝对路径：`MODELMUX_REGISTRY_FILE` > `<root>/models.json`。
 *
 * 落点约定见 docs/STORAGE-CONVENTION.md。
 */
export function modelRegistryPath(): string {
  const override = process.env["MODELMUX_REGISTRY_FILE"];
  if (override && override.trim() !== "") return override;
  return rootFile(MODEL_REGISTRY_FILE);
}

/** 一次读取的结果：表本体 + 来源（诊断用）。 */
export interface RegistryLoad {
  registry: ModelRegistry;
  /** `file` = 读到了磁盘文件；`builtin` = 文件缺失/损坏，用了随包默认表。 */
  source: "file" | "builtin";
  /** 读文件失败时的原因（`source: "builtin"` 时存在）。 */
  error?: string;
}

/** 条目形状校验：任何一个字段不合法就把整份表判为损坏（不猜、不修补）。 */
function parseModel(value: unknown): RegistryModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const contextWindow = row["contextWindow"];
  const maxOutput = row["maxOutput"];
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  if (typeof maxOutput !== "number" || !Number.isFinite(maxOutput) || maxOutput <= 0) return null;
  const modalities = row["inputModalities"];
  const inputModalities =
    Array.isArray(modalities) && modalities.every((m) => typeof m === "string")
      ? (modalities as string[])
      : ["text"];
  const channelsRaw = row["channels"];
  if (!channelsRaw || typeof channelsRaw !== "object" || Array.isArray(channelsRaw)) return null;
  const channels: Record<string, string> = {};
  for (const [cid, upstream] of Object.entries(channelsRaw as Record<string, unknown>)) {
    // 上游 id 必须是非空字符串：空串会让请求带着空 model 打上游
    if (typeof upstream !== "string" || upstream.trim() === "") return null;
    channels[cid] = upstream;
  }
  return { contextWindow, maxOutput, inputModalities, channels };
}

/**
 * 解析整份 `{version, models}` 文档；任一模型不合法或不在家族表内就整体判失败。
 */
function parseRegistry(doc: unknown): ModelRegistry | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const rowsRaw = (doc as Record<string, unknown>)["models"];
  if (!rowsRaw || typeof rowsRaw !== "object" || Array.isArray(rowsRaw)) return null;
  const models: Record<string, RegistryModel> = {};
  for (const [id, value] of Object.entries(rowsRaw as Record<string, unknown>)) {
    const row = parseModel(value);
    const canonical = row ? canonicalOf(id) : null;
    if (!row || !canonical) return null;
    models[canonical] = row;
  }
  return { version: 1, models };
}

/**
 * 随包默认表的路径：`packages/core/gateway/models.json`（bundle 后为 `<bundleDir>/models.json`）。
 *
 * 默认表是**数据文件**而不是代码字面量：共享层禁止硬编码厂商模型名
 * （`scripts/verify-contract.mjs` 强制，唯一落点是 `pool/model-family.ts`），
 * 上游 id 映射（`sn-deepseek-v4-1-flash-1017`、`gfmodel` 等）属于渠道知识，
 * 更该跟着数据走 —— 换渠道实现时改文件即可，不必动代码。
 */
/**
 * 随包默认表的候选路径（两种布局）：
 *   - 非 bundle：本模块在 `<gateway>/dist/pool/`，表在包根 → 上溯两级
 *   - 单文件 bundle：`import.meta.url` 指向 `packages/cli/dist/cli.bundle.js`，
 *     表由 bundle 步骤复制到同目录 → 同级
 */
function bundledDefaultCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "models.json"), join(here, "..", "..", "models.json")];
}

/** 随包默认表；读不到为 `null`（此时缺文件 = 空模型池，不猜）。 */
const DEFAULT_REGISTRY: ModelRegistry | null = (() => {
  for (const path of bundledDefaultCandidates()) {
    try {
      const parsed = parseRegistry(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch {
      // 换下一个候选路径
    }
  }
  return null;
})();

/**
 * 读注册表。文件缺失或损坏时回落**随包默认表**，**不抛错**。
 *
 * 不缓存：文件是用户可改的静态配置，改完重启即生效；一次请求只读一次盘（几 KB），
 * 比起「缓存导致改完不生效」更值得。
 */
export function loadModelRegistry(): RegistryLoad {
  const fallback = DEFAULT_REGISTRY;
  if (!fallback) {
    return {
      registry: { version: 1, models: {} },
      source: "builtin",
      error: "随包默认表缺失或损坏",
    };
  }
  const path = modelRegistryPath();
  if (!existsSync(path)) return { registry: fallback, source: "builtin" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { registry: fallback, source: "builtin", error: String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { registry: fallback, source: "builtin", error: `不是合法 JSON：${String(err)}` };
  }
  const registry = parseRegistry(parsed);
  if (!registry) {
    return { registry: fallback, source: "builtin", error: "注册表字段不合法，已用随包默认表" };
  }
  return { registry, source: "file" };
}

/** 注册表里的模型 id（按家族表顺序，只列注册表里真有的）。 */
export function registryModelIds(): string[] {
  const { registry } = loadModelRegistry();
  return POOL_MODEL_IDS.filter((id) => registry.models[id] !== undefined);
}

/** 某模型的声明；不在注册表里返回 `undefined`。 */
export function registryModelOf(model: string): RegistryModel | undefined {
  const canonical = canonicalOf(model);
  if (!canonical) return undefined;
  return loadModelRegistry().registry.models[canonical];
}

/** 提供某模型（规范名）的渠道 cid 列表。 */
export function providersOf(model: string): string[] {
  const row = registryModelOf(model);
  return row ? Object.keys(row.channels) : [];
}

/**
 * 某渠道对某模型的上游 id；该渠道不提供这个模型时返回 `undefined`。
 *
 * 匹配大小写不敏感：注册表里的 cid 全小写，调用方传进来的可能带原始大小写。
 */
export function upstreamIdOf(model: string, cid: string): string | undefined {
  const row = registryModelOf(model);
  if (!row) return undefined;
  const key = Object.keys(row.channels).find((k) => k.toLowerCase() === cid.toLowerCase());
  return key === undefined ? undefined : row.channels[key];
}

/**
 * 某渠道供哪些对外模型（`[对外名, 上游名]` 对），按家族表顺序。
 *
 * 给 `mx model <cid>` 与控制台渠道行用：供给范围以**注册表**为准，不再读渠道目录 ——
 * 渠道那份 `models.json` 已取消（见 docs/MODEL-CATALOG.md），全新安装下没有可读的表。
 */
export function exposedIdsForChannel(cid: string): Array<[model: string, upstream: string]> {
  const { registry } = loadModelRegistry();
  const out: Array<[string, string]> = [];
  for (const id of POOL_EXPOSED_IDS) {
    const row = registry.models[id];
    if (!row) continue;
    const upstream = upstreamIdOf(id, cid);
    if (upstream !== undefined) out.push([id, upstream]);
  }
  return out;
}
