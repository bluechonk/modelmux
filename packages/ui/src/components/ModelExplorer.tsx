/**
 * 模型区：工具条 + 分组表 / 扁平表。
 *
 * ## 为什么不是「双列渠道卡」
 *
 * 旧版把每个渠道做成一张卡、丢进两列网格。卡高由内容（模型 chip 逐行换行）决定，
 * 网格行高取最高那张 —— 于是**模型少的渠道被拉出等高的空盒子**，内容顶对齐，
 * 页面出现整片空白（实测 30 个模型 vs 9 个模型并排，失衡最明显）。
 *
 * 现在改成**纵向的渠道区块**：每个渠道一个全宽表块，高度 ∝ 它的模型数，
 * **结构上不可能出现空洞**。渠道维度从「并排的卡」变成「分组表头」，
 * 模型维度从「一堆 chip」变成「等高的行」，两种粒度不再互相打架。
 *
 * ## 两种视图
 *
 * - **分组**（默认）：按渠道分区，band 上写模型数 / 免费数 / 可吃图数 / 倍率区间。
 * - **扁平**：全部模型按倍率升序排成一张表，渠道作为一列 —— 回答「最便宜的模型在哪」。
 *
 * 行里除了模型名与倍率，还给出**上下文窗口 / 单次输出上限 / 输入模态**：
 * 这三项数据共享层的 `PoolModelMeta` 本来就有（旧版只画 chip，信息被丢了）。
 */

import { ChevronDown, ChevronRight, Image as ImageIcon, LayoutList, Rows3, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { CopyButton } from "./CopyChip";

/**
 * 元数据取值的来源（与共享层 `MetaSource` 同形）。
 *
 * 只有 `cross` 会在界面上标出来（「推断」）—— 那是**兄弟渠道同 id** 的值，
 * 不是本渠道上游说的，不能让它看起来像事实。
 */
export type MetaSource = "upstream" | "spec" | "cross" | "default";

/** 单个模型的元数据（与共享层 `PoolModelMeta` 对齐）。 */
export interface ModelMeta {
  multiplier: number | null;
  marketing: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  /**
   * 思考模式（reasoning effort）档位；`null` = 渠道未声明（界面上显示「不支持」）。
   *
   * 与共享层 `PoolModelMeta.effort` 同形：**刻意可空** —— 兜底不许编档位，
   * 否则「不知道」会被显示成「支持」。
   */
  effort?: { supportedLevels: string[]; defaultLevel: string } | null;
  /** 窗口 / 输出 / 档位各自从哪来（缺省按「上游声明」呈现，兼容旧快照）。 */
  sources?: { contextWindow: MetaSource; maxOutputTokens: MetaSource; effort: MetaSource };
}

/** 倍率格式化：最多 4 位小数并去掉尾随 0。 */
export function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * 分组视图里**每个渠道默认露出的模型数**，其余折进「展开剩余 N 个模型」。
 *
 * 为什么是 3：渠道目录动辄几十个模型（workbuddyai / catpaw 尤甚），全展开会把
 * 仪表盘撑成几千像素的长页，反而看不见「哪个渠道供给什么」。搜索/筛选一旦生效
 * 就直接全展开（见 `GroupedTable` 的 `previewAll`）——用户在找东西时不该被藏。
 */
const PREVIEW_COUNT = 3;

/** 窗口/上限的紧凑写法：128000 → 128k，1000000 → 1M，981504 → 0.98M。 */
function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** 推断标记：跨渠道兜底来的值必须看得见「这是推断」，否则会被当成上游声明。 */
function InferredMark({ show }: { show: boolean }): ReactElement | null {
  if (!show) return null;
  return <span className="ml-1 text-[10px] text-ink-faint">推断</span>;
}

/** 一行模型（池 id 拆成渠道段与模型段）。 */
interface ModelRow {
  cid: string;
  id: string;
  poolId: string;
  meta: ModelMeta | undefined;
}

/** 排序位：倍率 0 与订阅制免费档排最前；倍率未知排最后（不冒充免费）。 */
function rankOf(multiplier: number | null, freePlan: boolean): number {
  if (multiplier === 0) return 0;
  if (multiplier == null) return freePlan ? 0 : Number.MAX_SAFE_INTEGER;
  return multiplier;
}

export function ModelExplorer({
  models,
  infoOf,
  freePlanCids,
}: {
  /** 池里的全部模型 id（`<cid>/<模型>`）。 */
  models: string[];
  /** 取模型元数据。 */
  infoOf: (poolId: string) => ModelMeta | undefined;
  /** 无倍率概念（订阅制）的渠道：其模型按「免费」计。 */
  freePlanCids: ReadonlySet<string>;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [cidFilter, setCidFilter] = useState("all");
  const [freeOnly, setFreeOnly] = useState(false);
  const [flat, setFlat] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 组内展开：默认每组只露前 `PREVIEW_COUNT` 个，其余点「展开」才出现。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggleExpanded = (cid: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  const rows = useMemo<ModelRow[]>(() => {
    const out: ModelRow[] = [];
    for (const poolId of models) {
      const slash = poolId.indexOf("/");
      const cid = slash < 0 ? poolId : poolId.slice(0, slash);
      const id = slash < 0 ? poolId : poolId.slice(slash + 1);
      out.push({ cid, id, poolId, meta: infoOf(poolId) });
    }
    return out;
  }, [models, infoOf]);

  const keyword = query.trim().toLowerCase();

  const visible = useMemo(() => {
    const out = rows.filter((row) => {
      if (cidFilter !== "all" && row.cid !== cidFilter) return false;
      if (freeOnly && !isFree(row, freePlanCids)) return false;
      if (keyword && !(row.id.toLowerCase().includes(keyword) || row.cid.includes(keyword))) {
        return false;
      }
      return true;
    });
    out.sort((a, b) => {
      const ra = rankOf(a.meta?.multiplier ?? null, freePlanCids.has(a.cid));
      const rb = rankOf(b.meta?.multiplier ?? null, freePlanCids.has(b.cid));
      return ra - rb || a.cid.localeCompare(b.cid) || a.id.localeCompare(b.id);
    });
    return out;
  }, [rows, cidFilter, freeOnly, keyword, freePlanCids]);

  /** 分组视图用：按渠道分区，区内保持上面的排序。 */
  const groups = useMemo(() => {
    const map = new Map<string, ModelRow[]>();
    for (const row of visible) {
      const list = map.get(row.cid) ?? [];
      list.push(row);
      map.set(row.cid, list);
    }
    return map;
  }, [visible]);

  const total = rows.length;
  const channelIds = useMemo(() => [...new Set(rows.map((r) => r.cid))].sort(), [rows]);

  /**
   * 是否存在跨渠道推断值 —— 有就给一句直接可见的说明。
   *
   * ⚠ 铁律：控制台不许用 hover 气泡，信息要么写进正文、要么点开看（见 docs/WEB-CONSOLE.md）。
   */
  const anyInferred = useMemo(
    () =>
      rows.some(
        (row) =>
          row.meta?.sources?.contextWindow === "cross" ||
          row.meta?.sources?.maxOutputTokens === "cross" ||
          row.meta?.sources?.effort === "cross",
      ),
    [rows],
  );

  const toggle = (cid: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  return (
    <section className="mb-2">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-normal tracking-tight text-ink">
          可用模型
          <span className="ml-2 text-xs font-normal text-ink-faint">渠道/模型</span>
        </h2>
        {anyInferred && (
          <span className="text-xs font-normal text-ink-faint">
            标「推断」的值取自同 id 的其他渠道
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型或渠道…"
              className="w-52 rounded-lg border border-line bg-raised py-1.5 pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint transition-colors hover:text-ink"
                aria-label="清除搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <select
            value={cidFilter}
            onChange={(e) => setCidFilter(e.target.value)}
            className="rounded-lg border border-line bg-raised px-2 py-1.5 text-xs text-ink-soft focus:border-line-strong focus:outline-none"
            aria-label="按渠道筛选"
          >
            <option value="all">全部渠道（{channelIds.length}）</option>
            {channelIds.map((cid) => (
              <option key={cid} value={cid}>
                {cid}（{rows.filter((r) => r.cid === cid).length}）
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setFreeOnly((v) => !v)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              freeOnly
                ? "border-free/40 bg-free/10 text-free"
                : "border-line bg-raised text-ink-soft hover:border-line-strong hover:text-ink"
            }`}
          >
            只看免费
          </button>

          <div className="flex overflow-hidden rounded-lg border border-line">
            <button
              type="button"
              onClick={() => setFlat(false)}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                flat ? "text-ink-faint hover:text-ink" : "bg-overlay text-ink"
              }`}
              aria-label="按渠道分组"
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setFlat(true)}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                flat ? "bg-overlay text-ink" : "text-ink-faint hover:text-ink"
              }`}
              aria-label="全部按倍率排平"
            >
              <Rows3 className="h-3.5 w-3.5" />
            </button>
          </div>

          <span className="font-mono text-[11px] text-ink-faint">
            {keyword || cidFilter !== "all" || freeOnly
              ? `${visible.length} / ${total}`
              : `${total} 个`}
          </span>
        </div>
      </div>

      {total === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">（无模型：先在账号池页完成渠道授权）</div>
      ) : visible.length === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">没有匹配的模型</div>
      ) : flat ? (
        <FlatTable rows={visible} freePlanCids={freePlanCids} />
      ) : (
        <GroupedTable
          groups={groups}
          freePlanCids={freePlanCids}
          collapsed={collapsed}
          onToggle={toggle}
          expanded={expanded}
          onToggleExpanded={toggleExpanded}
          previewAll={keyword !== "" || cidFilter !== "all" || freeOnly}
        />
      )}
    </section>
  );
}

/** 是否免费：倍率 0，或订阅制渠道（无倍率概念）。 */
function isFree(row: ModelRow, freePlanCids: ReadonlySet<string>): boolean {
  const m = row.meta?.multiplier;
  return m === 0 || (m == null && freePlanCids.has(row.cid));
}

/** 表头：列名 + 对齐方式。 */
function Head({
  showChannel,
}: {
  showChannel: boolean;
}): ReactElement {
  return (
    <thead className="sticky top-0 z-10 bg-raised">
      <tr className="border-b border-line text-[11px] text-ink-faint">
        <th className="whitespace-nowrap px-4 py-2 text-left font-normal">模型</th>
        {showChannel && <th className="whitespace-nowrap px-3 py-2 text-left font-normal">渠道</th>}
        <th className="whitespace-nowrap px-3 py-2 text-right font-normal">倍率</th>
        <th className="hidden whitespace-nowrap px-3 py-2 text-right font-normal md:table-cell">
          最大上下文
        </th>
        <th className="hidden whitespace-nowrap px-3 py-2 text-right font-normal md:table-cell">
          输出上限
        </th>
        <th className="hidden whitespace-nowrap px-3 py-2 text-left font-normal md:table-cell">
          思考模式
        </th>
        <th className="whitespace-nowrap px-3 py-2 text-left font-normal">输入</th>
        <th className="w-10 px-2 py-2" />
      </tr>
    </thead>
  );
}

/** 倍率单元格：免费档用绿色文字（不铺彩色底），其余用等宽数字。 */
function MultiplierCell({ row, freePlanCids }: { row: ModelRow; freePlanCids: ReadonlySet<string> }): ReactElement {
  const m = row.meta?.multiplier ?? null;
  const freePlan = freePlanCids.has(row.cid);
  if (m === 0 || (m == null && freePlan)) {
    return (
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <span className="font-mono text-[11px] text-free">免费</span>
      </td>
    );
  }
  if (m == null) {
    return <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-faint">—</td>;
  }
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft">
      ×{formatMultiplier(m)}
    </td>
  );
}

/** 输入模态单元格：能吃图才给标记，纯文本留白。 */
function ModalityCell({ row }: { row: ModelRow }): ReactElement {
  const modes = row.meta?.inputModalities ?? [];
  const vision = modes.includes("image");
  if (!vision) {
    return <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-faint">文本</td>;
  }
  return (
    <td className="whitespace-nowrap px-3 py-2">
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-soft">
        <ImageIcon className="h-3 w-3" />
        文本+图
      </span>
    </td>
  );
}

/** 思考档位的中文名：上游档位名是英文，控制台按中文呈现（未知档名原样显示）。 */
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

/**
 * 思考模式单元格：**渠道声明了档位才列出档位**，没声明就明确写「不支持」。
 *
 * ⚠ 不能给「不支持」的模型编档位：旧版共享层给所有模型都填了 `["low","high"]`，
 * 于是 200 个没声明过的模型都被显示成「支持 low/high」（主人 2026-10-24 反馈）。
 * 现在 `meta.effort` 为 null 就是「渠道没说」，如实呈现；
 * 跨渠道兜底来的档位带「推断」标记（与上游声明分开）。
 *
 * 窄屏（< md）整列隐藏 —— 与表头同一断点，否则会出现「列头没了、内容还在」。
 */
function ThinkingCell({ row }: { row: ModelRow }): ReactElement {
  const effort = row.meta?.effort ?? null;
  if (effort === null || effort.supportedLevels.length === 0) {
    return (
      <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-ink-faint md:table-cell">
        不支持
      </td>
    );
  }
  const levels = sortThinkingLevels(effort.supportedLevels).map(
    (level) => THINKING_LEVEL_LABELS[level.toLowerCase()] ?? level,
  );
  return (
    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-ink-soft md:table-cell">
      {levels.join(" / ")}
      <InferredMark show={row.meta?.sources?.effort === "cross"} />
    </td>
  );
}

/** 模型名单元格：等宽字体，超长截断（全名可用旁边的复制按钮取）。 */
function ModelNameCell({ row }: { row: ModelRow }): ReactElement {
  return (
    <td className="max-w-[22rem] truncate px-4 py-2 font-mono text-xs text-ink">
      {row.id}
    </td>
  );
}

/** 窗口/上限单元格（跨渠道推断来的值带「推断」标记）。 */
function SizeCell({
  value,
  inferred,
}: {
  value: number | undefined;
  inferred: boolean;
}): ReactElement {
  return (
    <td className="hidden whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft md:table-cell">
      {value ? compactNumber(value) : "—"}
      <InferredMark show={inferred} />
    </td>
  );
}

/** 复制按钮单元格。 */
function CopyCell({ row }: { row: ModelRow }): ReactElement {
  return (
    <td className="px-2 py-1.5 text-right">
      <CopyButton value={row.poolId} label={`复制 ${row.poolId}`} />
    </td>
  );
}

/** 分组表：每个渠道一个表块（band 行 + 模型行），全宽、不并排。 */
function GroupedTable({
  groups,
  freePlanCids,
  collapsed,
  onToggle,
  expanded,
  onToggleExpanded,
  previewAll,
}: {
  groups: Map<string, ModelRow[]>;
  freePlanCids: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (cid: string) => void;
  /** 组内「已展开全部」的渠道集合。 */
  expanded: ReadonlySet<string>;
  onToggleExpanded: (cid: string) => void;
  /** 有搜索/筛选时直接全展开：用户已经在缩小范围，再藏模型会挡住他要找的。 */
  previewAll: boolean;
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-raised">
      <table className="w-full min-w-[440px] border-collapse">
        <Head showChannel={false} />
        {[...groups.entries()].map(([cid, rows]) => {
          const isCollapsed = collapsed.has(cid);
          // 默认每组只露前 3 个：一个渠道几十个模型会把整页撑爆（见文件头布局说明）
          const showAll = previewAll || expanded.has(cid);
          const shown = showAll ? rows : rows.slice(0, PREVIEW_COUNT);
          const hidden = rows.length - shown.length;
          const free = rows.filter((r) => isFree(r, freePlanCids)).length;
          const vision = rows.filter((r) => (r.meta?.inputModalities ?? []).includes("image")).length;
          const mults = rows
            .map((r) => r.meta?.multiplier)
            .filter((m): m is number => m != null && m > 0);
          return (
            <tbody key={cid}>
              <tr>
                <th colSpan={8} scope="rowgroup" className="border-b border-line bg-canvas/50 text-left">
                  <div className="flex items-center gap-2.5 px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => onToggle(cid)}
                      className="grid h-5 w-5 place-items-center rounded text-ink-faint transition-colors hover:text-ink"
                      aria-label={isCollapsed ? `展开 ${cid}` : `折叠 ${cid}`}
                    >
                      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <span className="font-mono text-[13px] font-medium text-ink">{cid}</span>
                    <span className="text-[11px] text-ink-faint">{rows.length} 个模型</span>
                    {free > 0 && <span className="text-[11px] text-free">{free} 个免费</span>}
                    {vision > 0 && <span className="text-[11px] text-ink-faint">{vision} 个可吃图</span>}
                    {mults.length > 0 && (
                      <span className="ml-auto font-mono text-[11px] text-ink-faint">
                        ×{formatMultiplier(Math.min(...mults))}–×{formatMultiplier(Math.max(...mults))}
                      </span>
                    )}
                  </div>
                </th>
              </tr>
              {!isCollapsed &&
                shown.map((row) => (
                  <tr
                    key={row.poolId}
                    className="border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40"
                  >
                    <ModelNameCell row={row} />
                    <MultiplierCell row={row} freePlanCids={freePlanCids} />
                    <SizeCell
                      value={row.meta?.contextWindow}
                      inferred={row.meta?.sources?.contextWindow === "cross"}
                    />
                    <SizeCell
                      value={row.meta?.maxOutputTokens}
                      inferred={row.meta?.sources?.maxOutputTokens === "cross"}
                    />
                    <ThinkingCell row={row} />
                    <ModalityCell row={row} />
                    <CopyCell row={row} />
                  </tr>
                ))}
              {/* 折叠隐藏的数量 + 展开/收起开关：只在「有隐藏项」或「已手动展开」时出现 */}
              {!isCollapsed && (hidden > 0 || (!previewAll && expanded.has(cid) && rows.length > PREVIEW_COUNT)) && (
                <tr className="border-b border-line/40 last:border-b-0">
                  <td colSpan={8} className="px-4 py-1.5">
                    <button
                      type="button"
                      onClick={() => onToggleExpanded(cid)}
                      className="text-[11px] text-ink-faint transition-colors hover:text-brand"
                      aria-expanded={showAll}
                    >
                      {hidden > 0 ? `展开剩余 ${hidden} 个模型` : "收起"}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** 扁平表：全部模型按倍率升序，渠道作为一列。 */
function FlatTable({
  rows,
  freePlanCids,
}: {
  rows: ModelRow[];
  freePlanCids: ReadonlySet<string>;
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-raised">
      <table className="w-full min-w-[440px] border-collapse">
        <Head showChannel={true} />
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.poolId}
              className="border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40"
            >
              <ModelNameCell row={row} />
              <td className="px-3 py-2">
                <span className="font-mono text-[11px] text-ink-soft">{row.cid}</span>
              </td>
              <MultiplierCell row={row} freePlanCids={freePlanCids} />
              <SizeCell
                value={row.meta?.contextWindow}
                inferred={row.meta?.sources?.contextWindow === "cross"}
              />
              <SizeCell
                value={row.meta?.maxOutputTokens}
                inferred={row.meta?.sources?.maxOutputTokens === "cross"}
              />
              <ThinkingCell row={row} />
              <ModalityCell row={row} />
              <CopyCell row={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
