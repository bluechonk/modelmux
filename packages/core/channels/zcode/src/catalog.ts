/**
 * ZCode 模型目录：纯内置快照（上游没有模型清单端点）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/zcode/PROTOCOL.md）：
 *   - 参考实现的 /v1/models 是写死的静态表 → 本渠道无远端目录层：不实现 refresh()、不写缓存。
 *   - 对外只暴露 glm-5.3-flash；其余后端模型进目录但由 models.json 的 hidden 标记挡住。
 */

import { canonicalModelId, ensureChannelModels, hiddenModelIds } from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

/** 一条模型条目（本渠道内部形态）。 */
interface ModelEntry {
  /** 上游模型名（Anthropic 请求体 `model` 字段；大小写敏感，见 PROTOCOL §2.4）。 */
  key: string;
  /** 对外 id（池内名）。 */
  id: string;
  displayName: string;
  isReasoning?: boolean;
  isVl?: boolean;
  maxInputTokens?: number;
  maxOutput?: number;
  /** 对外隐藏（数据在 `models.json`）：目录里保留，但不进对外模型池。 */
  hidden?: boolean;
}

/**
 * 对外 id → 上游模型名。
 *
 * `glm-5.3-flash → GLM-5.3-Flash` 是**推断值**（参考实现的映射表先于 5.3-flash，
 * 按 `GLM-<版本>-<能力词>` 的形态规律补齐；真机核对前这是全渠道最脆的一项）。
 * 表里其余条目是参考实现 `MODEL_NAME_MAP` 逐字记录的后端名。
 */
const POOL_KEY_MAP: Record<string, string> = {
  "glm-5.3-flash": "GLM-5.3-Flash",
};

/**
 * 随包快照候选路径（隐藏策略与首启浇种的兜底来源）。
 *
 * **必须懒算**：`bundledSnapshotPath()` 依赖渠道上下文（`activeCid()`），
 * 模块加载期还没有上下文 —— 写成常量会永远拿到 `null`。
 */
function seedPaths(): Array<string | null> {
  return [bundledSnapshotPath(), packageSnapshotPath(import.meta.url)];
}

/**
 * 对外隐藏的模型（`models.json` 的 `hidden` 标记；并集 / 失败关闭机制见共享层）。
 * 收 id 与上游 key 两种写法：上游改名不该让策略失效。
 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url, ["key"]);
}

/** 读目录：用户模型表（首启由随包快照浇种）；读失败回空表 —— 目录不可用不该让渠道消失。 */
function loadCatalog(): ModelEntry[] {
  return ensureChannelModels<ModelEntry>(undefined, seedPaths()) ?? [];
}

/** 对外暴露的模型 id（池内名；去重、保持目录顺序；`hidden` 的不暴露）。 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loadCatalog()) {
    // 三种写法都判：id、上游 key、归一化规范名 —— 池层会把尾饰变体归一进同一家族
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
 * 已知模型规格（供池层 `/v1/models` 透出；`modelId` 是归一化池 id）。
 *
 * 规格**是数据**，落在 `models.json`；本函数只查表，查不到返回 `undefined`（不编造）。
 * `glm-5.3-flash` 的窗口 / 输出是 qodercn 同规范 id 的实测口径（跨渠道同源，见 PROTOCOL §6）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const wanted = modelId.toLowerCase();
  const row = loadCatalog().find((entry) => entry.id.toLowerCase() === wanted);
  if (!row) return undefined;
  const spec: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof row.maxInputTokens === "number") spec.contextWindow = row.maxInputTokens;
  if (typeof row.maxOutput === "number") spec.maxOutputTokens = row.maxOutput;
  return Object.keys(spec).length > 0 ? spec : undefined;
}

/**
 * 对外 id（或上游 key / 展示名）→ 上游模型名。
 *
 * 三种输入都认 —— 排查时手写哪种都能通。未命中则原样返回
 * （大小写敏感的最终裁决在上游：打错名拿到的 4xx 会带上游原文）。
 */
export function resolveModel(name: string): string {
  const wanted = name.trim().toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === wanted) return entry.key;
    if (entry.key.toLowerCase() === wanted) return entry.key;
    if (entry.displayName.toLowerCase() === wanted) return entry.key;
  }
  return POOL_KEY_MAP[wanted] ?? name;
}
