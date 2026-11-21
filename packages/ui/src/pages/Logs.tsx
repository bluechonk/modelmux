/**
 * 日志页：网关请求级访问日志（时间 / 响应 / 模型 / 耗时 / TPS / 缓存 / tokens）；
 * 字段语义、落点与读窗口见 docs/LOGGING.md §3。
 *
 * 关键约束（docs/LOGGING.md §3）：
 *   - 行内 `ts` 是 UTC、目录按**本地**日期切分 —— 展示一律转本地时区（UTC+8 凌晨两者差一天）
 *   - 表头与单元格内容统一居中：每列「表头中心 == 数据中心」，列间不再靠左沿相碰
 */

import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "../components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { api } from "../lib/api";
import {
  countOrDash,
  formatBytes,
  cacheHitRateText,
  formatCacheHitRate,
  formatClock,
  formatCount,
  formatDate,
  formatDuration,
  formatRate,
  formatTimestamp,
  formatTokens,
  formatTokensPerSec,
  OUTCOME_META,
  tokensPairText,
} from "../lib/log-format";
import type { AccessLogEntry, AccessLogPage, AccessOutcome } from "../lib/types";
import { useNarrow } from "../lib/use-narrow";
import { CopyButton } from "../components/CopyButton";
import { PageHeader } from "../components/PageHeader";
import { useRefreshInterval } from "../lib/refresh-interval";
import { ScrollFade } from "../components/ScrollFade";
import { Select, type SelectOption } from "../components/Select";
import { Skeleton } from "./Dashboard";

/** 选路剔除原因的展示文案（与后端 `RouteSkipReason` 一一对应）。 */
const ROUTE_SKIP_LABEL: Record<"auth" | "cred_error" | "window" | "unauthorized" | "cooling", string> = {
  auth: "未登录",
  cred_error: "凭据读取失败",
  window: "超窗",
  unauthorized: "凭据失效",
  cooling: "冷却中",
};

/** 每页条数档位（10 / 20 / 50）。 */
const PAGE_SIZE_OPTIONS = [10, 20, 50];/** 每页条数默认档：日志按时间倒序，先看最近的就够。 */
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
  /*
   * chip 排与账号池总览条（`Accounts.tsx` 的 SUMMARY_ORDER）同规格：
   * `bg-overlay/50` + `rounded-lg` + `px-2.5 py-1` + `text-xs`，数字 `font-mono tabular-nums`。
   * 纯文字加分隔符在窄屏折行后像「错位的两行」，chip 换行时逐枚对齐，标签与数字永远同单元。
   *
   * 不再显示「请求 N」：下面筛选栏分段的「全部 N」就是它，同屏两个相同数字只占位置。
   * 缓存命中率取 `stats.cache.hitRate`（后端按**当前筛选范围**加权 Σhit/Σ(hit+miss)），
   * 所以换渠道、换日期它跟着变；窗口内没有一条带缓存字段时为 null，显示 `—`。
   */
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3 text-xs text-ink-soft">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-free" />
        成功率
        <span className="font-mono tabular-nums text-ink">{rate === null ? "-" : `${rate}%`}</span>
      </span>
      {/* 不再显示「慢」条数：快慢由 TPS 数字自证，阈值是人定的。
          `?? null`：字段缺失（旧构建的载荷）必须显示 `—`，不是 `NaN t/s` */}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1">
        平均 TPS
        <span className="font-mono tabular-nums text-ink">{formatRate(stats.avgTps ?? null)}</span>
      </span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-free" />
        平均缓存命中率
        <span className="font-mono tabular-nums text-ink">{formatCacheHitRate(stats.cache?.hitRate ?? null)}</span>
      </span>
      {/*
        不再展示「统计只覆盖最近 N 条（读窗口上限）」—— 这是实现细节，对用户没有可操作价值。
      */}
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

/** 展开行：请求全字段。 */
function LogDetail({ entry }: { entry: AccessLogEntry }): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  return (
    // text-left：详情在 `<td>` 里，会继承表格的 `text-center` —— 长值（请求规模等）
    // 折行后半截悬在中间，读起来像错位（2026-11-15 手机实测）
    <div className="space-y-3 bg-canvas/40 px-4 py-3 text-left">
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
        {entry.route && (
          <Field label="选路">
            {/* 候选顺序与剔除原因是选路的全部事实；不展示等于「为什么这次走了这家」无从查证 */}
            <span className="tabular">
              输入估算 {entry.route.est > 0 ? `${formatCount(entry.route.est)} tokens` : "-"} · 候选{" "}
              {entry.route.candidates.length} · 试 {entry.route.attempts.join(" → ") || "-"}
            </span>
            {entry.route.skipped.length > 0 && (
              <span className="tabular text-ink-faint">
                · 跳过{" "}
                {entry.route.skipped
                  .map((s) => `${s.cid}(${ROUTE_SKIP_LABEL[s.why]})`)
                  .join("、")}
              </span>
            )}
          </Field>
        )}
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
 * 为什么用百分比而不是 px：Chrome 的 `table-fixed` 对**全列 px 定宽**的表，窗口宽于
 * 列宽总和时**列不放大**、剩余空间留在表右缘（1920 实拍右缘空 ~40%）；百分比列宽随
 * 容器等比伸缩，宽窄两端比例都恒定。窄屏 `md:min-w-[720px]` 保住可读下限（低于则
 * 容器 `overflow-auto` 横滚）。
 * 数值列（耗时 / tokens）右对齐，位数不同也能对齐（全站同一约定）。
 */
/**
 * 列宽（`>` 展开箭头列移除后重新分配；时间列放完整时间戳）。
 * 展开交互改为整行点击 + 行焦点（Enter / 空格），首列的呼吸位由对称内边距给
 * （居中列的内容中心线要等于列中心线，不对称内边距会把内容推离表头）。
 *
 * 百分比按**最坏宽度 688px** 逐列量过（`md:min-w-[720px]` 的 md 断点是 768 ——
 * 735–767 视口下表格只有容器宽 688，按 720 标定等于没标定，2026-11-18 实测），
 * 且必须 ≥「表头与数据里较宽的一侧 + 对称内边距」：
 * `nowrap` 文字超出列宽时 Chrome 的 `text-center` **只向右溢出**（不是两侧对称），
 * 表头与数据的中心就此错开（实测 tokens 列差 13px、缓存列差 3.6px）。
 * 时间 149（完整时间戳）、响应 40（点 + 三位码）、渠道 74（`qwenworkcn`）、
 * 耗时 41、TPS 54（`206 t/s`）、缓存 68（表头「缓存命中率」60）、tokens 150（`71.16 万 / 1.16 万`）。
 * 模型列允许折行（`BreakableId` 在 `-` `/` `.` 后断），是唯一可压缩列。
 */
const COL_WIDTHS = {
  // 时间列装**完整时间戳**（`YYYY-MM-DD HH:mm:ss` ≈ 137px + 内边距）：
  // 选了「全部时间」后不同天的同一时刻必须可分，只给 `HH:MM:SS` 会看混
  time: "22%",
  result: "6%",
  channel: "11%",
  model: "15%",
  duration: "6%",
  tokensPerSec: "8%",
  cache: "10%",
  tokens: "22%",
} as const;

/**
 * 窄屏（< 735px）的列宽：时间列是**两行**（日期 + `HH:MM:SS`），日期 72px 内容。
 *
 * 窄屏只留「时间 / 响应 / 模型」三列，模型列仍是唯一弹性列（吃剩余）——
 * 只有四列时不存在「中间空一大块」的问题。
 *
 * **时间 / 响应用固定 px，不用百分比**：时间内容下限 ≈ 70px（`HH:MM:SS` 57 + 内边距）；
 * 响应列去掉「成功/失败」文字后只剩 点 + 三位状态码（≈46px），56px 够。
 * 百分比在 340px 表宽下会把这两列削到装不进内容（2026-11-15 实测过撞列）。
 */
const NARROW_COL_WIDTHS: Record<keyof typeof COL_WIDTHS, string> = {
  time: "76px",
  result: "56px",
  channel: "18.4%",
  model: "",
  duration: "5.2%",
  tokensPerSec: "7%",
  cache: "8.7%",
  tokens: "17.6%",
};

/**
 * 列定义（列宽 + 窄屏是否保留；对齐统一由 table 的 `text-center` 给）。
 *
 * 表头与表体**共用这一份**，改列只改这里；`< md` 丢弃 `wide` 列时是**少渲染
 * `<td>`**，不是 `hidden md:table-cell`（`display:none` 的 `<td>` 在
 * `table-layout: fixed` 下仍占列槽位、表头表体还会错位 —— 见 lib/use-narrow.ts）。
 */
interface LogCol {
  key: keyof typeof COL_WIDTHS;
  label: string;
  /** `< md` 丢弃。窄屏只留「时间 / 响应 / 模型」，其余信息在展开行（整行可点）里。 */
  wide?: boolean;
}

const LOG_COLS: LogCol[] = [
  { key: "time", label: "时间" },
  { key: "result", label: "响应" },
  { key: "channel", label: "渠道", wide: true },
  { key: "model", label: "模型" },
  { key: "duration", label: "耗时", wide: true },
  { key: "tokensPerSec", label: "TPS", wide: true },
  { key: "cache", label: "缓存命中率", wide: true },
  { key: "tokens", label: "tokens（入/出）", wide: true },
];

/**
 * 响应单元格：色点 + 状态码，整体居中（与表头同中心线）。
 *
 * 「成功 / 失败」文字不在列表里重复 —— 展开行「结果」字段给全了，列里再写只是占宽；
 * 成败由点的颜色承担，sr-only 保住读屏语义（正文信息不依赖 hover 的同一口径）。
 */
function ResultCell({ entry }: { entry: AccessLogEntry }): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  return (
    <TableCell className="whitespace-nowrap px-1 py-2 align-top">
      <div className="flex items-center justify-center gap-1.5 text-xs">
        <span className={`block h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
        <span className="sr-only">{meta.label}</span>
        <span className="font-mono text-ink-faint">{entry.status ?? "-"}</span>
      </div>
    </TableCell>
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
  narrow,
}: {
  col: LogCol;
  entry: AccessLogEntry;
  narrow: boolean;
}): ReactElement {
  // 内边距全部**对称**：居中列里不对称的左右距会把内容中心推离表头中心（实测过差 4–9px）
  // 对齐由 table 的 text-center 统一给（数值列不再右对齐：居中后表头与数据同中心线）
  const numClass = `whitespace-nowrap ${col.key === "tokens" ? "px-4" : "px-1"} py-2 align-top font-mono text-xs tabular text-ink-soft`;
  switch (col.key) {
    // 时间列是全表首列：左右等宽 `px-3` 给呼吸位（`>` 箭头列移除后行贴左沿，实测很局促；
    // 不对称的 `pl-3 pr-1` 会让内容与表头中心错开，居中口径下必须等宽）；
    // 宽屏一行完整 `YYYY-MM-DD HH:MM:SS`（「全部时间」下跨天看混过）；窄屏拆两行（日期在上）
    case "time":
      return (
        <TableCell className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs tabular text-ink-soft">
          {narrow ? (
            <span className="flex flex-col items-center leading-tight">
              <span>{formatDate(entry.ts)}</span>
              <span>{formatClock(entry.ts)}</span>
            </span>
          ) : (
            formatTimestamp(entry.ts)
          )}
        </TableCell>
      );
    case "result":
      return <ResultCell entry={entry} />;
    case "channel":
      return (
        <TableCell className="whitespace-nowrap px-1 py-2 align-top font-mono text-xs text-ink-soft">
          {entry.cid ?? <span className="text-ink-faint">-</span>}
        </TableCell>
      );
    case "model":
      return (
        <TableCell className="break-words px-1 py-2 align-top text-xs text-ink-soft">
          {entry.model ? (
            <BreakableId value={entry.model} />
          ) : (
            <span className="font-mono text-ink-faint">{entry.path ?? "-"}</span>
          )}
        </TableCell>
      );
    case "duration":
      return <TableCell className={numClass}>{formatDuration(entry.durationMs)}</TableCell>;
    case "tokensPerSec":
      return <TableCell className={numClass}>{formatTokensPerSec(entry)}</TableCell>;
    case "cache":
      return <TableCell className={numClass}>{cacheHitRateText(entry.tokens?.cache)}</TableCell>;
    case "tokens":
      return <TableCell className={numClass}>{tokensPairText(entry.tokens)}</TableCell>;
  }
}

function LogTable({
  page,
  pageNum,
  totalPages,
  expanded,
  onToggle,
  onPageChange,
  loading,
}: {
  page: AccessLogPage;
  pageNum: number;
  totalPages: number;
  expanded: string | null;
  onToggle: (id: string) => void;
  onPageChange: (page: number) => void;
  loading: boolean;
}): ReactElement {
  /**
   * 阈值 735 而不是默认的 767：窗口最小宽是 736（见 desktop/main.cjs），
   * 736 下内容宽 688，仍走 8 列的宽表（720 的 `min-w` 由外层横滚兜住）。
   * 再按 768 退化就只剩 3 列 —— 那是「砍列」不是「压缩」，与本表的设计取向相反。
   */
  const narrow = useNarrow(735);
  const cols = narrow ? LOG_COLS.filter((col) => !col.wide) : LOG_COLS;
  const widths: Record<keyof typeof COL_WIDTHS, string> = narrow ? NARROW_COL_WIDTHS : COL_WIDTHS;
  // whitespace-nowrap：`table-fixed` 下中文表头会在空格处折成竖排（「缓存 命中/未命中」挤成 5 行）
  // 末列与表体共用同一套内边距（含加大的右距），否则表头与数据右沿错开
  // 显式 text-center：UA 样式表给 `th` 的默认对齐会压过 table 的继承值（实测 th 计算值是 left）
  // align-top 与表体一致：表体是 align-top（多行内容顶对齐），表头若用 UA 默认的 middle，
  // 两行文字在各自行内的相对位置不同（实测差约 3px）
  const headClass = (key: string): string =>
    `whitespace-nowrap text-center align-top ${
      key === "tokens" ? "px-4" : key === "time" ? "px-3" : "px-1"
    } py-2 font-normal`;
  return (
    <div className="panel flex min-h-0 flex-1 flex-col">
      <ScrollFade wrapperClassName="flex min-h-0 flex-1 flex-col" className="min-h-0 flex-1 overflow-auto">
        {/*
          全表**居中**：表头与数据同列中心线重合（左对齐时表头两字与数据长串只在左沿
          相碰、中心差几十像素；右对齐时数值列中心同样错开）。居中后每列
          「表头中心 == 数据中心」，是这张表唯一能逐列对上的对齐方式。
        */}
        {/* min-w 340：三列的窄表里「HH:MM:SS」需要 57px（时间 17%），300px 下再怎么调
            比例都装不下 —— 低于 340 的视口转内层横滚，ScrollFade 在右缘提示 */}
        <Table className="w-full table-fixed border-collapse text-center text-sm min-w-[340px] md:min-w-[720px]">
          <colgroup>
            {cols.map((col) => (
              <col key={col.key} style={widths[col.key] ? { width: widths[col.key] } : undefined} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow className="border-b border-line text-xs text-ink-faint">
              {cols.map((col) => (
                <TableHead key={col.key} className={headClass(col.key)}>
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.entries.map((entry) => {
              const open = expanded === entry.id;
              return (
                <Fragment key={entry.id}>
                  <TableRow
                    // `>` 箭头列移除后，展开交互 = 整行点击 + 行焦点（键盘 Enter / 空格）
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => onToggle(entry.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onToggle(entry.id);
                      }
                    }}
                    className={`cursor-pointer border-b border-line transition-colors last:border-b-0 hover:bg-overlay/40 focus-visible:outline-2 focus-visible:outline-brand/55 ${
                      open ? "bg-overlay/30" : ""
                    }`}
                  >
                    {cols.map((col) => (
                      <LogCell key={col.key} col={col} entry={entry} narrow={narrow} />
                    ))}
                  </TableRow>
                  {open && (
                    <TableRow className="border-b border-line">
                      <TableCell colSpan={cols.length} className="p-0">
                        <LogDetail entry={entry} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
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
  return (
    <Pagination aria-label="分页" className="shrink-0 border-t border-line/70 bg-canvas/95 px-3 py-2">
      <PaginationContent className="w-full justify-end gap-2">
        <PaginationItem>
          <PaginationPrevious
            disabled={pageNum <= 1 || loading}
            onClick={() => onPageChange(pageNum - 1)}
            className="tap-square h-7"
          >
            <ChevronLeft className="h-4 w-4" />
          </PaginationPrevious>
        </PaginationItem>
        <PaginationItem>
          <span className="min-w-16 text-center text-xs tabular text-ink-soft">
            {pageNum} / {totalPages}
          </span>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            disabled={pageNum >= totalPages || loading}
            onClick={() => onPageChange(pageNum + 1)}
            className="tap-square h-7"
          >
            <ChevronRight className="h-4 w-4" />
          </PaginationNext>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
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
  narrow,
  page,
  date,
  onDate,
  outcome,
  onOutcome,
  cid,
  onCid,
  model,
  onModel,
  pageSize,
  onPageSizeChange,
  dirty,
  onReset,
  allChannels,
  allModels,
  dateBasis,
}: {
  /** 窄屏（<735，与表格收敛同口径）：下拉组换行后占满整行靠左排。 */
  narrow: boolean;
  page: AccessLogPage | undefined;
  date: string;
  onDate: (value: string) => void;
  outcome: "" | AccessOutcome;
  onOutcome: (value: "" | AccessOutcome) => void;
  cid: string;
  onCid: (value: string) => void;
  model: string;
  onModel: (value: string) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  dirty: boolean;
  onReset: () => void;
  /** 全部在册渠道：下拉**恒列全部**（不按当前日志的渠道子集收缩），也是定宽基准。 */
  allChannels: ReadonlyArray<string>;
  /** 对外模型（去重后的裸名）：与账号池模型清单同源，恒列全部。 */
  allModels: ReadonlyArray<string>;
  /** 日期下拉的定宽基准（含完整 YYYY-MM-DD）。 */
  dateBasis: ReadonlyArray<string>;
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
  // 「全部时间」= 跨所有有日志的日期聚合（值 `all`，后端同口径）；
  // 「今天」不再单列 —— 它就是日期列表里的一个普通日期（`YYYY-MM-DD`）
  const dateOptions: SelectOption[] = [
    { value: "all", label: "全部时间" },
    ...(page?.dates ?? []).map((value) => ({ value, label: value })),
  ];
  /**
   * 渠道下拉**恒列全部在册渠道**（不按当前日期/日志的渠道子集收缩）——
   * 选了某天没有某渠道的日志时，选项仍在（选中后列表为空总比选项消失好判断）。
   * 定宽基准与选项同源，宽度不随日期筛选变化。
   */
  const cidOptions: SelectOption[] = [
    { value: "", label: "全部渠道" },
    ...allChannels.map((value) => ({ value, label: value })),
  ];
  // 模型下拉同渠道：恒列对外模型全集（不按当前日志出现的模型收缩），
  // 选中某个当天没记录的模型时列表为空，也比选项消失更好判断。
  const modelOptions: SelectOption[] = [
    { value: "", label: "全部模型" },
    ...allModels.map((value) => ({ value, label: value })),
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

      {/*
        渠道 / 时间 / 每页三个下拉右置并排：都开 `fixedWidth`（按各自最宽选项量宽），
        切换选项时按钮位置纹丝不动；清除筛选**常驻**，无筛选时禁用而非隐藏。
        窄屏整组换行后占满整行、靠左排 —— ml-auto + justify-end 会把换行后的下拉组
        推到行右侧悬空，与上方的结果分段错位（2026-11-14 实拍裁决）。
      */}
      <span
        className={`flex flex-wrap items-center gap-2 text-xs text-ink-faint ${
          narrow ? "w-full" : "ml-auto justify-end"
        }`}
      >
        <Select
          label="渠道"
          value={cid}
          onChange={onCid}
          options={cidOptions}
          fixedWidth
          widthBasis={["全部渠道", ...allChannels]}
        />
        <Select
          label="模型"
          value={model}
          onChange={onModel}
          options={modelOptions}
          fixedWidth
          widthBasis={["全部模型", ...allModels]}
        />
        <Select label="日期" value={date} onChange={onDate} options={dateOptions} fixedWidth widthBasis={dateBasis} />
        <span className="flex items-center gap-1.5">
          每页
          <Select
            label="每页条数"
            value={String(pageSize)}
            onChange={(value) => onPageSizeChange(Number(value))}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            fixedWidth
          />
          条
        </span>
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty}
          className="tap rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:border-line disabled:hover:text-ink-soft"
        >
          清除筛选
        </button>
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
  /** 窄屏（<735，与表格收敛同口径）：筛选下拉组换行后占满整行靠左排。 */
  const narrow = useNarrow(735);
  const [date, setDate] = useState("all");
  const [outcome, setOutcome] = useState<"" | AccessOutcome>("");
  const [cid, setCid] = useState("");
  const [model, setModel] = useState("");
  const [pageSize, setPageSizeState] = useState(storedPageSize);
  const [pageNum, setPageNum] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 日志列表的自动刷新节奏（设置页可调，最小 5s）。 */
  const { interval: logsInterval } = useRefreshInterval("logs");

  /**
   * 渠道下拉的**定宽基准**取全部在册渠道（快照 `channel_caps`），
   * 不用当前日志里的渠道子集 —— 后者随日志内容增减，按钮宽度会跟着变。
   * 与 LayoutSingle 共用 `["state"]` 缓存，不额外发起轮询。
   */
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const allChannels = Object.keys(state.data?.channel_caps ?? {});
  /** 对外模型（快照 `models` 的 `model` 去重）：与账号池模型清单同源。 */
  const allModels = [...new Set((state.data?.models ?? []).map((row) => row.model))];
  /** 日期基准：完整 `YYYY-MM-DD` 恒为最长（「全部时间」更短），不随日期列表增减变化。 */
  const dateBasis = ["全部时间", localToday()];

  const logs = useQuery({
    // `pageSize` 必须进 key：`limit`/`offset`/`totalPages` 都由它推导，漏掉会出现
    // 「第 1 页切每页 50 → 不重取 → 仍是 20 行，而分页器按 50 算」——
    // 更糟的是下一页 offset 按 50 跳，第 21–50 条永远看不到（实测出现过）。
    queryKey: ["logs", date, outcome, cid, model, pageNum, pageSize],
    // 再进页面 / 切筛选时先出上一次的数据（列表页最怕被清空成骨架）
    placeholderData: (prev) => prev,
    queryFn: () =>
      api.logs({
        date: date === "" ? undefined : date,
        outcome: outcome === "" ? undefined : outcome,
        cid: cid === "" ? undefined : cid,
        model: model === "" ? undefined : model,
        limit: pageSize,
        offset: (pageNum - 1) * pageSize,
      }),
    // 展开行 / 翻页时暂停：此刻轮询会把用户正在读的详情顶掉
    refetchInterval: expanded !== null || pageNum > 1 ? false : logsInterval,
    // 与轮询同长：间隔内再进页面直接用缓存（列表页最怕被清空成骨架）
    staleTime: logsInterval,
  });

  const page = logs.data;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1;
  // 翻页后新数据变少（别的端清了日志、筛选命中变少）会把页码顶空 —— 收回到最后一页。
  useEffect(() => {
    if (pageNum > totalPages) setPageNum(totalPages);
  }, [pageNum, totalPages]);
  const dirty = date !== "all" || outcome !== "" || cid !== "" || model !== "";
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

  // 根容器 `h-full`：本页把页面钉成一屏 —— LayoutSingle 在日志页关掉 `main` 的滚动
  // （`overflow-hidden`）并给内层确定高度，纵向滚动只属于下方表格区（见 LogTable）。
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader title="请求日志" />

      {/* 统计条 + 筛选栏：页面已不滚动，天然常驻可见，不再需要 sticky */}
      <div className="panel space-y-3 p-3">
        {page ? (
          <StatBar page={page} />
        ) : (
          <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
        )}
        <Filters
          narrow={narrow}
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
          model={model}
          onModel={(value) => {
            setModel(value);
            setExpanded(null);
            resetToFirstPage();
          }}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPageNum(1);
            setExpanded(null);
          }}
          allChannels={allChannels}
          allModels={allModels}
          dateBasis={dateBasis}
          dirty={dirty}
          onReset={() => {
            setDate("all");
            setOutcome("");
            setCid("");
            setModel("");
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
            控制台与网关同进程：网关不可用时这里也读不到；恢复后轮询会自动重试。
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
          loading={logs.isFetching}
        />
      )}
    </div>
  );
}
