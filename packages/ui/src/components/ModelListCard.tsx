/**
 * 对外模型清单（行渲染 + 派生）：模型名 + 平均 TPS + 输入模态 + 上下文/输出规格。
 *
 * 仪表盘与账号池共用 —— 清单是「对外提供哪些模型」的唯一口径；
 * **不显示渠道、不挂状态标签**：可用性由网关按账号池现况决定，
 * 历史计数不是此刻状态（一条失败就把模型标红，下一分钟可能就正常）。
 * 外框（panel / rounded-xl）由页面自己包，本组件只给标题下的行。
 */

import { Image as ImageIcon, Type } from "lucide-react";
import type { ReactElement } from "react";

import { formatTokens } from "../lib/log-format";

/** 规格值的可信来源：注册表（产品决策，与 `/v1/models` 同源）与上游目录声明。
 *  `spec`（本地 model-specs.json）与 `default`（代码兜底常量，恒 65536）不算 ——
 *  混进「跨渠道取最大」会把模型能力虚报上去。 */
function isTrustedMetaSource(source: string | undefined): boolean {
  return source === "registry" || source === "upstream";
}

export interface ModelRow {
  model: string;
  modalities: string[];
  contextWindow: number | null;
  maxOutput: number | null;
  tps: number | null;
}

/**
 * 从 state 快照的 models（含 meta）+ usage 的 models（含 avgTps）派生清单行。
 * 输入模态取**并集**（同一模型不同渠道能力不同，并集才答得了「能不能收图」）；
 * 规格跨可信渠道取**最大值**（用户关心「最大能装多少」）；TPS 取各渠道均值。
 */
export function buildModelRows(
  models: ReadonlyArray<{ model: string; meta?: { inputModalities?: string[]; contextWindow?: number; maxOutputTokens?: number; sources?: Record<string, string> } }> | undefined,
  usageModels: ReadonlyArray<{ model: string; avgTps: number | null }> | undefined,
): ModelRow[] {
  const byModel = new Map<string, {
    model: string;
    modalities: Set<string>;
    contextWindow: number | null;
    maxOutput: number | null;
    tpsSum: number;
    tpsCount: number;
  }>();
  for (const row of models ?? []) {
    const cur = byModel.get(row.model) ?? {
      model: row.model,
      modalities: new Set<string>(),
      contextWindow: null,
      maxOutput: null,
      tpsSum: 0,
      tpsCount: 0,
    };
    for (const m of row.meta?.inputModalities ?? []) cur.modalities.add(m);
    const cw = row.meta?.contextWindow;
    if (isTrustedMetaSource(row.meta?.sources?.contextWindow) && typeof cw === "number" && cw > 0) {
      cur.contextWindow = Math.max(cur.contextWindow ?? 0, cw);
    }
    const mo = row.meta?.maxOutputTokens;
    if (isTrustedMetaSource(row.meta?.sources?.maxOutputTokens) && typeof mo === "number" && mo > 0) {
      cur.maxOutput = Math.max(cur.maxOutput ?? 0, mo);
    }
    byModel.set(row.model, cur);
  }
  for (const row of usageModels ?? []) {
    const cur = byModel.get(row.model);
    if (!cur) continue;
    if (row.avgTps !== null) {
      cur.tpsSum += row.avgTps;
      cur.tpsCount += 1;
    }
  }
  return [...byModel.values()].map((row) => ({
    model: row.model,
    modalities: [...row.modalities],
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    tps: row.tpsCount > 0 ? row.tpsSum / row.tpsCount : null,
  }));
}

/** 清单行：第一行「模型名 + TPS + 输入模态」，第二行「上下文 / 最大输出」。 */
export function ModelRows({ rows }: { rows: ModelRow[] }): ReactElement {
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-3 text-center text-xs text-ink-faint">
        还没有可对外提供的模型（先在账号池完成渠道授权）
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.model}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{row.model}</span>
            <span className="shrink-0 font-mono text-xs tabular text-ink-soft">
              {row.tps === null ? "-" : `${Math.round(row.tps)} t/s`}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-ink-soft">
              <Type className="h-3.5 w-3.5" aria-label="文本" />
              {row.modalities.includes("image") && (
                <>
                  <span className="text-ink-faint">+</span>
                  <ImageIcon className="h-3.5 w-3.5" aria-label="图片" />
                </>
              )}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-ink-faint">
            <span>
              上下文{" "}
              <span className="tabular text-ink-soft">
                {row.contextWindow === null ? "未声明" : formatTokens(row.contextWindow)}
              </span>
            </span>
            <span>
              最大输出{" "}
              <span className="tabular text-ink-soft">
                {row.maxOutput === null ? "未声明" : formatTokens(row.maxOutput)}
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
