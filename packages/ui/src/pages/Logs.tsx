/**
 * 日志页：网关请求级访问日志（时间 / 渠道·模型 / 流 / 耗时 / tokens / 结果）。
 *
 * 关键约束：
 *  - 数据源是 `~/.modelmux/logs/access/<日期>/{success,failure,other}.log`（见 docs/LOGGING.md §3）
 *  - 行内 `ts` 是 **UTC**，目录按**本地**日期切分 —— 展示一律转本地时区
 *  - 展开行是唯一的信息容器：控制台禁止 hover 气泡，补充信息只能点开看
 */

import { Fragment, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import { api } from "../lib/api";
import type {
  AccessLogEntry,
  AccessLogPage,
  AccessOutcome,
  PayloadRecord,
} from "../lib/types";
import { CopyButton } from "../components/CopyChip";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "./Dashboard";

/** 一页返回多少条（点「加载更多」按这个步长累加）。 */
const PAGE_SIZE = 100;

const OUTCOME_META: Record<AccessOutcome, { label: string; dot: string; text: string }> = {
  success: { label: "成功", dot: "bg-free", text: "text-free" },
  failure: { label: "失败", dot: "bg-danger", text: "text-danger" },
  other: { label: "中断", dot: "bg-warn", text: "text-warn" },
};

const ROLE_LABEL: Record<string, string> = {
  system: "系统",
  developer: "开发者",
  user: "用户",
  assistant: "助手",
  tool: "工具",
};

/** 输入防抖：不防的话每敲一个字符都发一次查询。 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** 请求开始时刻 → **本地**时区 `HH:mm:ss`（行内 ts 是 UTC，直接显示会差一个时区）。 */
function formatTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** 可缺的计数：缺失显示 `-`，有值走千分位（与表格列同一口径）。 */
function countOrDash(value: number | null): string {
  return value === null ? "-" : formatCount(value);
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(2)} MB`;
}

/** 长文本/长 JSON 的短预览：避免把 base64 图片之类整段铺进页面。 */
function brief(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text;
}

function tokensText(entry: AccessLogEntry): string {
  if (!entry.tokens) return "-";
  const { prompt, completion } = entry.tokens;
  if (prompt === null && completion === null) return "-";
  return `${prompt === null ? "-" : formatCount(prompt)} / ${completion === null ? "-" : formatCount(completion)}`;
}

/** 统计条：描述**当天读窗口**（不随筛选变化，筛选命中数单独由「共 N 条」表达）。 */
function StatBar({ page, truncated }: { page: AccessLogPage; truncated: boolean }): ReactElement {
  const stats = page.stats;
  const total = stats.tokens.total;
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
        tokens{" "}
        <span className="tabular text-ink">{formatCount(total)}</span>
        <span className="text-ink-faint">
          （入 {formatCount(stats.tokens.prompt)} · 出 {formatCount(stats.tokens.completion)}）
        </span>
      </span>
      {stats.noUsage > 0 && (
        <span className="text-ink-faint">
          {formatCount(stats.noUsage)} 条无 usage
        </span>
      )}
      {truncated && (
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

/** 非文本片段（图片 / 音频等）：只给类型与长度，不铺 base64。 */
function ContentPart({ part }: { part: unknown }): ReactElement {
  const rec = (part && typeof part === "object" ? part : {}) as Record<string, unknown>;
  if (rec["type"] === "text" && typeof rec["text"] === "string") {
    return (
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-soft">
        {rec["text"]}
      </p>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-ink-faint">
      {brief(part)}
    </pre>
  );
}

function renderContent(content: unknown): ReactElement | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") {
    if (content === "") return null;
    return (
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-soft">
        {content}
      </p>
    );
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-1">
        {content.map((part, i) => (
          <ContentPart key={i} part={part} />
        ))}
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-ink-soft">
      {brief(content)}
    </pre>
  );
}

function ToolCallBlock({ call }: { call: unknown }): ReactElement {
  const rec = (call && typeof call === "object" ? call : {}) as Record<string, unknown>;
  const fn = (rec["function"] && typeof rec["function"] === "object"
    ? rec["function"]
    : {}) as Record<string, unknown>;
  return (
    <div className="rounded-md border border-line/50 bg-canvas/60 px-2 py-1">
      <div className="text-[11px]">
        <span className="font-mono text-ink">{String(fn["name"] ?? "(未命名)")}</span>
        <span className="text-ink-faint"> 工具调用</span>
      </div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-ink-faint">
        {brief(fn["arguments"] ?? {}, 400)}
      </pre>
    </div>
  );
}

/** 一条 message：role 徽标 + 正文（多模态/工具调用各自成块）。 */
function MessageBlock({ message, index }: { message: unknown; index: number }): ReactElement {
  const rec = (message && typeof message === "object" ? message : {}) as Record<string, unknown>;
  const role = typeof rec["role"] === "string" ? rec["role"] : "unknown";
  const toolCalls = Array.isArray(rec["tool_calls"]) ? rec["tool_calls"] : null;
  return (
    <div className="rounded-md border border-line/60 bg-raised/60 px-2.5 py-1.5">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="pill bg-overlay text-ink-soft">{ROLE_LABEL[role] ?? role}</span>
        <span className="text-ink-faint">#{index + 1}</span>
        {typeof rec["tool_call_id"] === "string" && (
          <span className="font-mono text-ink-faint">{rec["tool_call_id"]}</span>
        )}
      </div>
      {renderContent(rec["content"])}
      {toolCalls !== null && (
        <div className="mt-1 space-y-1">
          {toolCalls.map((call, i) => (
            <ToolCallBlock key={i} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 一份抓取记录的正文：能解析成对象就按 messages 逐条渲染，否则原样呈现。
 *
 * 截断过的记录不尝试解析（必然失败），直接给原文 —— 假装解析只会误导。
 */
function PayloadBody({ record }: { record: PayloadRecord }): ReactElement {
  const parsed = useMemo<Record<string, unknown> | null>(() => {
    if (record.truncated) return null;
    try {
      const value: unknown = JSON.parse(record.body);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 不是 JSON（自编码渠道的字符串体）：按原文呈现
    }
    return null;
  }, [record]);

  if (parsed === null) {
    return (
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-soft">
        {record.body}
      </pre>
    );
  }

  const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : null;
  const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "messages"));
  const restKeys = Object.keys(rest);
  return (
    <div className="space-y-2">
      {messages === null ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-soft">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      ) : (
        <div className="space-y-1.5">
          {messages.map((message, i) => (
            <MessageBlock key={i} index={i} message={message} />
          ))}
        </div>
      )}
      {restKeys.length > 0 && (
        <details className="text-[11px] text-ink-faint">
          <summary className="cursor-pointer select-none">
            其余参数（{restKeys.join("、")}）
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-ink-soft">
            {JSON.stringify(rest, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function PayloadRecordBlock({ record }: { record: PayloadRecord }): ReactElement {
  const title = record.phase === "client" ? "客户端原始请求" : `上行 #${(record.attempt ?? 0) + 1}`;
  return (
    <div className="rounded-lg border border-line/70 bg-canvas/50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3 py-1.5 text-[11px] text-ink-soft">
        <span className="font-medium text-ink">{title}</span>
        {record.cid !== undefined && <span className="font-mono">{record.cid}</span>}
        {record.model !== undefined && (
          <span className="font-mono text-ink-faint">{record.model}</span>
        )}
        <span className="tabular">{formatBytes(record.bytes)}</span>
        {record.truncated && <span className="pill bg-warn/15 text-warn">已截断</span>}
        <span className="ml-auto">
          <CopyButton value={record.body} label={`复制${title}的 JSON`} />
        </span>
      </div>
      <div className="px-3 py-2">
        <PayloadBody record={record} />
      </div>
    </div>
  );
}

/** 抓取开关关闭时的说明：给可执行的开启办法，而不是一句「没有数据」。 */
function CaptureOffHint(): ReactElement {
  return (
    <div className="space-y-1.5 text-xs text-ink-soft">
      <p className="text-ink-faint">
        请求正文抓取当前<strong className="font-medium text-ink">关闭</strong>
        （默认关闭：正文含用户内容，不落盘）。
      </p>
      <p>
        开启：设环境变量{" "}
        <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink">
          MODELMUX_LOG_PAYLOAD=1
        </code>{" "}
        后<strong className="font-medium text-ink">完整重启</strong>网关（
        <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink">
          mx stop &amp;&amp; mx start
        </code>
        ），之后的新请求才会记录。
      </p>
      <p className="text-ink-faint">
        可用 <code className="font-mono">MODELMUX_LOG_PAYLOAD_CIDS</code> 限定渠道、
        <code className="font-mono">MODELMUX_LOG_PAYLOAD_MAX_BYTES</code> 改单条上限；
        正文保留期默认 3 天（<code className="font-mono">MODELMUX_LOG_PAYLOAD_DAYS</code>）。
      </p>
    </div>
  );
}

/** 请求上下文：客户端原样体 + 每次尝试的实际上行体（按 id 现查）。 */
function PayloadSection({
  id,
  date,
  enabled,
}: {
  id: string;
  date: string;
  enabled: boolean;
}): ReactElement {
  const payload = useQuery({
    queryKey: ["logPayload", id, date],
    queryFn: () => api.logPayload(id, date === "" ? undefined : date),
    enabled,
    // 抓取记录写入即定稿，不必反复拉
    staleTime: 60_000,
  });

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-ink">请求上下文</div>
      {!enabled ? (
        <CaptureOffHint />
      ) : payload.isPending ? (
        <div className="text-xs text-ink-faint">正在读取…</div>
      ) : payload.isError ? (
        <div className="text-xs text-danger">请求上下文读取失败</div>
      ) : (payload.data?.records.length ?? 0) === 0 ? (
        <p className="text-xs text-ink-faint">
          该请求没有抓取记录（早于开启时间，或已被保留期清理）。
        </p>
      ) : (
        <div className="space-y-2">
          {payload.data?.records.map((record) => (
            <PayloadRecordBlock key={`${record.phase}-${record.seq}`} record={record} />
          ))}
          <p className="text-[11px] text-ink-faint">
            正文按原样落盘，未做脱敏；上游响应正文本页不展示。
          </p>
        </div>
      )}
    </div>
  );
}

/** 展开行：请求全字段 + 请求上下文。 */
function LogDetail({
  entry,
  date,
  payloadEnabled,
}: {
  entry: AccessLogEntry;
  date: string;
  payloadEnabled: boolean;
}): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  return (
    <div className="space-y-4 bg-canvas/40 px-4 py-3">
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
          总 {formatDuration(entry.durationMs)} · 上游接单 {formatDuration(entry.upstreamMs)} ·
          首字节 {formatDuration(entry.ttfbMs)}
        </Field>
        <Field label="请求规模">
          {formatBytes(entry.requestBytes)} · {entry.messageCount ?? "-"} 条消息 · system{" "}
          {entry.systemChars === undefined ? "-" : formatCount(entry.systemChars)} 字符 ·{" "}
          {entry.toolCount ?? 0} 个工具
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
          {entry.tokens === null
            ? "上游未返回 usage"
            : `入 ${countOrDash(entry.tokens.prompt)} · 出 ${countOrDash(
                entry.tokens.completion,
              )} · 共 ${countOrDash(entry.tokens.total)}`}
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

      <PayloadSection id={entry.id} date={date} enabled={payloadEnabled} />
    </div>
  );
}

const COL_WIDTHS = {
  toggle: "30px",
  time: "84px",
  result: "116px",
  model: "auto",
  stream: "52px",
  duration: "76px",
  tokens: "118px",
} as const;

function ResultCell({ entry }: { entry: AccessLogEntry }): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  return (
    <td className="whitespace-nowrap px-3 py-2">
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
  expanded,
  onToggle,
  onLoadMore,
  loading,
}: {
  page: AccessLogPage;
  expanded: string | null;
  onToggle: (id: string) => void;
  onLoadMore: () => void;
  loading: boolean;
}): ReactElement {
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: COL_WIDTHS.toggle }} />
            <col style={{ width: COL_WIDTHS.time }} />
            <col style={{ width: COL_WIDTHS.result }} />
            <col />
            <col style={{ width: COL_WIDTHS.stream }} className="hidden md:table-column" />
            <col style={{ width: COL_WIDTHS.duration }} />
            <col style={{ width: COL_WIDTHS.tokens }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left text-[11px] font-normal text-ink-faint">
              <th className="px-3 py-2" />
              <th className="px-3 py-2 font-normal">时间</th>
              <th className="px-3 py-2 font-normal">结果</th>
              <th className="px-3 py-2 font-normal">模型</th>
              <th className="hidden px-3 py-2 font-normal md:table-cell">流</th>
              <th className="px-3 py-2 font-normal">耗时</th>
              <th className="px-3 py-2 font-normal">tokens（入/出）</th>
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
                        className="grid h-5 w-5 place-items-center rounded text-ink-faint hover:bg-overlay hover:text-ink"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs tabular text-ink-soft">
                      {formatTime(entry.ts)}
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
                    <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs tabular text-ink-soft">
                      {formatDuration(entry.durationMs)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs tabular text-ink-soft">
                      {tokensText(entry)}
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-line/40">
                      <td colSpan={7} className="p-0">
                        <LogDetail
                          entry={entry}
                          date={page.date}
                          payloadEnabled={page.payload_enabled}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {page.entries.length < page.total && (
        <div className="border-t border-line/60 px-3 py-2 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="rounded-lg border border-line px-3 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            {loading ? "加载中…" : `加载更多（已显示 ${page.entries.length} / ${page.total}）`}
          </button>
        </div>
      )}
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
 * 自动刷新 5 秒一次；**展开详情或已翻页时暂停** —— 否则行会跳动、
 * 用户正在看的记录可能被刷新挤走。数据本身只读，不提供手动刷新按钮以外的入口。
 */
export function Logs(): ReactElement {
  const [date, setDate] = useState("");
  const [outcome, setOutcome] = useState<"" | AccessOutcome>("");
  const [cid, setCid] = useState("");
  const [rawSearch, setRawSearch] = useState("");
  const search = useDebounced(rawSearch, 300);
  const [slowOnly, setSlowOnly] = useState(false);
  const [streamOnly, setStreamOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const logs = useQuery({
    queryKey: ["logs", date, outcome, cid, search, slowOnly, streamOnly, limit],
    queryFn: () =>
      api.logs({
        date: date === "" ? undefined : date,
        outcome: outcome === "" ? undefined : outcome,
        cid: cid === "" ? undefined : cid,
        q: search === "" ? undefined : search,
        slow: slowOnly ? true : undefined,
        stream: streamOnly ? true : undefined,
        limit,
      }),
    refetchInterval: expanded !== null || limit > PAGE_SIZE ? false : 5_000,
  });

  const page = logs.data;
  const dirty =
    date !== "" || outcome !== "" || cid !== "" || search !== "" || slowOnly || streamOnly;
  const reset = (): void => {
    setDate("");
    setOutcome("");
    setCid("");
    setRawSearch("");
    setSlowOnly(false);
    setStreamOnly(false);
    setLimit(PAGE_SIZE);
    setExpanded(null);
  };
  /** 展开的条目可能已被新筛选挤走：找不到就不渲染详情。 */
  const expandedEntry = page?.entries.find((entry) => entry.id === expanded) ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="日志"
        description="网关每次请求的时间、渠道与模型、耗时、tokens 与结果"
        actions={
          <button
            type="button"
            onClick={() => void logs.refetch()}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <RotateCw className={`h-3.5 w-3.5 ${logs.isFetching ? "animate-spin" : ""}`} />
            刷新
          </button>
        }
      />

      <div className="panel space-y-3 p-3">
        {page ? (
          <StatBar page={page} truncated={page.truncated} />
        ) : (
          <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
        )}
        <Filters
          page={page}
          date={date}
          onDate={(value) => {
            setDate(value);
            setExpanded(null);
          }}
          outcome={outcome}
          onOutcome={(value) => {
            setOutcome(value);
            setExpanded(null);
          }}
          cid={cid}
          onCid={(value) => {
            setCid(value);
            setExpanded(null);
          }}
          search={rawSearch}
          onSearch={setRawSearch}
          slowOnly={slowOnly}
          onSlowOnly={setSlowOnly}
          streamOnly={streamOnly}
          onStreamOnly={setStreamOnly}
          dirty={dirty}
          onReset={reset}
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
          expanded={expandedEntry === null ? null : expandedEntry.id}
          onToggle={(id) => setExpanded((current) => (current === id ? null : id))}
          onLoadMore={() => setLimit((current) => current + PAGE_SIZE)}
          loading={logs.isFetching}
        />
      )}
    </div>
  );
}
