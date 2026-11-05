/**
 * 模型区：**「模型 × 渠道」表** —— 对外模型只有 deepseek 系列几个名字，同一个名字
 * 可能由多个渠道供给，所以一行是**一个（模型，渠道）组合**。
 *
 * 为什么按组合拆行：渠道由网关按额度自动挑，但不同渠道的同名模型速度可能差很多
 * （同一模型在不同渠道倍率/规格也可能不同）；拆开才看得出「哪家的 deepseek 偏慢」。
 *
 * 健康度口径（窗口 / 慢阈值 / 判定）在 `lib/model-health.ts`（纯逻辑，表驱动测试钉死）。
 */

import { ChevronDown, Image as ImageIcon, RotateCw, Search, Type, X, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { api } from "../lib/api";
import type { ModelInfo } from "../lib/types";
import { useNarrow } from "../lib/use-narrow";
import { CopyButton } from "./CopyChip";
import { useToast } from "./Toast";

export {
  classifyModel,
  HEALTH_RANGE,
  SLOW_TPS,
  type ModelHealth,
  type ModelVerdict,
} from "../lib/model-health";
import { classifyModel, type ModelHealth, type ModelVerdict } from "../lib/model-health";

/** 一行：一个（模型，渠道）组合。 */
export interface ModelChannelRow {
  model: string;
  cid: string;
  meta: ModelInfo | undefined;
}

/** 倍率格式化：最多 4 位小数并去掉尾随 0。 */
export function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * 状态标签的文案与配色。
 *
 * 「无调用记录」不挂标签（没数据 ≠ 不可用）：红黄只留给
 * 「调用过但结果不好」的模型，页面才不至于一片告警色。
 */
const VERDICT_PILL: Record<NonNullable<ModelVerdict["status"]>, { text: string; cls: string }> = {
  queued: { text: "排队", cls: "bg-warn/15 text-warn" },
  slow: { text: "慢", cls: "bg-warn/15 text-warn" },
  error: { text: "异常", cls: "bg-danger/12 text-danger" },
};

/** 窗口/上限的紧凑写法：128000 → 128k，1000000 → 1M，981504 → 0.98M。 */
function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** 排序位：倍率 0 或订阅制免费档排最前；倍率未知排最后（不冒充免费）。 */
function rankOf(multiplier: number | null, freePlan: boolean): number {
  if (multiplier === 0) return 0;
  if (multiplier == null) return freePlan ? 0 : Number.MAX_SAFE_INTEGER;
  return multiplier;
}

/** 是否免费：倍率 0，或订阅制渠道（无倍率概念）。 */
function isFree(row: ModelChannelRow, freePlanCids: ReadonlySet<string>): boolean {
  const m = row.meta?.multiplier;
  return m === 0 || (m == null && freePlanCids.has(row.cid));
}

/** 思考档位的中文名（未知名原样显示）。 */
const THINKING_LEVEL_LABELS: Record<string, string> = {
  none: "关闭",
  off: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

/**
 * 档位展示顺序：上游下发的顺序是随机的（实测 qoder 给的是 `xhigh/high/low/max/medium`），
 * 按强度重排一遍才读得懂。表里没有的档名排在末尾，保持原相对顺序。
 */
const THINKING_LEVEL_ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

function sortThinkingLevels(levels: readonly string[]): string[] {
  const rank = (level: string): number => {
    const i = THINKING_LEVEL_ORDER.indexOf(level.toLowerCase());
    return i < 0 ? THINKING_LEVEL_ORDER.length : i;
  };
  return [...levels].sort((a, b) => rank(a) - rank(b));
}

/** 一次 ping 的结果（`PingResult` 的界面侧裁剪）。 */
export interface PingOutcome {
  ok: boolean;
  ms: number;
  error: string;
}

/**
 * 列定义（列宽 + 对齐 + 窄屏是否保留）。
 *
 * 表头与表体**共用这一份**，改列只改这里；`< md` 丢弃 `wide` 列时是**少渲染
 * `<td>`**，不是 `hidden md:table-cell`（`display:none` 的 `<td>` 在
 * `table-layout: fixed` 下仍占列槽位、表头表体还会错位）。
 */
interface ColDef {
  key: "model" | "channel" | "multiplier" | "avgTps" | "contextWindow" | "maxOutput" | "effort" | "modality" | "ping" | "copy";
  label: string;
  align: "left" | "right";
  width?: string;
}

const COLS: ColDef[] = [
  { key: "model", label: "模型", align: "left" },
  { key: "channel", label: "渠道", align: "left", width: "8rem" },
  { key: "multiplier", label: "倍率", align: "right", width: "5rem" },
  { key: "avgTps", label: "平均 TPS", align: "right", width: "6rem" },
  { key: "contextWindow", label: "最大上下文", align: "right", width: "7rem" },
  { key: "maxOutput", label: "输出上限", align: "right", width: "6.5rem" },
  { key: "effort", label: "思考模式", align: "left" },
  { key: "modality", label: "输入", align: "left", width: "5rem" },
  { key: "ping", label: "", align: "right", width: "4.5rem" },
  { key: "copy", label: "", align: "right", width: "3rem" },
];

/** `< md` 丢弃的列（手机上只留模型 / 渠道 / 倍率 / ping）。 */
const WIDE_ONLY = new Set<ColDef["key"]>(["avgTps", "contextWindow", "maxOutput", "effort", "modality", "copy"]);

function colsFor(narrow: boolean): ColDef[] {
  return narrow ? COLS.filter((c) => !WIDE_ONLY.has(c.key)) : COLS;
}

function Head({ cols }: { cols: readonly ColDef[] }): ReactElement {
  return (
    <thead>
      <tr className="border-b border-line text-left text-xs text-ink-faint">
        {cols.map((c) => (
          <th
            key={c.key}
            className={`whitespace-nowrap px-3 py-2 font-normal ${c.align === "right" ? "text-right" : ""}`}
          >
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function MultiplierCell({ row, freePlanCids }: { row: ModelChannelRow; freePlanCids: ReadonlySet<string> }): ReactElement {
  const m = row.meta?.multiplier ?? null;
  if (m === 0 || (m == null && freePlanCids.has(row.cid))) {
    return (
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <span className="font-mono text-xs text-free">免费</span>
      </td>
    );
  }
  if (m == null) {
    return <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-faint">—</td>;
  }
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft">×{formatMultiplier(m)}</td>
  );
}

function ModalityCell({ row }: { row: ModelChannelRow }): ReactElement {
  const vision = (row.meta?.inputModalities ?? []).includes("image");
  return (
    <td className="whitespace-nowrap px-3 py-2">
      <span className="inline-flex items-center gap-1 text-ink-soft">
        <Type className="h-3.5 w-3.5" aria-label="文本" />
        {vision && (
          <>
            <span className="text-ink-faint">+</span>
            <ImageIcon className="h-3.5 w-3.5" aria-label="图片" />
          </>
        )}
      </span>
    </td>
  );
}

/**
 * 思考模式单元格：**渠道声明了档位才列出档位**，没声明就明确写「不支持」。
 *
 * 不能给「不支持」的模型编档位：共享层若给所有模型都填 `["low","high"]`，
 * 没声明过的模型都会被显示成「支持 low/high」。
 */
function ThinkingCell({ row }: { row: ModelChannelRow }): ReactElement {
  const effort = row.meta?.effort ?? null;
  if (effort === null || effort.supportedLevels.length === 0) {
    return <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-faint">不支持</td>;
  }
  return (
    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-soft">
      {sortThinkingLevels(effort.supportedLevels)
        .map((level) => THINKING_LEVEL_LABELS[level.toLowerCase()] ?? level)
        .join(" / ")}
    </td>
  );
}

function TpsCell({ verdict }: { verdict: ModelVerdict }): ReactElement {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular text-ink-soft">
      {verdict.tps === null ? "-" : verdict.tps.toFixed(verdict.tps >= 100 ? 0 : 1)}
    </td>
  );
}

/** 模型 × 渠道表：搜索 / 渠道筛选 / 只看免费 / ping。 */
export function ModelExplorer({
  rows,
  healthOf,
  freePlanCids,
  onRefresh,
  refreshing = false,
}: {
  /** 「模型 × 渠道」矩阵行（模型 id 是 deepseek 裸名）。 */
  rows: ModelChannelRow[];
  /** 取某（渠道，模型）近 7 天的健康度；没有行 = 这段窗口里没成功过。 */
  healthOf: (cid: string, model: string) => ModelHealth | undefined;
  /** 无倍率概念（订阅制）的渠道：其模型按「免费」计。 */
  freePlanCids: ReadonlySet<string>;
  /** 重新拉取模型与健康度（可选）。 */
  onRefresh?: () => void;
  refreshing?: boolean;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [cidFilter, setCidFilter] = useState("all");
  const [freeOnly, setFreeOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [pinging, setPinging] = useState<string | null>(null);
  const [pingResults, setPingResults] = useState<ReadonlyMap<string, PingOutcome>>(new Map());
  const toast = useToast();
  const narrow = useNarrow();
  const cols = colsFor(narrow);

  /** ping 一个模型：真发一次最小 chat 请求，结果就地留秒数（按模型去重，渠道由网关挑）。 */
  const ping = async (model: string): Promise<void> => {
    setPinging(model);
    try {
      const result = await api.ping(model);
      setPingResults((prev) => new Map(prev).set(model, { ok: result.ok, ms: result.ms, error: result.error }));
      const seconds = (result.ms / 1000).toFixed(1);
      if (result.ok) toast.success(`ping 成功 · ${model} · ${seconds}s`);
      else toast.error(`ping 失败 · ${model} · ${seconds}s · ${result.error || `HTTP ${result.status}`}`);
    } catch (err) {
      setPingResults((prev) => new Map(prev).set(model, { ok: false, ms: 0, error: String(err) }));
      toast.error(`ping 失败 · ${model} · ${String(err)}`);
    } finally {
      setPinging(null);
    }
  };

  const keyword = query.trim().toLowerCase();
  const channelIds = useMemo(() => [...new Set(rows.map((r) => r.cid))].sort(), [rows]);

  /** 按模型分组（行序即模型序），组内按倍率再按 cid 排。 */
  const groups = useMemo(() => {
    const visible = rows.filter((row) => {
      if (cidFilter !== "all" && row.cid !== cidFilter) return false;
      if (freeOnly && !isFree(row, freePlanCids)) return false;
      if (keyword && !(row.model.toLowerCase().includes(keyword) || row.cid.includes(keyword))) return false;
      return true;
    });
    const map = new Map<string, ModelChannelRow[]>();
    for (const row of visible) {
      const list = map.get(row.model) ?? [];
      list.push(row);
      map.set(row.model, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ra = rankOf(a.meta?.multiplier ?? null, freePlanCids.has(a.cid));
        const rb = rankOf(b.meta?.multiplier ?? null, freePlanCids.has(b.cid));
        return ra - rb || a.cid.localeCompare(b.cid);
      });
    }
    return map;
  }, [rows, cidFilter, freeOnly, keyword, freePlanCids]);

  const toggle = (model: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const cellsOf = (row: ModelChannelRow, modelOfGroup: boolean): ReactElement[] =>
    cols.map((col) => {
      switch (col.key) {
        case "model":
          return (
            <td key={col.key} className="px-3 py-2 align-top">
              {modelOfGroup ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-xs text-ink">{row.model}</span>
                  {(() => {
                    const pill = verdictPill(classifyModel(healthOf(row.cid, row.model)));
                    return pill ? <span className={`pill shrink-0 whitespace-nowrap ${pill.cls}`}>{pill.text}</span> : null;
                  })()}
                </span>
              ) : (
                <span className="text-xs text-ink-faint">↳</span>
              )}
            </td>
          );
        case "channel":
          return (
            <td key={col.key} className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs text-ink-soft">
              {row.cid}
            </td>
          );
        case "multiplier":
          return <MultiplierCell key={col.key} row={row} freePlanCids={freePlanCids} />;
        case "avgTps":
          return <TpsCell key={col.key} verdict={classifyModel(healthOf(row.cid, row.model))} />;
        case "contextWindow":
          return (
            <td key={col.key} className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft">
              {compactNumber(row.meta?.contextWindow ?? 0)}
            </td>
          );
        case "maxOutput":
          return (
            <td key={col.key} className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft">
              {compactNumber(row.meta?.maxOutputTokens ?? 0)}
            </td>
          );
        case "effort":
          return <ThinkingCell key={col.key} row={row} />;
        case "modality":
          return <ModalityCell key={col.key} row={row} />;
        case "ping":
          return (
            <td key={col.key} className="px-3 py-2 text-right align-top">
              <span className="inline-flex items-center gap-1.5">
                {(() => {
                  const result = pingResults.get(row.model);
                  if (!result) return null;
                  return (
                    <span className={`font-mono text-xs tabular ${result.ok ? "text-free" : "text-danger"}`}>
                      {result.ok ? `${(result.ms / 1000).toFixed(1)}s` : "失败"}
                    </span>
                  );
                })()}
                {modelOfGroup && (
                  <button
                    type="button"
                    disabled={pinging !== null}
                    onClick={() => void ping(row.model)}
                    aria-label={`ping ${row.model}`}
                    className="tap-square shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-brand disabled:opacity-40"
                  >
                    <Zap className={`h-3.5 w-3.5 ${pinging === row.model ? "animate-pulse text-brand" : ""}`} />
                  </button>
                )}
              </span>
            </td>
          );
        default:
          return (
            <td key={col.key} className="px-3 py-2 text-right align-top">
              <CopyButton value={row.model} label={`复制 ${row.model}`} />
            </td>
          );
      }
    });

  const total = rows.length;
  const shown = [...groups.values()].reduce((n, list) => n + list.length, 0);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型或渠道…"
            className="tap w-52 rounded-lg border border-line bg-raised py-1.5 pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="tap-square absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint transition-colors hover:text-ink"
              aria-label="清除搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <select
          value={cidFilter}
          onChange={(e) => setCidFilter(e.target.value)}
          className="tap rounded-lg border border-line bg-raised px-2 py-1.5 text-xs text-ink-soft focus:border-line-strong focus:outline-none"
          aria-label="按渠道筛选"
        >
          <option value="all">全部渠道（{channelIds.length}）</option>
          {channelIds.map((cid) => (
            <option key={cid} value={cid}>
              {cid}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setFreeOnly((v) => !v)}
          className={`tap rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
            freeOnly ? "border-free/40 bg-free/10 text-free" : "border-line bg-raised text-ink-soft hover:border-line-strong hover:text-ink"
          }`}
        >
          只看免费
        </button>

        <span className="font-mono text-xs text-ink-faint">
          {shown === total ? `${total} 行` : `${shown} / ${total}`}
        </span>

        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="tap ml-auto flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <RotateCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            刷新
          </button>
        )}
      </div>

      {total === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">（无模型：先在账号池页完成渠道授权）</div>
      ) : shown === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">没有匹配的模型</div>
      ) : (
        <div className="panel overflow-auto">
          <table className="w-full min-w-[520px] table-fixed border-collapse text-sm">
            <colgroup>
              {cols.map((c) => (
                <col key={c.key} style={c.width ? { width: c.width } : undefined} />
              ))}
            </colgroup>
            <Head cols={cols} />
            {[...groups.entries()].map(([model, list]) => {
              const isCollapsed = collapsed.has(model);
              return (
                <tbody key={model} className="border-b border-line/40 last:border-b-0">
                  <tr className="border-b border-line/40 bg-canvas/40">
                    <td colSpan={cols.length} className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => toggle(model)}
                        className="tap inline-flex items-center gap-1.5 text-xs text-ink-soft transition-colors hover:text-ink"
                        aria-expanded={!isCollapsed}
                      >
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                        <span className="font-mono text-ink">{model}</span>
                        <span className="text-ink-faint">{list.length} 个渠道</span>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed &&
                    list.map((row, i) => (
                      <tr key={`${row.cid}-${row.model}`} className="transition-colors hover:bg-overlay/40">
                        {cellsOf(row, i === 0)}
                      </tr>
                    ))}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </section>
  );
}

/** 取 verdict 的标签（无标签返回 null）。 */
function verdictPill(verdict: ModelVerdict): { text: string; cls: string } | null {
  return verdict.status === null ? null : VERDICT_PILL[verdict.status];
}
