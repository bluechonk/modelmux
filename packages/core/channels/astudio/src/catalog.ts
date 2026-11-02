/**
 * AStudio 模型目录：**数据在 `models.json`，本模块只做取 / 归一化 / id 映射**。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md §6）：
 *   - 上游应用**内置目录、不发网络请求** → 本模块**不实现 `refresh()`**（契约要求）；
 *   - 模型表由共享层读 `<root>/channels/astudio/models.json`（首启用随包 `models.json` 浇种），
 *     代码里不留模型数据、不拼存储路径；
 *   - **id 有两套**：池内短名与网关 `model` 字段；本模块暴露短名、内部映射到上游 id。
 *
 * 查不到一律返回「未知」（`undefined` / 空数组），**绝不编造**。
 */

import { ensureChannelModels } from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

/** 表条目形态（落在 `models.json`；倍率未知时该字段省略）。 */
export interface ModelSpec {
  /** 池内暴露的模型 id（短名，对齐应用内置目录的展示名）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 模型网关接受的 model id（`/bot/models/configs` 的 `model` 字段）。 */
  upstreamId: string;
  /**
   * 消耗倍率（云端 `point_multiplier` 实测值）；**缺省 = 未知**。
   *
   * 给云端没给值的模型填 `1` 是**无源填 1**（客户端会按它算钱）—— 必须省略，
   * 池层据此显示「免费」（订阅制口径）而不是编造的 `1`。
   */
  multiplier?: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** 该模型支持的思考档位（实测自内置目录）。 */
  efforts: string[];
  defaultEffort: string;
}

/** 惰性索引：首次被问时才读盘（模块加载期可能不在渠道上下文里，那时解析不出落点）。 */
let index: { rows: ModelSpec[]; byId: Map<string, ModelSpec>; byUpstream: Map<string, ModelSpec> } | null = null;

function indexOf(): NonNullable<typeof index> {
  if (!index) {
    // 两个种子候选：bundle 布局（dist/models/<cid>.json）与非 bundle 的包根 models.json
    const rows =
      ensureChannelModels<ModelSpec>(undefined, [
        bundledSnapshotPath(),
        packageSnapshotPath(import.meta.url),
      ]) ?? [];
    index = {
      rows,
      byId: new Map(rows.map((r) => [r.id, r])),
      byUpstream: new Map(rows.map((r) => [r.upstreamId, r])),
    };
  }
  return index;
}

/** 对外暴露的模型 id（恒小写，按表内顺序）。 */
export function exposedIds(): string[] {
  return indexOf().rows.map((m) => m.id);
}

/**
 * 池内 id → 上游 model id。
 *
 * 接受短名与上游 id 两种写法；认不出来时**原样返回**（与 loomy 同语义）。
 */
export function resolveModel(name: string): string {
  const { byId, byUpstream } = indexOf();
  const hit = byId.get(name) ?? byUpstream.get(name);
  return hit ? hit.upstreamId : name;
}

/**
 * 模型规格（供池层透出上下文窗口、最大输出、思考档位与消耗倍率）。
 *
 * 查表前先小写化；**查不到返回 `undefined`（不编造）**。
 *
 * 思考档位**必须透出**：池层的四层回落依赖它，缺了 `/v1/models` 的 `effort` 恒 `null`、
 * Web「思考模式」列全显示「不支持」。
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
  const { byId, byUpstream } = indexOf();
  const spec = byId.get(modelId.toLowerCase()) ?? byUpstream.get(modelId.toLowerCase());
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
 * 查不到返回空数组 → 调用方静默删掉 `reasoning_effort`（退回服务端默认档）。
 */
export function modelEffortLevels(upstreamModel: string): string[] {
  const { byId, byUpstream } = indexOf();
  const spec = byUpstream.get(upstreamModel) ?? byId.get(upstreamModel.toLowerCase());
  return spec ? [...spec.efforts] : [];
}

/** 消耗倍率（供池层 `model_info.multiplier`）；查不到返回 `undefined`（显示 `-`，不猜）。 */
export function modelMultiplier(upstreamModel: string): number | undefined {
  const { byId, byUpstream } = indexOf();
  const spec = byUpstream.get(upstreamModel) ?? byId.get(upstreamModel.toLowerCase());
  return spec?.multiplier;
}
