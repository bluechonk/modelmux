/**
 * AStudio 模型目录：随包内置的静态表（倍率、上下文窗口、档位）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md）：
 *   - 模型清单**随应用包内置**（`provider-model-catalog-v1.json`），不发网络请求；
 *     故本模块**不实现 `refresh()`**（无远端目录层可刷）。
 *   - **倍率来自云端配置**（`/bot/models/configs` 的 `point_multiplier`，实测 x0.5~x2.0），
 *     不来自模型名（与 loomy 相反）—— 故本表是实测快照，不是解析出来的。
 *   - **id 有两套**：应用内置目录用 `spark-x2.6-4b` 这类 slug，模型网关配置用
 *     `xopglm52` 这类 model 字段。网关**只接受后者那一族**（实测 `xopdsv4flash` 回 400
 *     `no category route found`）。本模块暴露**短名**（对齐内置目录的展示名），
 *     内部映射到网关接受的 id。
 */

/** 内置目录的展示名（与官方界面一致）。 */
export interface ModelSpec {
  /** 池内暴露的模型 id（短名，对齐应用内置目录的展示名）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 模型网关接受的 model id（`/bot/models/configs` 的 `model` 字段）。 */
  upstreamId: string;
  /**
   * 消耗倍率（云端 `point_multiplier` 实测值）；**`undefined` = 未知**。
   *
   * ⚠ 云端 `/bot/models/configs` 只对**部分**模型给 `point_multiplier`（实测 9 行里
   * 只有 8 行有值，且 id 与本表 exposure 只有 2 个对得上）。此前给对不上的 5 个
   * 模型一律填 `1`，那是**无源填 1**（客户端会按它算钱）—— 2026-10-26 改为 `undefined`。
   */
  multiplier: number | undefined;
  contextWindow: number;
  maxOutputTokens: number;
  /** 该模型支持的思考档位（实测自内置目录）。 */
  efforts: string[];
  defaultEffort: string;
}

/**
 * 内置模型表（7 条）。
 *
 * 来源（实测 2026-10-26）：
 * - `id` / `name` / `efforts` / `defaultEffort`：应用内置目录 `provider-model-catalog-v1.json`；
 * - `upstreamId` / `multiplier`：云端 `GET /xingchen-studio/bot/models/configs`
 *   （`model` 与 `point_multiplier` 字段，9 行）；
 * - `contextWindow` / `maxOutputTokens`：应用内置 `model-gateway/catalog-<hash>.json`。
 *
 * ⚠ `xopdeepseekv4pro` 与 `xopdeepseekv4pro0813` 网关**都接受**（实测 200），
 *   本表取无日期后缀的那个（与云端配置的 `model` 字段一致）。
 *
 * ⚠ **倍率只有 2 个模型有实测值**（`xopglm52` 与 `xopdeepseekv4pro`，均 `x2.0`）。
 *   其余 5 个在云端**没有对应行**（`spark-x2.6` / `spark-x2.6-4b` / `spark-x2.5` /
 *   `xopdsv4flash0731in` 都不在云端那 9 行里，`astronclaw-auto` 的
 *   `point_multiplier` 为 `null`）→ 一律 `undefined`，池层显示「免费」（订阅制，
 *   `capabilities.billing: false`）而不是编造的 `1`。
 */
const MODELS: ModelSpec[] = [
  {
    id: "auto",
    name: "Auto",
    upstreamId: "astronclaw-auto",
    // 云端 point_multiplier = null（自动路由，无固定倍率）
    multiplier: undefined,
    contextWindow: 262_144,
    maxOutputTokens: 100_000,
    efforts: ["none", "high"],
    defaultEffort: "high",
  },
  {
    id: "spark-x2.6",
    name: "Spark-X2.6",
    upstreamId: "spark-x2.6",
    // 云端无此行（云端是 xsparkx2agent=x2.0 与 spark-x=x0.5，都不是它）
    multiplier: undefined,
    contextWindow: 262_144,
    maxOutputTokens: 100_000,
    efforts: ["none", "high"],
    defaultEffort: "high",
  },
  {
    id: "spark-x2.6-lite",
    name: "Spark-X2.6-Lite",
    upstreamId: "spark-x2.6-4b",
    // 云端无此行
    multiplier: undefined,
    contextWindow: 1_048_576,
    maxOutputTokens: 110_000,
    efforts: ["none", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "spark-x2.5",
    name: "Spark-X2.5",
    upstreamId: "spark-x2.5",
    // 云端无此行
    multiplier: undefined,
    contextWindow: 262_144,
    maxOutputTokens: 100_000,
    efforts: ["none", "high"],
    defaultEffort: "high",
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    upstreamId: "xopglm52",
    // 云端实测 point_multiplier = "x2.0"
    multiplier: 2,
    contextWindow: 1_048_576,
    maxOutputTokens: 100_000,
    efforts: ["none", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    upstreamId: "xopdeepseekv4pro",
    // 云端实测 point_multiplier = "x2.0"
    multiplier: 2,
    contextWindow: 1_048_576,
    maxOutputTokens: 100_000,
    efforts: ["none", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    upstreamId: "xopdsv4flash0731in",
    // 云端无此行
    multiplier: undefined,
    contextWindow: 1_048_576,
    maxOutputTokens: 100_000,
    efforts: ["none", "high", "max"],
    defaultEffort: "high",
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const BY_UPSTREAM = new Map(MODELS.map((m) => [m.upstreamId, m]));

/** 对外暴露的模型 id（恒小写，按内置目录的展示顺序）。 */
export function exposedIds(): string[] {
  return MODELS.map((m) => m.id);
}

/**
 * 池内 id → 上游 model id。
 *
 * 接受三种写法：短名（`spark-x2.6`）、内置目录 slug（`xopglm52`）、
 * 网关 model 字段（`xopglm52`）。认不出来时**原样返回**（与 loomy 同语义）。
 */
export function resolveModel(name: string): string {
  const direct = BY_ID.get(name) ?? BY_UPSTREAM.get(name);
  if (direct) return direct.upstreamId;
  return name;
}

/**
 * 模型规格（供池层 `/v1/models` 透出上下文窗口、最大输出、**思考档位**与**消耗倍率**）。
 *
 * 查表前先小写化；**查不到返回 `undefined`（不编造）**。
 *
 * ⚠ 思考档位此前**完全不透出**：`modelSpec()` 只返回窗口/输出，池层的四层回落
 * 拿不到 `effort`，于是 `/v1/models` 的 `effort` 恒 `null`、Web「思考模式」列
 * 全显示「不支持」（2026-10-26 修）。档位表本身是**内置目录实测**的（B 级），
 * 在渠道内部一直生效（`upstream.buildChatBody` 用它校验 `reasoning_effort`），
 * 只是没对外说。
 *
 * ⚠ 倍率只填**云端实测**的那 2 个（`xopglm52` / `xopdeepseekv4pro` = x2.0），
 * 其余 5 个云端没有对应行 → 省略（`undefined`），池层显示「免费」而不是编造的 `1`。
 */
export function modelSpec(
  modelId: string,
):
  | {
      contextWindow?: number;
      maxOutputTokens?: number;
      effort?: { supportedLevels: string[]; defaultLevel: string };
      multiplier?: number;
    }
  | undefined {
  const spec = BY_ID.get(modelId.toLowerCase()) ?? BY_UPSTREAM.get(modelId.toLowerCase());
  if (!spec) return undefined;
  return {
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    effort: { supportedLevels: [...spec.efforts], defaultLevel: spec.defaultEffort },
    // 未知就整个字段省略 —— 池层据此回落到 `null`（UI 显示「免费」），不猜
    ...(spec.multiplier !== undefined ? { multiplier: spec.multiplier } : {}),
  };
}

/**
 * 该模型支持的思考档位（供 `upstream.buildChatBody` 校验 `reasoning_effort`）。
 *
 * 查不到返回空数组 → 调用方会静默删掉 `reasoning_effort`（退回服务端默认档）。
 */
export function modelEffortLevels(upstreamModel: string): string[] {
  const spec = BY_UPSTREAM.get(upstreamModel) ?? BY_ID.get(upstreamModel.toLowerCase());
  return spec ? [...spec.efforts] : [];
}

/** 该模型的默认思考档位（供池层透出）。 */
export function modelDefaultEffort(upstreamModel: string): string {
  const spec = BY_UPSTREAM.get(upstreamModel) ?? BY_ID.get(upstreamModel.toLowerCase());
  return spec ? spec.defaultEffort : "high";
}

/**
 * 消耗倍率（供池层 `model_info.multiplier` 使用）。
 *
 * 查不到返回 `undefined`（池层显示 `-`，不猜）。
 *
 * ⚠ 2026-10-26 之前本函数**全仓无调用方**，倍率只能靠「目录缓存条目」透出，
 * 而 astudio 从不写目录缓存 → 对外恒 `null`。现在 `modelSpec()` 会带上它，
 * 本函数保留给需要单独取倍率的调用方。
 */
export function modelMultiplier(upstreamModel: string): number | undefined {
  const spec = BY_UPSTREAM.get(upstreamModel) ?? BY_ID.get(upstreamModel.toLowerCase());
  return spec?.multiplier;
}
