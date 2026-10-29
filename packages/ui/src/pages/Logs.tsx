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
import { ChevronDown, ChevronLeft, ChevronRight, MessagesSquare, RotateCw } from "lucide-react";
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
  formatTokens,
  formatTokensPerSec,
  OUTCOME_META,
  tokensPairText,
} from "../lib/log-format";
import type { AccessLogEntry, AccessLogPage, AccessOutcome } from "../lib/types";
import { useNarrow } from "../lib/use-narrow";
import { CopyButton } from "../components/CopyChip";
import { LogContextDialog } from "../components/LogContextDialog";
import { PageHeader } from "../components/PageHeader";
import { ScrollFade } from "../components/ScrollFade";
import { Skeleton } from "./Dashboard";

/** 每页条数默认值（可切换 10 / 20 / 50）。 */
const PAGE_SIZE = 20;

/** 输入防抖：不防的话每敲一个字符都发一次查询。 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** 统计条：描述**当天读窗口**（不随筛选变化；筛选命中数由「共 N 条」表达）。 */
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
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-free" />
        成功 <span className="tabular text-ink">{formatCount(stats.success)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
        失败 <span className="tabular text-ink">{formatCount(stats.failure)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
        中断 <span className="tabular text-ink">{formatCount(stats.other)}</span>
      </span>
      <span>
        慢（≥{Math.round(page.slowMs / 1000)}s）{" "}
        <span className="tabular text-ink">{formatCount(stats.slow)}</span>
      </span>
      <span>
        平均耗时{" "}
        <span className="tabular text-ink">{formatDuration(stats.avgDurationMs ?? undefined)}</span>
      </span>
      <span>
        tokens <span className="tabular text-ink">{formatTokens(stats.tokens.total)}</span>
        <span className="text-ink-faint">
          （入 {formatTokens(stats.tokens.prompt)} · 出 {formatTokens(stats.tokens.completion)}）
        </span>
      </span>
      <span>
        缓存命中{" "}
        <span className="tabular text-ink">{formatPercent(stats.cache.hitRate)}</span>
        {stats.cache.total > 0 && (
          <span className="text-ink-faint">
            （{formatTokens(stats.cache.hit)} / {formatTokens(stats.cache.total)}）
          </span>
        )}
      </span>
      {stats.noUsage > 0 && (
        <span className="text-ink-faint">{formatCount(stats.noUsage)} 条无 usage</span>
      )}
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

/** 展开行：请求全字段（正文不在这里，见最右侧「上下文」按钮）。 */
function LogDetail({ entry }: { entry: AccessLogEntry }): ReactElement {
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
          {entry.tokens?.cache ? (
            <span className="tabular">
              命中 {countOrDash(entry.tokens.cache.hit)} · 未命中{" "}
              {countOrDash(entry.tokens.cache.miss)} ·{" "}
              {formatCacheRate(entry.tokens.cache)}
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
 * 模型列**不给宽度**（吃掉剩余空间）—— 否则整表会比面板窄，右侧露出空白。
 * 数值列（耗时 / tokens）右对齐，位数不同也能对齐：见 `ModelExplorer` 的同一约定。
 */
const COL_WIDTHS = {
  toggle: "44px",
  time: "168px",
  result: "124px",
  model: "",
  duration: "84px",
  tokensPerSec: "88px",
  cache: "76px",
  tokens: "172px",
  context: "88px",
} as const;

/**
 * 窄屏（`< md`）的列宽：时间列换成 `HH:MM:SS`（`formatClock`）后只需 88px。
 *
 * 窄屏只留「时间 / 结果 / 模型」三列，固定列合计 88 + 104 = 192px，
 * 故 300px 最小宽下模型列仍有 ~100px（模型表同理，见 `ModelExplorer` 的 `TABLE_MIN_W`）。
 */
const NARROW_COL_WIDTHS: Record<keyof typeof COL_WIDTHS, string> = {
  toggle: "44px",
  time: "88px",
  result: "104px",
  model: "",
  duration: "84px",
  tokensPerSec: "88px",
  cache: "76px",
  tokens: "172px",
  context: "88px",
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
    case "model":
      return (
        <td className="break-all px-3 py-2 align-top text-xs text-ink-soft">
          {entry.model ?? <span className="font-mono text-ink-faint">{entry.path ?? "-"}</span>}
        </td>
      );
    case "duration":
      return <td className={numClass}>{formatDuration(entry.durationMs)}</td>;
    case "tokensPerSec":
      return <td className={numClass}>{formatTokensPerSec(entry)}</td>;
    case "cache":
      return <td className={numClass}>{formatCacheRate(entry.tokens?.cache)}</td>;
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
  pageSize,
  onPageSizeChange,
  expanded,
  onToggle,
  onPageChange,
  onOpenContext,
  loading,
}: {
  page: AccessLogPage;
  pageNum: number;
  totalPages: number;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
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
        <table className="w-full table-fixed border-collapse text-sm min-w-[300px] md:min-w-[900px]">
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
                        <LogDetail entry={entry} />
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
        total={page.total}
        pageSize={pageSize}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        loading={loading}
      />
    </div>
  );
}

/** 分页条：**黏在视口右下**（sticky），翻页不用滚回表格底端。
 *
 * 左侧：总条数 + 每页条数；右侧：上一页 / 页码 / 下一页。背景淡化盖住滚过的行。
 */
function Pager({
  pageNum,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  loading,
}: {
  pageNum: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  loading: boolean;
}): ReactElement {
  const navCls = (disabled: boolean): string =>
    `tap-square grid h-7 w-7 place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40`;
  return (
    <div className="shrink-0 border-t border-line/70 bg-canvas/95 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-xs text-ink-faint">共 {formatCount(total)} 条</span>
        <label className="flex items-center gap-1.5 text-xs text-ink-faint">
          每页
          <select
            value={pageSize}
            disabled={loading}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="tap rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-ink-soft"
          >
            {[10, 20, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          条
        </label>
        <div className="ml-auto flex items-center gap-2">
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
    </div>
  );
}

/** 过滤器：结果分段 + 渠道/日期下拉 + 关键词 + 两个开关。 */
function Filters({
  page,
  date,
  onDate,
  outcome,
  onOutcome,
  cid,
  onCid,
  search,
  onSearch,
  slowOnly,
  onSlowOnly,
  streamOnly,
  onStreamOnly,
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
  search: string;
  onSearch: (value: string) => void;
  slowOnly: boolean;
  onSlowOnly: (value: boolean) => void;
  streamOnly: boolean;
  onStreamOnly: (value: boolean) => void;
  dirty: boolean;
  onReset: () => void;
}): ReactElement {
  const stats = page?.stats;
  const segments: Array<{ key: "" | AccessOutcome; label: string; count: number | undefined }> = [
    { key: "", label: "全部", count: stats?.requests },
    { key: "success", label: "成功", count: stats?.success },
    { key: "failure", label: "失败", count: stats?.failure },
    { key: "other", label: "中断", count: stats?.other },
  ];
  const selectClass =
    "tap rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong";
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
              outcome === segment.key
                ? "bg-overlay text-ink"
                : "text-ink-soft hover:bg-overlay/50 hover:text-ink"
            }`}
          >
            {segment.label}
            {segment.count !== undefined && (
              <span className="ml-1 tabular text-ink-faint">{segment.count}</span>
            )}
          </button>
        ))}
      </span>

      <select className={selectClass} value={cid} onChange={(e) => onCid(e.target.value)}>
        <option value="">全部渠道</option>
        {(page?.cids ?? []).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      <select className={selectClass} value={date} onChange={(e) => onDate(e.target.value)}>
        <option value="">{page?.date ? `最新（${page.date}）` : "最新"}</option>
        {(page?.dates ?? []).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      <input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="搜索模型名 / request id / 错误"
        aria-label="搜索模型名、request id 或错误信息"
        className="tap w-56 rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
      />

      <button
        type="button"
        aria-pressed={slowOnly}
        onClick={() => onSlowOnly(!slowOnly)}
        className={toggleClass(slowOnly)}
      >
        只看慢
      </button>
      <button
        type="button"
        aria-pressed={streamOnly}
        onClick={() => onStreamOnly(!streamOnly)}
        className={toggleClass(streamOnly)}
      >
        只看流式
      </button>

      <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
        <span>
          共 <span className="tabular text-ink-soft">{page?.total ?? 0}</span> 条
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
  const [rawSearch, setRawSearch] = useState("");
  const search = useDebounced(rawSearch, 300);
  const [slowOnly, setSlowOnly] = useState(false);
  const [streamOnly, setStreamOnly] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [pageNum, setPageNum] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 打开上下文弹窗的那一条；null = 关闭。 */
  const [contextTarget, setContextTarget] = useState<AccessLogEntry | null>(null);

  const logs = useQuery({
    queryKey: ["logs", date, outcome, cid, search, slowOnly, streamOnly, pageNum],
    queryFn: () =>
      api.logs({
        date: date === "" ? undefined : date,
        outcome: outcome === "" ? undefined : outcome,
        cid: cid === "" ? undefined : cid,
        q: search === "" ? undefined : search,
        slow: slowOnly ? true : undefined,
        stream: streamOnly ? true : undefined,
        limit: pageSize,
        offset: (pageNum - 1) * pageSize,
      }),
    refetchInterval: expanded !== null || contextTarget !== null || pageNum > 1 ? false : 5_000,
  });

  const page = logs.data;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1;
  // 翻页后新数据变少（别的端清了日志、筛选命中变少）会把页码顶空 —— 收回到最后一页。
  useEffect(() => {
    if (pageNum > totalPages) setPageNum(totalPages);
  }, [pageNum, totalPages]);
  const dirty =
    date !== "" || outcome !== "" || cid !== "" || search !== "" || slowOnly || streamOnly;
  /** 筛选变化必须回第 1 页：偏移量是跟着筛选走的。 */
  const resetToFirstPage = (): void => setPageNum(1);
  /** 展开的条目可能已被新筛选挤走：找不到就不渲染详情。 */
  const expandedEntry = page?.entries.find((entry) => entry.id === expanded) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="请求日志"
        description="网关每次模型请求的时间、渠道与模型、耗时、tokens 与结果（只列 /v1/chat/completions）"
        actions={
          <>
            <button
              type="button"
              onClick={() => void logs.refetch()}
              className="tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              <RotateCw className={`h-3.5 w-3.5 ${logs.isFetching ? "animate-spin" : ""}`} />
              刷新
            </button>
          </>
        }
      />

      <div className="panel space-y-3 p-3">
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
          search={rawSearch}
          onSearch={setRawSearch}
          slowOnly={slowOnly}
          onSlowOnly={setSlowOnly}
          streamOnly={streamOnly}
          onStreamOnly={setStreamOnly}
          dirty={dirty}
          onReset={() => {
            setDate("");
            setOutcome("");
            setCid("");
            setRawSearch("");
            setSlowOnly(false);
            setStreamOnly(false);
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
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPageNum(1);
          }}
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
