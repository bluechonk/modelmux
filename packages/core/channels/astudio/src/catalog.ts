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
  /** 消耗倍率（云端 `point_multiplier` 实测值；无倍率则为 1）。 */
  multiplier: number;
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
 * - `upstreamId` / `multiplier`：云端 `GET /xingchen-studio/bot/models/configs`；
 * - `contextWindow` / `maxOutputTokens`：应用内置 `model-gateway/catalog-<hash>.json`。
 *
 * ⚠ `xopdeepseekv4pro` 与 `xopdeepseekv4pro0813` 网关**都接受**（实测 200），
 *   本表取无日期后缀的那个（与云端配置的 `model` 字段一致）。
 */
const MODELS: ModelSpec[] = [
  {
    id: "auto",
    name: "Auto",
    upstreamId: "astronclaw-auto",
    multiplier: 1,
    contextWindow: 262_144,
    maxOutputTokens: 100_000,
    efforts: ["none", "high"],
    defaultEffort: "high",
  },
  {
    id: "spark-x2.6",
    name: "Spark-X2.6",
    upstreamId: "spark-x2.6",
    multiplier: 1,
    contextWindow: 262_144,
    maxOutputTokens: 100_000,
    efforts: ["none", "high"],
    defaultEffort: "high",
  },
  {
    id: "spark-x2.6-lite",
    name: "Spark-X2.6-Lite",
    upstreamId: "spark-x2.6-4b",
    multiplier: 1,
    contextWindow: 1_048_576,
    maxOutputTokens: 110_000,
    efforts: ["none", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "spark-x2.5",
    name: "Spark-X2.5",
    upstreamId: "spark-x2.5",
    multiplier: 1,
    contextWindow: 262_144,
    maxOutputTokens: 100_000,
    efforts: ["none", "high"],
    defaultEffort: "high",
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    upstreamId: "xopglm52",
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
    multiplier: 1,
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
 * 模型规格（供池层 `/v1/models` 透出上下文窗口与最大输出）。
 *
 * 查表前先小写化；**查不到返回 undefined**（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const spec = BY_ID.get(modelId.toLowerCase()) ?? BY_UPSTREAM.get(modelId.toLowerCase());
  if (!spec) return undefined;
  return {
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
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
 * 查不到返回 `undefined`（池层会显示 `-`，不猜）。
 */
export function modelMultiplier(upstreamModel: string): number | undefined {
  const spec = BY_UPSTREAM.get(upstreamModel) ?? BY_ID.get(upstreamModel.toLowerCase());
  return spec?.multiplier;
}
