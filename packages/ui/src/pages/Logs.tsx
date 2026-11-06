/**
 * 日志页：网关请求级访问日志（时间 / 结果 / 模型 / 耗时 / TPS / 缓存 / tokens）；
 * 字段语义、落点与读窗口见 docs/LOGGING.md §3。
 *
 * 关键约束（docs/LOGGING.md §3）：
 *   - 行内 `ts` 是 UTC、目录按**本地**日期切分 —— 展示一律转本地时区（UTC+8 凌晨两者差一天）
 *   - 数值列（耗时 / tokens）右对齐 + 等宽数位，与模型表数值列同一约定
 *   - 请求正文不进表格：最右侧「上下文」按钮开弹窗（components/LogContextDialog.tsx）
 */

import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, MessagesSquare } from "lucide-react";
import { api } from "../lib/api";
import {
  countOrDash,
  formatBytes,
  formatCacheRate,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRate,
  formatTokens,
  formatTokensPerSec,
  OUTCOME_META,
  tokensPairText,
} from "../lib/log-format";
import type { AccessLogEntry, AccessLogPage, AccessOutcome } from "../lib/types";
import { useNarrow } from "../lib/use-narrow";
import { CopyButton } from "../components/CopyButton";
import { LogContextDialog } from "../components/LogContextDialog";
import { PageHeader } from "../components/PageHeader";
import { RefreshButton } from "../components/RefreshButton";
import { ScrollFade } from "../components/ScrollFade";
import { Select, type SelectOption } from "../components/Select";
import { Skeleton } from "./Dashboard";

/** 每页条数档位（10 / 20 / 50）。 */
const PAGE_SIZE_OPTIONS = [10, 20, 50];
/** 每页条数默认档：日志按时间倒序，先看最近的就够。 */
const PAGE_SIZE_DEFAULT = 10;
/** 每页条数持久化 key：用户选过就记住，后续访问按最后一次选择。 */
const PAGE_SIZE_KEY = "modelmux.logs.pageSize";

/** 读回持久化的每页条数；没有存过或存了非法值（手动改 localStorage / 旧版本）回落默认档。 */
function storedPageSize(): number {
  try {
    const value = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZE_OPTIONS.includes(value) ? value : PAGE_SIZE_DEFAULT;
  } catch {
    return PAGE_SIZE_DEFAULT; // localStorage 不可用（隐私模式等）：回落默认档
  }
}

/** 输入防抖：不防的话每敲一个字符都发一次查询。 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * 统计条：描述**当前筛选范围**（路径 + 渠道 + 日期）的聚合。
 *
 * 范围跟着渠道 / 日期走是刻意的：换了渠道，成功率、慢、平均 TPS 就该是那个渠道的画像，
 * 否则切筛选时这几个数纹丝不动，读者会以为统计没生效。结果（成功 / 失败）的绝对条数
 * 仍在下面筛选栏的分段里（同一份口径），统计条不重复摊一遍；tokens / 缓存命中 /
 * 无 usage 是**全局用量**（不是这份列表的性质），已挪到仪表盘。
 */
function StatBar({ page }: { page: AccessLogPage }): ReactElement {
  const stats = page.stats;
  const rate = stats.requests > 0 ? Math.round((stats.success / stats.requests) * 100) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
      <span>
        请求 <span className="tabular text-ink">{formatCount(stats.requests)}</span>
      </span>
      <span>
        成功率 <span className="tabular text-ink">{rate === null ? "-" : `${rate}%`}</span>
      </span>
      {/* 「慢」只给条数：两个维度的归因（首字延迟 / 生成速率）在展开行逐条给出，
          统计条再摊一遍阈值与分项只会把四个数挤成一团（口径见 docs/LOGGING.md §3.5） */}
      <span>
        慢 <span className="tabular text-ink">{formatCount(stats.slow)}</span>
      </span>
      {/* 平均 TPS 回答「一条请求通常多快」；平均耗时被它取代（长输出会把耗时拉长，读不出快慢）。
          `?? null`：字段缺失（旧构建的载荷）必须显示 `—`，不是 `NaN t/s` */}
      <span>
        平均 TPS <span className="tabular text-ink">{formatRate(stats.avgTps ?? null)}</span>
      </span>
      {page.truncated && (
        <span className="rounded-md bg-warn/15 px-1.5 py-0.5 text-xs text-warn">
          统计只覆盖最近 {formatCount(page.scanned)} 条（读窗口上限）
        </span>
      )}
    </div>
  );
}

/** 一个带标签的字段（详情区用；`dt/dd` 语义便于读屏）。 */
function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 break-words text-ink-soft">
        {children}
      </dd>
    </div>
  );
}

/**
 * 长 id 的可折行渲染（模型名在窄屏列里只有约 108px）。
 *
 * 只允许在 `-` `/` `.` 之后折行（`<wbr>`）：`break-all` 会把 `flash` 劈成 `fl`/`ash`
 * （实测 390 视口），而默认不折行又会溢出单元格。两者之间取中点 —— 折行点落在
 * 分隔符后，语义仍是一个完整词；真遇到没有分隔符的超长段，外层 `break-words` 兜底。
 */
function BreakableId({ value }: { value: string }): ReactElement {
  const parts = value.split(/(?<=[-/.])/);
  return (
    <span className="font-mono">
      {parts.map((part, i) => (
        <Fragment key={`${i}-${part}`}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}

/** 展开行：请求全字段（正文不内联；宽屏走「上下文」列，窄屏走本行内的按钮）。 */
function LogDetail({
  entry,
  thresholds,
  onOpenContext,
  showContext,
}: {  entry: AccessLogEntry;
  /** 「慢」的两个阈值：展开行给出**真实数值**，否则「慢」不可复核（统计条已不再摊这两个数）。 */
  thresholds: { ttfbMs: number; tps: number };
  onOpenContext: () => void;
  /** 窄屏（<768px）没有「上下文」列 —— 固定列合计超过表格最小宽，模型列会被挤成零
   *  宽，所以窄屏砍列保正文可读性优先；此时入口挪到这里，否则手机上打不开正文弹窗。 */
  showContext: boolean;
}): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  return (
    <div className="space-y-3 bg-canvas/40 px-4 py-3">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 xl:grid-cols-3">
        <Field label="request id">
          <span className="break-all font-mono">{entry.id}</span>
          <CopyButton value={entry.id} label="复制 request id" />
        </Field>
        <Field label="端点">
          <span className="font-mono">
            {entry.method ?? "-"} {entry.path ?? "-"}
          </span>
        </Field>
        <Field label="结果">
          <span className={meta.text}>{meta.label}</span>
          <span className="font-mono">{entry.status ?? "-"}</span>
          {entry.slow && <span className="pill bg-warn/15 text-warn">慢</span>}
          {/* 慢的归因：两个维度独立成立，给阈值让「慢」可复核（口径见 docs/LOGGING.md §3.5） */}
          {entry.slowTtfb && (
            <span className="text-ink-faint">
              首字 {formatDuration(entry.ttfbMs)}（≥ {formatDuration(thresholds.ttfbMs)}）
            </span>
          )}
          {entry.slowTps && (
            <span className="text-ink-faint">
              速率 {formatTokensPerSec(entry)}（&lt; {thresholds.tps} t/s）
            </span>
          )}
        </Field>
        <Field label="耗时">
          <span className="tabular">
            总 {formatDuration(entry.durationMs)} · 上游接单 {formatDuration(entry.upstreamMs)} ·
            首字节 {formatDuration(entry.ttfbMs)}
          </span>
        </Field>
        <Field label="请求规模">
          <span className="tabular">
            {formatBytes(entry.requestBytes)} · {countOrDash(entry.messageCount ?? null)} 条消息 ·
            system {countOrDash(entry.systemChars ?? null)} 字符 · {entry.toolCount ?? 0} 个工具
          </span>
        </Field>
        <Field label="流式">
          {entry.stream === undefined ? "-" : entry.stream ? "是" : "否"}
        </Field>
        <Field label="渠道">
          <span className="font-mono">{entry.cid ?? "-"}</span>
        </Field>
        <Field label="模型">
          <span className="break-all font-mono">{entry.model ?? "-"}</span>
        </Field>
        <Field label="tokens">
          {entry.tokens === null ? (
            "上游未返回 usage"
          ) : (
            <span className="tabular">
              入 {countOrDash(entry.tokens.prompt)} · 出 {countOrDash(entry.tokens.completion)} · 共{" "}
              {countOrDash(entry.tokens.total)}
            </span>
          )}
        </Field>
        <Field label="缓存">
          {/* 只列上游返回的计数：没有任何渠道回「命中率」字段，比率一律不自己算 */}
          {entry.tokens?.cache ? (
            <span className="tabular">
              命中 {countOrDash(entry.tokens.cache.hit)} · 未命中{" "}
              {countOrDash(entry.tokens.cache.miss)}
            </span>
          ) : (
            "该上游无缓存字段"
          )}
        </Field>
        {entry.error !== undefined && (
          <Field label="错误码">
            <span className="font-mono">{entry.error}</span>
          </Field>
        )}
      </dl>

      {/* 窄屏专属：表格砍掉了「上下文」列（固定列合计超过表格最小宽，加列会把模型列
          挤成零宽），入口挪到展开行，否则手机上打不开正文弹窗。 */}
      {showContext && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenContext();
          }}
          className="tap inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
        >
          <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
          查看请求上下文
        </button>
      )}

      {entry.message !== undefined && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-ink">说明</div>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-canvas/60 px-3 py-2 text-xs text-ink-soft">
            {entry.message}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 列宽表。
 *
 * 模型列**吃剩余空间**，但整表设了 `md:min-w-[960px]`：其余 9 列固定宽合计 780，
 * 最小宽时模型列仍有 180px —— 列宽合计等于表最小宽时，剩余空间列会被压到 0，
 * `<wbr>` 断点让模型名逐字符竖排（2026-11-05 实测：行高 321px）。
 * 宁可整表横向滚动，也不压垮某一列。
 * 数值列（耗时 / tokens）右对齐，位数不同也能对齐（全站同一约定）。
 */
const COL_WIDTHS = {
  toggle: "36px",
  time: "116px",
  result: "116px",
  channel: "88px",
  model: "",
  duration: "64px",
  tokensPerSec: "72px",
  cache: "48px",
  tokens: "156px",
  context: "84px",
} as const;

/**
 * 窄屏（`< md`）的列宽：时间列换成 `HH:MM:SS`（`formatClock`）后只需 88px。
 *
 * 窄屏只留「时间 / 结果 / 模型」三列，固定列合计 88 + 104 = 192px，
 * 模型列吃剩余（最小宽 300 时约 100px）。
 */
const NARROW_COL_WIDTHS: Record<keyof typeof COL_WIDTHS, string> = {
  toggle: "36px",
  time: "88px",
  result: "104px",
  channel: "88px",
  model: "",
  duration: "64px",
  tokensPerSec: "72px",
  cache: "48px",
  tokens: "156px",
  context: "84px",
};

/**
 * 列定义（列宽 + 对齐 + 窄屏是否保留）。
 *
 * 表头与表体**共用这一份**，改列只改这里；`< md` 丢弃 `wide` 列时是**少渲染
 * `<td>`**，不是 `hidden md:table-cell`（`display:none` 的 `<td>` 在
 * `table-layout: fixed` 下仍占列槽位、表头表体还会错位 —— 见 lib/use-narrow.ts）。
 */
interface LogCol {
  key: keyof typeof COL_WIDTHS;
  label: string;
  align?: "right";
  /** `< md` 丢弃。窄屏只留「时间 / 结果 / 模型」，其余信息在展开行（整行可点）里。 */
  wide?: boolean;
}

const LOG_COLS: LogCol[] = [
  { key: "toggle", label: "", wide: true },
  { key: "time", label: "时间" },
  { key: "result", label: "结果" },
  { key: "channel", label: "渠道", wide: true },
  { key: "model", label: "模型" },
  { key: "duration", label: "耗时", align: "right", wide: true },
  { key: "tokensPerSec", label: "TPS", align: "right", wide: true },
  { key: "cache", label: "缓存", align: "right", wide: true },
  { key: "tokens", label: "tokens（入/出）", align: "right", wide: true },
  { key: "context", label: "上下文", wide: true },
];

/** 结果单元格：与同行其它列一样 `align-top`（否则纵向对齐与其余列不一致）。 */
function ResultCell({ entry }: { entry: AccessLogEntry }): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  return (
    <td className="whitespace-nowrap px-3 py-2 align-top">
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
        <span className={meta.text}>{meta.label}</span>
        <span className="font-mono text-ink-faint">{entry.status ?? "-"}</span>
        {entry.slow && <span className="pill bg-warn/15 text-warn">慢</span>}
      </span>
    </td>
  );
}

/**
 * 按列 key 渲染单元格。
 *
 * 窄屏少渲染列时 `cols` 少了谁这里就少谁 —— 单元格数量与列数量恒等，列宽才可能对齐。
 */
function LogCell({
  col,
  entry,
  open,
  narrow,
  onToggle,
  onOpenContext,
}: {
  col: LogCol;
  entry: AccessLogEntry;
  open: boolean;
  narrow: boolean;
  onToggle: () => void;
  onOpenContext: () => void;
}): ReactElement {
  const numClass =
    "whitespace-nowrap px-3 py-2 text-right align-top font-mono text-xs tabular text-ink-soft";
  switch (col.key) {
    case "toggle":
      return (
        <td className="px-3 py-2 align-top max-md:px-0">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "收起详情" : "展开详情"}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="tap-square grid h-5 w-5 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </td>
      );
    case "time":
      return (
        <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs tabular text-ink-soft">
          {narrow ? formatClock(entry.ts) : formatDateTime(entry.ts)}
        </td>
      );
    case "result":
      return <ResultCell entry={entry} />;
    case "channel":
      return (
        <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs text-ink-soft">
          {entry.cid ?? <span className="text-ink-faint">-</span>}
        </td>
      );
    case "model":
      return (
        <td className="break-words px-3 py-2 align-top text-xs text-ink-soft">
          {entry.model ? (
            <BreakableId value={entry.model} />
          ) : (
            <span className="font-mono text-ink-faint">{entry.path ?? "-"}</span>
          )}
        </td>
      );
    case "duration":
      return <td className={numClass}>{formatDuration(entry.durationMs)}</td>;
    case "tokensPerSec":
      return <td className={numClass}>{formatTokensPerSec(entry)}</td>;
    case "cache":
      return <td className={numClass}>{formatCacheRate()}</td>;
    case "tokens":
      return <td className={numClass}>{tokensPairText(entry.tokens)}</td>;
    case "context":
      return (
        <td className="whitespace-nowrap px-3 py-2 align-top">
          <button
            type="button"
            aria-label="查看请求上下文"
            onClick={(event) => {
              event.stopPropagation();
              onOpenContext();
            }}
            className="tap inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
            上下文
          </button>
        </td>
      );
  }
}

function LogTable({
  page,
  pageNum,
  totalPages,
  expanded,
  onToggle,
  onPageChange,
  onOpenContext,
  loading,
}: {
  page: AccessLogPage;
  pageNum: number;
  totalPages: number;
  expanded: string | null;
  onToggle: (id: string) => void;
  onPageChange: (page: number) => void;
  onOpenContext: (entry: AccessLogEntry) => void;
  loading: boolean;
}): ReactElement {
  const narrow = useNarrow();
  const cols = narrow ? LOG_COLS.filter((col) => !col.wide) : LOG_COLS;
  const widths: Record<keyof typeof COL_WIDTHS, string> = narrow ? NARROW_COL_WIDTHS : COL_WIDTHS;
  const headClass = "px-3 py-2 font-normal";
  return (
    <div className="panel flex min-h-0 flex-1 flex-col">
      <ScrollFade wrapperClassName="flex min-h-0 flex-1 flex-col" className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-sm min-w-[300px] md:min-w-[960px]">
          <colgroup>
            {cols.map((col) => (
              <col key={col.key} style={widths[col.key] ? { width: widths[col.key] } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-faint">
              {cols.map((col) => (
                <th
                  key={col.key}
                  className={col.align === "right" ? `text-right ${headClass}` : headClass}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.entries.map((entry) => {
              const open = expanded === entry.id;
              return (
                <Fragment key={entry.id}>
                  <tr
                    onClick={() => onToggle(entry.id)}
                    className={`cursor-pointer border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40 ${
                      open ? "bg-overlay/30" : ""
                    }`}
                  >
                    {cols.map((col) => (
                      <LogCell
                        key={col.key}
                        col={col}
                        entry={entry}
                        open={open}
                        narrow={narrow}
                        onToggle={() => onToggle(entry.id)}
                        onOpenContext={() => onOpenContext(entry)}
                      />
                    ))}
                  </tr>
                  {open && (
                    <tr className="border-b border-line/40">
                      <td colSpan={cols.length} className="p-0">
                        <LogDetail
                          entry={entry}
                          thresholds={page.slowThresholds}
                          showContext={narrow}
                          onOpenContext={() => onOpenContext(entry)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </ScrollFade>

      <Pager
        pageNum={Math.min(pageNum, totalPages)}
        totalPages={totalPages}
        onPageChange={onPageChange}
        loading={loading}
      />
    </div>
  );
}

/** 分页条：**黏在视口右下**（sticky），翻页不用滚回表格底端。
 *
 * 只放翻页；「每页 N 条」在筛选栏（上方）——分页设置属于筛选条件，
 * 放底部会让用户滚到表尾才发现可以改每页条数。
 */
function Pager({
  pageNum,
  totalPages,
  onPageChange,
  loading,
}: {
  pageNum: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  loading: boolean;
}): ReactElement {
  const navCls = (disabled: boolean): string =>
    `tap-square grid h-7 w-7 place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40`;
  return (
    <div className="shrink-0 border-t border-line/70 bg-canvas/95 px-3 py-2">
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          aria-label="上一页"
          disabled={pageNum <= 1 || loading}
          onClick={() => onPageChange(pageNum - 1)}
          className={navCls(pageNum <= 1 || loading)}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-16 text-center text-xs tabular text-ink-soft">
          {pageNum} / {totalPages}
        </span>
        <button
          type="button"
          aria-label="下一页"
          disabled={pageNum >= totalPages || loading}
          onClick={() => onPageChange(pageNum + 1)}
          className={navCls(pageNum >= totalPages || loading)}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** 本地今天 `YYYY-MM-DD`：日志按本地日期切目录，界面日期选项与它同口径。 */
function localToday(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 过滤器：结果分段 + 渠道/日期下拉 + 只看慢 + 每页条数。 */
function Filters({
  page,
  date,
  onDate,
  outcome,
  onOutcome,
  cid,
  onCid,
  slowOnly,
  onSlowOnly,
  pageSize,
  onPageSizeChange,
  dirty,
  onReset,
}: {
  page: AccessLogPage | undefined;
  date: string;
  onDate: (value: string) => void;
  outcome: "" | AccessOutcome;
  onOutcome: (value: "" | AccessOutcome) => void;
  cid: string;
  onCid: (value: string) => void;
  slowOnly: boolean;
  onSlowOnly: (value: boolean) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  dirty: boolean;
  onReset: () => void;
}): ReactElement {
  const stats = page?.stats;
  const segments: Array<{ key: "" | AccessOutcome; label: string; count: number | undefined }> = [
    { key: "", label: "全部", count: stats?.requests },
    { key: "success", label: OUTCOME_META.success.label, count: stats?.success },
    { key: "failure", label: OUTCOME_META.failure.label, count: stats?.failure },
  ];
  /**
   * 结果分段的语义色：**未选中时也着色**（成功绿 / 失败红），
   * 选中只是加一层淡底 —— 只靠选中态着色时，分段在默认状态下全是灰的，
   * 一眼看不出「哪个是失败」。底色用 12% 透明度，悬停再加深。
   */
  const segmentTone: Record<"" | AccessOutcome, { idle: string; active: string }> = {
    "": { idle: "text-ink-soft hover:bg-overlay/50 hover:text-ink", active: "bg-overlay text-ink" },
    success: { idle: "text-free hover:bg-free/10", active: "bg-free/15 text-free" },
    failure: { idle: "text-danger hover:bg-danger/10", active: "bg-danger/15 text-danger" },
  };
  const today = localToday();
  // 空值 = 后端回落到「最近一个有日志的日期」：今天还没有请求时回落的是昨天，
  // 标签写死「今天」名不副实 —— 跟随实际返回的日期展示
  const dateOptions: SelectOption[] = [
    { value: "", label: page?.date && page.date !== today ? `最新（${page.date}）` : "今天" },
    ...(page?.dates ?? []).filter((value) => value !== today).map((value) => ({ value, label: value })),
  ];
  const cidOptions: SelectOption[] = [
    { value: "", label: "全部渠道" },
    ...(page?.cids ?? []).map((value) => ({ value, label: value })),
  ];
  const toggleClass = (active: boolean): string =>
    `tap rounded-lg border px-2 py-1 text-xs transition-colors ${
      active
        ? "border-line-strong bg-overlay text-ink"
        : "border-line text-ink-soft hover:border-line-strong hover:text-ink"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex overflow-hidden rounded-lg border border-line">
        {segments.map((segment) => (
          <button
            key={segment.key}
            type="button"
            aria-pressed={outcome === segment.key}
            onClick={() => onOutcome(segment.key)}
            className={`tap px-2.5 py-1 text-xs transition-colors ${
              outcome === segment.key ? segmentTone[segment.key].active : segmentTone[segment.key].idle
            }`}
          >
            {segment.label}
            {segment.count !== undefined && (
              <span className={`ml-1 tabular ${outcome === segment.key ? "opacity-70" : "opacity-60"}`}>
                {segment.count}
              </span>
            )}
          </button>
        ))}
      </span>

      <Select label="渠道" value={cid} onChange={onCid} options={cidOptions} />
      <Select label="日期" value={date} onChange={onDate} options={dateOptions} />

      <button
        type="button"
        aria-pressed={slowOnly}
        onClick={() => onSlowOnly(!slowOnly)}
        className={toggleClass(slowOnly)}
      >
        只看慢
      </button>

      <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5">
          每页
          <Select
            label="每页条数"
            value={String(pageSize)}
            onChange={(value) => onPageSizeChange(Number(value))}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          />
          条
        </span>
        {dirty && (
          <button
            type="button"
            onClick={onReset}
            className="tap rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            清除筛选
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * 日志页。
 *
 * 自动刷新 5 秒一次；**展开详情、已翻页或弹窗打开时暂停** —— 否则行会跳动、
 * 用户正在看的记录可能被刷新挤走。
 */
export function Logs(): ReactElement {
  const [date, setDate] = useState("");
  const [outcome, setOutcome] = useState<"" | AccessOutcome>("");
  const [cid, setCid] = useState("");
  const [slowOnly, setSlowOnly] = useState(false);
  const [pageSize, setPageSizeState] = useState(storedPageSize);
  const [pageNum, setPageNum] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 打开上下文弹窗的那一条；null = 关闭。 */
  const [contextTarget, setContextTarget] = useState<AccessLogEntry | null>(null);

  const logs = useQuery({
    // `pageSize` 必须进 key：`limit`/`offset`/`totalPages` 都由它推导，漏掉会出现
    // 「第 1 页切每页 50 → 不重取 → 仍是 20 行，而分页器按 50 算」——
    // 更糟的是下一页 offset 按 50 跳，第 21–50 条永远看不到（实测出现过）。
    queryKey: ["logs", date, outcome, cid, slowOnly, pageNum, pageSize],
    // 再进页面 / 切筛选时先出上一次的数据（列表页最怕被清空成骨架）
    placeholderData: (prev) => prev,
    queryFn: () =>
      api.logs({
        date: date === "" ? undefined : date,
        outcome: outcome === "" ? undefined : outcome,
        cid: cid === "" ? undefined : cid,
        slow: slowOnly ? true : undefined,
        limit: pageSize,
        offset: (pageNum - 1) * pageSize,
      }),
    refetchInterval: expanded !== null || contextTarget !== null || pageNum > 1 ? false : 5_000,
    // 与轮询同长：间隔内再进页面直接用缓存（列表页最怕被清空成骨架）
    staleTime: 5_000,
  });

  const page = logs.data;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1;
  // 翻页后新数据变少（别的端清了日志、筛选命中变少）会把页码顶空 —— 收回到最后一页。
  useEffect(() => {
    if (pageNum > totalPages) setPageNum(totalPages);
  }, [pageNum, totalPages]);
  const dirty = date !== "" || outcome !== "" || cid !== "" || slowOnly;
  /** 筛选变化必须回第 1 页：偏移量是跟着筛选走的。 */
  const resetToFirstPage = (): void => setPageNum(1);
  /** 每页条数变化：持久记忆 + 回第 1 页（偏移量跟着 pageSize 走）。 */
  const setPageSize = (size: number): void => {
    setPageSizeState(size);
    try {
      window.localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      // localStorage 不可用（隐私模式等）：本次会话仍生效，只是不记忆
    }
    setPageNum(1);
  };
  /** 展开的条目可能已被新筛选挤走：找不到就不渲染详情。 */
  const expandedEntry = page?.entries.find((entry) => entry.id === expanded) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="请求日志"
        description="网关每次模型请求的时间、渠道与模型、耗时、tokens 与结果（只列 /v1/chat/completions）"
        actions={
          <>
            <RefreshButton onRefresh={() => logs.refetch()} />
          </>
        }
      />

      {/* 统计条 + 筛选栏整块吸顶：长列表滚动时筛选条件与命中计数始终可见（`.panel` 不透明，内容不会透出） */}
      <div className="panel sticky top-0 z-20 space-y-3 p-3">
        {page ? (
          <StatBar page={page} />
        ) : (
          <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
        )}
        <Filters
          page={page}
          date={date}
          onDate={(value) => {
            setDate(value);
            setExpanded(null);
            resetToFirstPage();
          }}
          outcome={outcome}
          onOutcome={(value) => {
            setOutcome(value);
            setExpanded(null);
            resetToFirstPage();
          }}
          cid={cid}
          onCid={(value) => {
            setCid(value);
            setExpanded(null);
            resetToFirstPage();
          }}
          slowOnly={slowOnly}
          onSlowOnly={setSlowOnly}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPageNum(1);
            setExpanded(null);
          }}
          dirty={dirty}
          onReset={() => {
            setDate("");
            setOutcome("");
            setCid("");
            setSlowOnly(false);
            setPageNum(1);
            setExpanded(null);
          }}
        />
      </div>

      {logs.isPending ? (
        <div className="panel p-5">
          <Skeleton />
        </div>
      ) : logs.isError || !page ? (
        <div className="panel space-y-2 p-5 text-sm text-ink-soft">
          <p className="text-danger">日志读取失败。</p>
          <p className="text-xs text-ink-faint">
            控制台与网关同进程：网关不可用时这里也读不到；恢复后点「刷新」重试。
          </p>
          <button
            type="button"
            onClick={() => void logs.refetch()}
            className="tap rounded-lg border border-line px-3 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            重试
          </button>
        </div>
      ) : page.entries.length === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">
          {dirty
            ? "当前筛选没有命中任何请求；试试「清除筛选」。"
            : page.dates.length === 0
              ? "还没有请求日志。日志落在 ~/.modelmux/logs/access/，发起一次对话后回来看看。"
              : `${page.date} 没有记录请求。`}
        </div>
      ) : (
        <LogTable
          page={page}
          pageNum={pageNum}
          totalPages={totalPages}
          expanded={expandedEntry === null ? null : expandedEntry.id}
          onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
          onPageChange={(next) => {
            setPageNum(next);
            setExpanded(null);
          }}
          onOpenContext={setContextTarget}
          loading={logs.isFetching}
        />
      )}

      {contextTarget !== null && (
        <LogContextDialog
          entry={contextTarget}
          date={date === "" ? (page?.date ?? "") : date}
          onClose={() => setContextTarget(null)}
        />
      )}
    </div>
  );
}
