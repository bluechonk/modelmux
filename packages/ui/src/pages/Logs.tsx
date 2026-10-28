/**
 * 日志页：网关请求级访问日志（时间 / 渠道·模型 / 流 / 耗时 / tokens / 结果）；
 * 字段语义、落点与读窗口见 docs/LOGGING.md §3。
 *
 * 关键约束（docs/LOGGING.md §3）：
 *   - 行内 `ts` 是 UTC、目录按**本地**日期切分 —— 展示一律转本地时区（UTC+8 凌晨两者差一天）
 *   - 数值列（耗时 / tokens）右对齐 + 等宽数位，与模型表数值列同一约定
 *   - 请求正文不进表格：最右侧「上下文」按钮开弹窗（components/LogContextDialog.tsx）
 */

import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MessagesSquare, RotateCw } from "lucide-react";
import { api } from "../lib/api";
import {
  countOrDash,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatTokens,
  OUTCOME_META,
  tokensPairText,
} from "../lib/log-format";
import type { AccessLogEntry, AccessLogPage, AccessOutcome } from "../lib/types";
import { CopyButton } from "../components/CopyChip";
import { LogContextDialog } from "../components/LogContextDialog";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { Skeleton } from "./Dashboard";

/** 一页返回多少条（点「加载更多」按这个步长累加）。 */
const PAGE_SIZE = 100;

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
      {stats.noUsage > 0 && (
        <span className="text-ink-faint">{formatCount(stats.noUsage)} 条无 usage</span>
      )}
      {page.truncated && (
        <span className="rounded-md bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn">
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
  stream: "56px",
  duration: "84px",
  tokens: "172px",
  context: "88px",
} as const;

/** 结果单元格：与同行其它列一样 `align-top`（此前漏写，导致纵向对齐与其余列不一致）。 */
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
  const headClass = "px-3 py-2 font-normal";
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: COL_WIDTHS.toggle }} />
            <col style={{ width: COL_WIDTHS.time }} />
            <col style={{ width: COL_WIDTHS.result }} />
            <col />
            <col style={{ width: COL_WIDTHS.stream }} className="hidden md:table-column" />
            <col style={{ width: COL_WIDTHS.duration }} />
            <col style={{ width: COL_WIDTHS.tokens }} />
            <col style={{ width: COL_WIDTHS.context }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left text-[11px] text-ink-faint">
              <th className={headClass} />
              <th className={headClass}>时间</th>
              <th className={headClass}>结果</th>
              <th className={headClass}>模型</th>
              <th className={`hidden md:table-cell ${headClass}`}>流</th>
              <th className={`text-right ${headClass}`}>耗时</th>
              <th className={`text-right ${headClass}`}>tokens（入/出）</th>
              <th className={headClass}>上下文</th>
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
                    <td className="px-3 py-2 align-top">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? "收起详情" : "展开详情"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggle(entry.id);
                        }}
                        className="grid h-5 w-5 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs tabular text-ink-soft">
                      {formatDateTime(entry.ts)}
                    </td>
                    <ResultCell entry={entry} />
                    <td className="break-all px-3 py-2 align-top text-xs text-ink-soft">
                      {entry.model ?? (
                        <span className="font-mono text-ink-faint">{entry.path ?? "-"}</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 align-top text-xs text-ink-soft md:table-cell">
                      {entry.stream === undefined ? "-" : entry.stream ? "流式" : "单次"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right align-top font-mono text-xs tabular text-ink-soft">
                      {formatDuration(entry.durationMs)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right align-top font-mono text-xs tabular text-ink-soft">
                      {tokensPairText(entry.tokens)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <button
                        type="button"
                        aria-label="查看请求上下文"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenContext(entry);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                      >
                        <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
                        上下文
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-line/40">
                      <td colSpan={8} className="p-0">
                        <LogDetail entry={entry} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pager
        pageNum={Math.min(pageNum, totalPages)}
        totalPages={totalPages}
        total={page.total}        onPageChange={onPageChange}
        loading={loading}
      />
    </div>
  );
}

/** 页码窗口：总页数 ≤7 全部列出，否则「1 … p-1 p p+1 … N」。 */
function pagerWindow(pageNum: number, totalPages: number): Array<number | "…"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const out: Array<number | "…"> = [1];
  const lo = Math.max(2, pageNum - 1);
  const hi = Math.min(totalPages - 1, pageNum + 1);
  if (lo > 2) out.push("…");
  for (let p = lo; p <= hi; p += 1) out.push(p);
  if (hi < totalPages - 1) out.push("…");
  out.push(totalPages);
  return out;
}

/** 分页条：页码窗口 + 上一页/下一页 + 总数。 */
function Pager({
  pageNum,
  totalPages,
  total,
  onPageChange,
  loading,
}: {
  pageNum: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  loading: boolean;
}): ReactElement {
  const btn = (active: boolean): string =>
    `min-w-8 rounded-lg border px-2 py-1 text-xs tabular transition-colors ${
      active
        ? "border-line-strong bg-overlay text-ink"
        : "border-line text-ink-soft hover:border-line-strong hover:text-ink"
    } disabled:opacity-40`;
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 border-t border-line/60 px-3 py-2">
      <button
        type="button"
        disabled={pageNum <= 1 || loading}
        onClick={() => onPageChange(pageNum - 1)}
        className={btn(false)}
      >
        上一页
      </button>
      {pagerWindow(pageNum, totalPages).map((entry, index) =>
        entry === "…" ? (
          <span key={`ellipsis-${index}`} className="px-1 text-xs text-ink-faint">
            …
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            disabled={loading}
            aria-current={entry === pageNum ? "page" : undefined}
            onClick={() => onPageChange(entry)}
            className={btn(entry === pageNum)}
          >
            {entry}
          </button>
        ),
      )}
      <button
        type="button"
        disabled={pageNum >= totalPages || loading}
        onClick={() => onPageChange(pageNum + 1)}
        className={btn(false)}
      >
        下一页
      </button>
      <span className="ml-3 text-[11px] text-ink-faint">
        共 {formatCount(total)} 条 · 第 {pageNum}/{totalPages} 页
      </span>
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
    "rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong";
  const toggleClass = (active: boolean): string =>
    `rounded-lg border px-2 py-1 text-xs transition-colors ${
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
            className={`px-2.5 py-1 text-xs transition-colors ${
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
        className="w-56 rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
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
            className="rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
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
  const [pageNum, setPageNum] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 打开上下文弹窗的那一条；null = 关闭。 */
  const [contextTarget, setContextTarget] = useState<AccessLogEntry | null>(null);

  const qc = useQueryClient();
  const toast = useToast();
  /** 正文抓取开关：写根级偏好（`<root>/prefs.json`），不重启生效。 */
  const capture = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await api.setPayloadCapture(enabled);
      if (res.ok === false) throw new Error("切换失败");
      return res;
    },
    onSuccess: (res) => {
      toast.success(
        res.enabled
          ? "已开启请求正文抓取：之后的新请求会落盘（保留 3 天）"
          : "已关闭请求正文抓取：不再新增记录，已落盘的在保留期内仍可查看",
      );
      void qc.invalidateQueries({ queryKey: ["logs"] });
      void qc.invalidateQueries({ queryKey: ["logPayload"] });
    },
    onError: (err) => toast.error(String(err)),
  });

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
        limit: PAGE_SIZE,
        offset: (pageNum - 1) * PAGE_SIZE,
      }),
    refetchInterval: expanded !== null || contextTarget !== null || pageNum > 1 ? false : 5_000,
  });

  const page = logs.data;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / PAGE_SIZE)) : 1;
  // 翻页后新数据变少（别的端清了日志、筛选命中变少）会把页码顶空 —— 收回到最后一页。
  useEffect(() => {
    if (pageNum > totalPages) setPageNum(totalPages);
  }, [pageNum, totalPages]);
  const captureOn = page?.payload_enabled ?? true;
  const dirty =
    date !== "" || outcome !== "" || cid !== "" || search !== "" || slowOnly || streamOnly;
  /** 筛选变化必须回第 1 页：偏移量是跟着筛选走的。 */
  const resetToFirstPage = (): void => setPageNum(1);
  /** 展开的条目可能已被新筛选挤走：找不到就不渲染详情。 */
  const expandedEntry = page?.entries.find((entry) => entry.id === expanded) ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="日志"
        description="网关每次请求的时间、渠道与模型、耗时、tokens 与结果"
        actions={
          <>
            <button
              type="button"
              aria-pressed={captureOn}
              disabled={capture.isPending}
              onClick={() => capture.mutate(!captureOn)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                captureOn
                  ? "border-line-strong bg-overlay text-ink"
                  : "border-line text-ink-soft hover:border-line-strong hover:text-ink"
              } disabled:opacity-50`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${captureOn ? "bg-free" : "bg-ink-faint"}`}
              />
              正文抓取 · {captureOn ? "开" : "关"}
            </button>
            <button
              type="button"
              onClick={() => void logs.refetch()}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
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
            className="rounded-lg border border-line px-3 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
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
          payloadEnabled={page?.payload_enabled ?? false}
          onClose={() => setContextTarget(null)}
        />
      )}
    </div>
  );
}
