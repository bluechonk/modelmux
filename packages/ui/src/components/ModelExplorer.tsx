/**
 * 模型区：工具条 + 分组表 / 扁平表。
 *
 * 为什么用**纵向渠道区块**而不是「双列渠道卡」：卡高由内容决定、网格行高取最高，
 * 模型数相差大的渠道并排会被拉出等高空盒；纵向区块的高度 ∝ 模型数，结构上不可能有空洞。
 *
 * 两种视图：**分组**（默认，band 写模型数/免费数/可吃图数/倍率区间，每渠道独立
 * 滚动容器）与**扁平**（按倍率升序一张表，回答「最便宜的在哪」）。行内附
 * 上下文窗口 / 输出上限 / 输入模态（数据共享层 `PoolModelMeta` 本来就有）。
 */

import { ChevronDown, ChevronRight, ChevronUp, Image as ImageIcon, LayoutList, Rows3, Search, Type, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { api } from "../lib/api";
import { useNarrow } from "../lib/use-narrow";
import { CopyButton } from "./CopyChip";
import { ScrollFade } from "./ScrollFade";
import { useToast } from "./Toast";

/**
 * 元数据取值的来源（与共享层 `MetaSource` 同形）。
 *
 * `cross` 是兄弟渠道同 id 的兜底值（不做界面标注），
 * 不是本渠道上游说的，不能让它看起来像事实。
 */
export type MetaSource = "upstream" | "spec" | "web_search" | "cross" | "default";

/** 单个模型的元数据（与共享层 `PoolModelMeta` 对齐）。 */
export interface ModelMeta {  multiplier: number | null;
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

/**
 * 健康度窗口口径与判定在 `lib/model-health.ts`（纯逻辑，表驱动测试钉死）；
 * 这里 import + re-export 保持既有导入路径（页面从组件取这些名字）。
 */
import {
  classifyModel,
  HEALTH_RANGE,
  SLOW_TPS,
  type ModelHealth,
  type ModelVerdict,
} from "../lib/model-health";
export { classifyModel, HEALTH_RANGE, SLOW_TPS, type ModelHealth, type ModelVerdict } from "../lib/model-health";

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
  healthOf,
}: {
  /** 池里的全部模型 id（`<cid>/<模型>`）。 */
  models: string[];
  /** 取模型元数据。 */
  infoOf: (poolId: string) => ModelMeta | undefined;
  /** 无倍率概念（订阅制）的渠道：其模型按「免费」计。 */
  freePlanCids: ReadonlySet<string>;
  /** 取模型健康度（近 7 天的本地请求聚合）；没有行 = 这段窗口里没成功过。 */
  healthOf: (poolId: string) => ModelHealth | undefined;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [cidFilter, setCidFilter] = useState("all");
  const [freeOnly, setFreeOnly] = useState(false);
  const [flat, setFlat] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 组内展开：默认每组只露前 `PREVIEW_COUNT` 个，其余点「展开」才出现。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** 正在 ping 的模型（同时只允许一个：ping 会真花上游请求，别让手快连点打出一串）。 */
  const [pinging, setPinging] = useState<string | null>(null);
  /** 各模型最近一次 ping 的结果（就地留秒数，换模型对比时有用）。 */
  const [pingResults, setPingResults] = useState<ReadonlyMap<string, PingOutcome>>(new Map());
  const toast = useToast();
  /** 窄屏只保留核心列（见 `useNarrow` 的取舍说明）。渠道列只有扁平表有 ——
      分组表由渠道分块，不需要再来一列重复的 cid。 */
  const narrow = useNarrow();
  const cols = colsFor(narrow);
  const groupedCols = cols.filter((c) => c.key !== "channel");

  const toggleExpanded = (cid: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  /**
   * ping 一个模型：真发一次最小 chat 请求，结果同时**弹层 + 就地留秒数**。
   *
   * 失败不抛错到 React Query（这里不用 mutation）：一次 ping 失败不是「页面出错了」，
   * 它就是被测对象的状态，用 toast 说清原因即可。
   */
  const ping = async (poolId: string): Promise<void> => {
    setPinging(poolId);
    try {
      const result = await api.ping(poolId);
      const outcome: PingOutcome = { ok: result.ok, ms: result.ms, error: result.error };
      setPingResults((prev) => new Map(prev).set(poolId, outcome));
      const seconds = (result.ms / 1000).toFixed(1);
      if (result.ok) toast.success(`ping 成功 · ${poolId} · ${seconds}s`);
      else toast.error(`ping 失败 · ${poolId} · ${seconds}s · ${result.error || `HTTP ${result.status}`}`);
    } catch (err) {
      setPingResults((prev) => new Map(prev).set(poolId, { ok: false, ms: 0, error: String(err) }));
      toast.error(`ping 失败 · ${poolId} · ${String(err)}`);
    } finally {
      setPinging(null);
    }
  };

  /**
   * 工具条实测高度 → `--mx-sticky-top`：表头吸顶要让开这一段。
   *
   * 写死像素不行：工具条在窄屏会折行（搜索框、渠道下拉、开关各占一行），高度 50 → 90
   * 都出现过；让表头或工具条任一方猜高度，结果都是重叠或漏出下面滚动的内容。
   */
  const sectionRef = useRef<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = sectionRef.current;
    const bar = toolbarRef.current;
    if (!host || !bar) return;
    const apply = (): void => {
      host.style.setProperty("--mx-sticky-top", `${bar.offsetHeight}px`);
    };
    apply();
    // 折行随宽度变化，`ResizeObserver` 比窗口 resize 事件更贴近事实（字体/缩放也会触发）
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo<ModelRow[]>(() => {    const out: ModelRow[] = [];
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

  const toggle = (cid: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  /**
   * 会折叠的渠道（模型数 > `PREVIEW_COUNT`）：工具条的「全部展开 / 收起」只对它们生效。
   * 数量 ≤ 1 时不给按钮 —— 一个渠道自己的折叠条已经够了。
   */
  const foldableCids = useMemo(
    () => [...groups.entries()].filter(([, list]) => list.length > PREVIEW_COUNT).map(([cid]) => cid),
    [groups],
  );
  const allExpanded = foldableCids.length > 0 && foldableCids.every((cid) => expanded.has(cid));
  /** 有搜索/筛选时表格本来就全展开（见 `previewAll`），此时不给「全部展开」。 */
  const previewAll = keyword !== "" || cidFilter !== "all" || freeOnly;
  const showExpandAll = !flat && !previewAll && foldableCids.length > 1;

  /** 行渲染上下文：健康度 + ping 状态与动作（两张表共用，避免逐层透传七八个参数）。 */
  const cellCtx: CellCtx = {
    freePlanCids,
    healthOf,
    pinging,
    pingResults,
    onPing: (poolId) => void ping(poolId),
  };

  return (
    <section className="mb-2" ref={sectionRef}>
      {/* 工具条吸顶：模型多、表长，滚动时搜索/筛选/计数始终可及（背景铺满容器宽，内容不透出）。
          `pb-4` 而不是 `mb-4`：表头要在工具条正下方吸顶，边距若留在盒外，滚起来会露出
          一条能看见内容的缝；放进盒内后这段背景色不透明，量出来的高度也自动含它。 */}
      <div
        ref={toolbarRef}
        className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-2 bg-canvas px-4 pb-4 pt-2 sm:-mx-6 sm:px-6"
      >
        {/* 工具条不再有「渠道 / 模型」标题（页面标题已说明这一页是什么），
            所以整组控件贴左排 —— 留着 `ml-auto` 会在左边空出一大片。 */}
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
                {cid}（{rows.filter((r) => r.cid === cid).length}）
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setFreeOnly((v) => !v)}
            className={`tap rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
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
              className={`tap-square px-2.5 py-1.5 text-xs transition-colors ${
                flat ? "text-ink-faint hover:text-ink" : "bg-overlay text-ink"
              }`}
              aria-label="按渠道分组"
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setFlat(true)}
              className={`tap-square px-2.5 py-1.5 text-xs transition-colors ${
                flat ? "bg-overlay text-ink" : "text-ink-faint hover:text-ink"
              }`}
              aria-label="全部按倍率排平"
            >
              <Rows3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {showExpandAll && (
            <button
              type="button"
              onClick={() => setExpanded(allExpanded ? new Set() : new Set(foldableCids))}
              className="tap rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              {allExpanded ? "全部收起" : "全部展开"}
            </button>
          )}

          <span className="font-mono text-xs text-ink-faint">
            {previewAll ? `${visible.length} / ${total}` : `${total} 个`}
          </span>
        </div>
      </div>

      {total === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">（无模型：先在账号池页完成渠道授权）</div>
      ) : visible.length === 0 ? (
        <div className="panel p-5 text-sm text-ink-faint">没有匹配的模型</div>
      ) : flat ? (
        <FlatTable cols={cols} rows={visible} ctx={cellCtx} />
      ) : (
        <GroupedTable
          cols={groupedCols}
          groups={groups}
          ctx={cellCtx}
          collapsed={collapsed}
          onToggle={toggle}
          expanded={expanded}
          onToggleExpanded={toggleExpanded}
          previewAll={previewAll}
        />
      )}
    </section>
  );
}

/**
 * 是否免费：倍率 0，或订阅制渠道（无倍率概念）。
 */
function isFree(row: ModelRow, freePlanCids: ReadonlySet<string>): boolean {
  const m = row.meta?.multiplier;
  return m === 0 || (m == null && freePlanCids.has(row.cid));
}

/**
 * 列宽：**全渠道共用同一份**（固定宽度，不随内容变化）。
 *
 * ## 为什么必须固定
 *
 * 每个渠道是独立的 `<table>`（各自横向滚动），而 `table-layout: auto` 会**按内容**算列宽 ——
 * 于是「上下文 1M」那列在 astudio 是 90px、在 catpaw 是 96px，跨渠道完全对不齐
 * （要求「每个 channel 应该都把各字段对齐」）。
 * 固定宽度后所有 `<table>` 的每一列都落在同一像素上。
 *
 * ## 为什么只有一半的列有宽度
 *
 * 表里没写宽度的列（模型 / 思考模式 / 输入）在 `table-layout: fixed` 下**平分剩余宽度**。
 * 只让模型列吃剩余宽度不行：留白会全部堆在模型名与倍率之间 —— 1440 视口实测模型列
 * 810px、最长内容 `longcat-2.0` 约 90px，倍率被推到 x≈890，读一行要横跨半屏；
 * 三列平分后模型列 353px、倍率右边界前移到 417，留白摊成三段均匀间隔。
 * 被平分的三列都是文字列，多出来的宽度不会像数字列那样把「右对齐」拉散。
 *
 * 宽度含单元格内边距（`px-3` = 12px×2），故比内容宽。
 */
const COL_WIDTHS = {
  channel: "4.5rem",
  multiplier: "4rem",
  avgTps: "6rem",
  contextWindow: "6rem",
  maxOutput: "5.5rem",
  ping: "5.5rem",
  copy: "2.75rem",
} as const;

/**
 * 表格最小宽度（表头 / 每个渠道表体 / 扁平表**必须共用同一个值**，否则列会错位）。
 *
 * `≥ md` 取 640px：固定列合计 292px（`≥ md` 的列集），最小宽只给 440 时，视口刚好落在
 * `md` 断点上（实测 768×1024：面板内容区 544px）模型列会被挤成 0px ——
 * 留 640 保证三列平分列（含模型列）恒有约 110px，放不下就横向滚动（右缘渐隐提示它）。
 *
 * `< md` 取 300px：只露「模型 / 倍率 / 复制」三列，440px 会把模型列白白挤出约 90px 的
 * 滚动量，降到 300px 让这三列在 360 宽的视口里一次看全（模型列实测 390 视口 190px）。
 */
const TABLE_MIN_W = "min-w-[300px] md:min-w-[640px]";

/**
 * 分组视图的列定义（列宽 + 对齐 + 窄屏是否保留）。
 *
 * 表头与每个渠道的表体**共用这一份**，改列只需改这里。
 */
interface ColDef {
  /** 有固定宽度的列取 `COL_WIDTHS` 的键；其余（模型 / 思考模式 / 输入）平分剩余宽度。 */
  key: keyof typeof COL_WIDTHS | "model" | "effort" | "modality";
  label: string;
  align: "left" | "right";
  /** `< md` 丢弃（取舍说明见 `useNarrow`）。 */
  wide?: boolean;
}

const COLS: ColDef[] = [
  { key: "model", label: "模型", align: "left" },
  { key: "channel", label: "渠道", align: "left" },
  { key: "multiplier", label: "倍率", align: "right" },
  { key: "avgTps", label: "平均 TPS", align: "right", wide: true },
  { key: "contextWindow", label: "最大上下文", align: "right", wide: true },
  { key: "maxOutput", label: "输出上限", align: "right", wide: true },
  { key: "effort", label: "思考模式", align: "left", wide: true },
  {
    key: "modality",
    label: "输入",
    align: "left",
    // `< md` 也丢弃：手机上固定宽列挤掉的正是模型列的宽度 ——
    // 实测（390 视口）模型名会被压到只剩 3 个字符（`lon…`），核心信息不可读。
    wide: true,
  },
  // ping 不做 `wide`：它是**动作**，窄屏更需要它（手机上没法复制去别处测）
  { key: "ping", label: "", align: "left" },
  { key: "copy", label: "", align: "left" },
];

/** 当前视口该保留的列（宽屏一份不丢）。 */
function colsFor(narrow: boolean): ColDef[] {
  return narrow ? COLS.filter((col) => !col.wide) : COLS;
}

/**
 * 共享列宽声明：表头与每个渠道的表体都渲染它，保证列落在同一像素。
 *
 * 必须用 `table-fixed` + `<colgroup>` —— 只在 CSS 里写宽度、不在 `<table>` 上
 * 声明 `table-layout: fixed` 是无效的（`<table>` 默认 `auto`）。
 *
 * `<col>` 的数量与顺序**完全等于传入的 `cols`**（与表体的 `<td>` 同源）——
 * 少一列就少一个槽位，不留任何「列头没了、内容还在」的缝。
 */
function ColGroup({ cols }: { cols: readonly ColDef[] }): ReactElement {
  return (
    <colgroup>
      {cols.map((c) => {
        // 没在 `COL_WIDTHS` 里的列（模型 / 思考模式 / 输入）不给宽度：
        // `table-fixed` 下它们平分剩余宽度，理由见 `COL_WIDTHS` 的文件内说明。
        const width = COL_WIDTHS[c.key as keyof typeof COL_WIDTHS];
        return <col key={c.key} style={width ? { width } : undefined} />;
      })}
    </colgroup>
  );
}

/** 表头：**整个模型区只渲染一次**，在最上方一行。
 *
 * 表头若每组各带一份（`GroupedTable` 里每组一个 `<thead>`），
 * 一屏会看到 10 份重复的列名。提到最上方后渠道块只剩数据行。
 * 列名与列宽都来自同一份 `cols` / `COL_WIDTHS`，与表体同源。
 */
function Head({ cols }: { cols: readonly ColDef[] }): ReactElement {
  return (
    <thead className="bg-canvas/30">
      <tr className="border-b border-line/70 text-xs text-ink-faint">
        {cols.map((c) => (
          <th
            key={c.key}
            scope="col"
            className={[
              // 左右内边距与表体一致（模型列 px-4，其余 px-3），否则列名会贴着数字
              "whitespace-nowrap py-2 font-normal",
              c.key === "model" ? "px-4" : "px-3",
              c.align === "right" ? "text-right" : "text-left",
            ].join(" ")}
          >
            {c.label}
          </th>
        ))}
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
        <span className="font-mono text-xs text-free">免费</span>
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

/**
 * 输入模态单元格：纯图标 —— 文本用 `Type`（T 字形）、图片用 `Image`，
 * 能看图时 `T + 图`（列头已说明这列是输入能力，图标本身即语义，不再写文字）。
 *
 * `< md` 该列由 `colsFor` 直接丢弃（连 `<td>` 都不渲染），这里不带任何响应式类。
 */
function ModalityCell({ row }: { row: ModelRow }): ReactElement {
  const modes = row.meta?.inputModalities ?? [];
  const vision = modes.includes("image");
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
 * 不能给「不支持」的模型编档位：共享层若给所有模型都填 `["low","high"]`，
 * 200 个没声明过的模型都会被显示成「支持 low/high」。
 * 现在 `meta.effort` 为 null 就是「渠道没说」，如实呈现；
 * 来源标记（sources）随数据下发，当前表格不展示。
 *
 * 窄屏（< md）整列由 `colsFor` 丢弃，这里不再带响应式类。
 */
function ThinkingCell({ row }: { row: ModelRow }): ReactElement {
  const effort = row.meta?.effort ?? null;
  if (effort === null || effort.supportedLevels.length === 0) {
    return (
      <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-faint">
        不支持
      </td>
    );
  }
  const levels = sortThinkingLevels(effort.supportedLevels).map(
    (level) => THINKING_LEVEL_LABELS[level.toLowerCase()] ?? level,
  );
  return (
    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-soft">
      {levels.join(" / ")}
    </td>
  );
}

/**
 * 模型名单元格：等宽字体，超长截断（全名可用旁边的复制按钮取）；后面挂健康度标签。
 *
 * 标签挂在**名字旁边**而不是单开一列：一行里最先被读到的就是模型名，
 * 判断「这个模型现在能不能用」跟名字是同一个动作。
 */
function ModelNameCell({
  row,
  verdict,
}: {
  row: ModelRow;
  verdict: ModelVerdict;
}): ReactElement {
  const pill = verdict.status === null ? null : VERDICT_PILL[verdict.status];
  return (
    <td className="max-w-[22rem] px-4 py-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-xs text-ink">{row.id}</span>
        {pill && <span className={`pill shrink-0 whitespace-nowrap ${pill.cls}`}>{pill.text}</span>}
      </span>
    </td>
  );
}

/**
 * 平均 TPS 单元格：只显示数值，窗口见页面副标题（近 7 天）。
 *
 * `-` 的两种含义都在 `classifyModel` 里定死了：没有成功记录、或成功请求算不出速率
 * （只有一个内容帧 / 上游没回 usage）。不写 0 —— 0 是「跑得极慢」而不是「测不到」。
 */
function TpsCell({ verdict }: { verdict: ModelVerdict }): ReactElement {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular text-ink-soft">
      {verdict.tps === null ? "-" : verdict.tps.toFixed(verdict.tps >= 100 ? 0 : 1)}
    </td>
  );
}

/**
 * ping 按钮单元格：点一下真发一次最小 chat 请求，结果用浮层报出，并把秒数留在原地。
 *
 * 就地留秒数（不只是弹一下）：弹层几秒就没了，而「刚才那次是多少秒」往往正是接下来
 * 要拿来对比的数 —— 留在格子里，换一个模型 ping 之后还能横向比。
 */
function PingCell({
  row,
  pending,
  result,
  onPing,
}: {
  row: ModelRow;
  pending: boolean;
  result: PingOutcome | undefined;
  onPing: (poolId: string) => void;
}): ReactElement {
  return (
    <td className="px-2 py-1.5 max-md:px-0">
      <span className="flex items-center justify-end gap-1.5">
        {result && (
          <span
            className={`font-mono text-xs tabular ${result.ok ? "text-free" : "text-danger"}`}
          >
            {result.ok ? `${(result.ms / 1000).toFixed(1)}s` : "失败"}
          </span>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => onPing(row.poolId)}
          aria-label={`ping ${row.poolId}`}
          className="tap-square shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-brand disabled:opacity-40"
        >
          <Zap className={`h-3.5 w-3.5 ${pending ? "animate-pulse text-brand" : ""}`} />
        </button>
      </span>
    </td>
  );
}

/** 窗口/上限单元格。 */
function SizeCell({
  value,
}: {
  value: number | undefined;
}): ReactElement {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft">
      {value ? compactNumber(value) : "—"}
    </td>
  );
}

/** 复制按钮单元格。`< md` 去掉左右内边距，44px 的按钮正好落在 44px 的列里。 */
function CopyCell({ row }: { row: ModelRow }): ReactElement {
  return (
    <td className="px-2 py-1.5 text-right max-md:px-0">
      <CopyButton value={row.poolId} label={`复制 ${row.poolId}`} />
    </td>
  );
}

/**
 * 按列定义渲染一行的单元格。
 *
 * 单元格的数量与顺序由**同一份 `cols`** 决定（`ColGroup` 也吃它），
 * 所以「列头与内容错位」在结构上不可能发生 —— 这是上面 `useNarrow` 换掉
 * `hidden md:table-cell` 的全部意义。
 */
function cellsOf(
  row: ModelRow,
  cols: readonly ColDef[],
  ctx: CellCtx,
): ReactElement[] {
  return cols.map((col) => {
    switch (col.key) {
      case "model":
        return (
          <ModelNameCell key={col.key} row={row} verdict={classifyModel(ctx.healthOf(row.poolId))} />
        );
      case "channel":
        return (
          <td key={col.key} className="px-3 py-2">
            <span className="font-mono text-xs text-ink-soft">{row.cid}</span>
          </td>
        );
      case "multiplier":
        return <MultiplierCell key={col.key} row={row} freePlanCids={ctx.freePlanCids} />;
      case "avgTps":
        return <TpsCell key={col.key} verdict={classifyModel(ctx.healthOf(row.poolId))} />;
      case "ping":
        return (
          <PingCell
            key={col.key}
            row={row}
            pending={ctx.pinging === row.poolId}
            result={ctx.pingResults.get(row.poolId)}
            onPing={ctx.onPing}
          />
        );
      case "contextWindow":
        return <SizeCell key={col.key} value={row.meta?.contextWindow} />;
      case "maxOutput":
        return <SizeCell key={col.key} value={row.meta?.maxOutputTokens} />;
      case "effort":
        return <ThinkingCell key={col.key} row={row} />;
      case "modality":
        return <ModalityCell key={col.key} row={row} />;
      default:
        return <CopyCell key={col.key} row={row} />;
    }
  });
}

/**
 * 一次 ping 的结果（`PingResult` 的界面侧裁剪）。
 *
 * `error` 保留原文：失败原因（额度不足 / 上游 502 / 超时）界面上要原样说，不自编。
 */
export interface PingOutcome {
  ok: boolean;
  ms: number;
  error: string;
}

/** 渲染一行单元格要的外部上下文：免得到处透传七八个参数。 */
interface CellCtx {
  freePlanCids: ReadonlySet<string>;
  /** 模型健康度（近 7 天聚合）；没有行 = 这段时间一次都没成功过。 */
  healthOf: (poolId: string) => ModelHealth | undefined;
  /** 正在 ping 的模型（按钮转圈 + 禁用）。 */
  pinging: string | null;
  /** 已经 ping 过的结果，按池 id 存。 */
  pingResults: ReadonlyMap<string, PingOutcome>;
  onPing: (poolId: string) => void;
}

/**
 * 横向滚动同步：表头与各表体是**各自独立的滚动容器**（滑块应该每个渠道都有），
 * 任一容器横向滚动都要带着其余的走，否则列名与内容错位。
 *
 * 用 `register(key)` 生成回调 ref、`onScroll(from)` 广播位置；在 `requestAnimationFrame`
 * 里解锁，避免「A 改 B、B 又改 A」的来回抖动。
 */
function useScrollSync(): {
  register: (key: string) => (el: HTMLDivElement | null) => void;
  onScroll: (from: HTMLDivElement) => void;
} {
  const els = useRef(new Map<string, HTMLDivElement>());
  const syncing = useRef(false);
  const register = (key: string) => (el: HTMLDivElement | null) => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };
  const onScroll = (from: HTMLDivElement): void => {
    if (syncing.current) return;
    syncing.current = true;
    const left = from.scrollLeft;
    for (const el of els.current.values()) {
      if (el !== from && el.scrollLeft !== left) el.scrollLeft = left;
    }
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };
  return { register, onScroll };
}

/**
 * 分组表：**表头一份在最上方** + 每个渠道一个表块（band 行 + 模型行），全宽、不并排。
 *
 * ## 表头为什么只渲染一次
 *
 * 每组自带 `<thead>` 的话，一屏能看到 10 份一模一样的列名。
 * 列名提到最上方一行，渠道块只剩数据行。
 *
 * ## 表头为什么吸顶
 *
 * 十个渠道块合计两千多像素，表头只挂在最上方的话，滚到第 5 个渠道时列名早已离开
 * 视口（实测 `scrollTop=1470` 时表头 `top=-1236`），而表体里全是 `1M` / `131k` /
 * `低 / 中 / 超高` 这类**离开列名就不可判读**的裸值。故表头在工具条下方吸顶：
 * 让位的距离由工具条自己量（窄屏会折行，高度不是常量，见 `--mx-sticky-top`）。
 *
 * ## 列为什么能跨渠道对齐
 *
 * 每组是**独立的滚动容器**（整表只有一个底部滑块时，得滚到页面最下方才够得着，
 * 而且一动就带着所有渠道一起滚 —— 滑块应该每个 channel 都有）。
 * 独立滚动容器 + `table-layout: auto` 会按内容算列宽 → 跨渠道对不齐，
 * 所以每组都渲染**同一份固定宽度 `<colgroup>`**（见 `COL_WIDTHS`）。
 *
 * ## 表头与表体的横向滚动同步
 *
 * 表头不在任何一组的滚动容器里，但它必须跟着滚 —— 否则横向滚过的那组，
 * 列名与内容会错位。故表头自己也放在 `overflow-x-auto` 里，
 * 并由 `GroupedTable` 把任意一组的 `scrollLeft` 同步过去（双向）。
 */
function GroupedTable({
  cols,
  groups,
  ctx,
  collapsed,
  onToggle,
  expanded,
  onToggleExpanded,
  previewAll,
}: {
  cols: readonly ColDef[];
  groups: Map<string, ModelRow[]>;
  ctx: CellCtx;
  collapsed: ReadonlySet<string>;
  onToggle: (cid: string) => void;
  /** 组内「已展开全部」的渠道集合。 */
  expanded: ReadonlySet<string>;
  onToggleExpanded: (cid: string) => void;
  /** 有搜索/筛选时直接全展开：用户已经在缩小范围，再藏模型会挡住他要找的。 */
  previewAll: boolean;
}): ReactElement {
  const { register, onScroll } = useScrollSync();

  return (
    // `overflow-clip` 而不是 `overflow-hidden`：`hidden` 会把自己变成滚动容器，
    // 表头的 `sticky` 会被它困住（相对一个永不滚动的滚动口 = 永不吸顶）。
    // `clip` 只裁剪不建滚动容器，圆角收边与吸顶两件事都保住。
    <div className="overflow-clip rounded-2xl border border-line bg-raised">
      {/* 表头：整个模型区只此一份，横向与各渠道表体同步。
          吸顶的 `top` 由工具条实测高度给出（`--mx-sticky-top`）：工具条窄屏会折行，
          高度不是常量，写死会与它重叠或留缝。 */}
      <div
        className="sticky z-10 rounded-t-2xl bg-raised"
        style={{ top: "var(--mx-sticky-top, 0px)" }}
      >
        <ScrollFade
          containerRef={register("header")}
          onScroll={onScroll}
          className="overflow-x-auto"
        >
          <table className={`w-full ${TABLE_MIN_W} table-fixed border-collapse`}>
            <ColGroup cols={cols} />
            <Head cols={cols} />
          </table>
        </ScrollFade>
      </div>

      {[...groups.entries()].map(([cid, rows]) => {
        const isCollapsed = collapsed.has(cid);
        // 默认每组只露前 3 个：一个渠道几十个模型会把整页撑爆（见文件头布局说明）
        const showAll = previewAll || expanded.has(cid);
        const shown = showAll ? rows : rows.slice(0, PREVIEW_COUNT);
        const hidden = rows.length - shown.length;
        const free = rows.filter((r) => isFree(r, ctx.freePlanCids)).length;
        const vision = rows.filter((r) => (r.meta?.inputModalities ?? []).includes("image")).length;
        const mults = rows
          .map((r) => r.meta?.multiplier)
          .filter((m): m is number => m != null && m > 0);
        return (
          <div key={cid} className="border-b border-line last:border-b-0">
            {/* band：渠道名 + 计数 + 倍率区间 + 折叠键（不随表格横向滚动） */}
            <div className="flex items-center gap-2.5 bg-canvas/50 px-4 py-2.5">
              <button
                type="button"
                onClick={() => onToggle(cid)}
                className="tap-square grid h-5 w-5 place-items-center rounded text-ink-faint transition-colors hover:text-ink"
                aria-label={isCollapsed ? `展开 ${cid}` : `折叠 ${cid}`}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              <span className="font-mono text-[13px] font-medium text-ink">{cid}</span>
              <span className="text-xs text-ink-faint">{rows.length} 个模型</span>
              {free > 0 && <span className="text-xs text-free">{free} 个免费</span>}
              {/* 可吃图数在窄屏收起：44px 的折叠键 + 模型数 + 免费数已经把这一行占满，
                  再放一条会把 band 顶出面板宽度（实测 360 视口溢出 2px）。 */}
              {vision > 0 && (
                <span className="hidden text-xs text-ink-faint md:inline">{vision} 个可吃图</span>
              )}
              {mults.length > 0 && (
                <span className="ml-auto font-mono text-xs text-ink-faint">
                  ×{formatMultiplier(Math.min(...mults))}–×{formatMultiplier(Math.max(...mults))}
                </span>
              )}
            </div>
            {!isCollapsed && (
              <ScrollFade
                containerRef={register(`${cid}-body`)}
                onScroll={onScroll}
                className="overflow-x-auto"
              >
                <table className={`w-full ${TABLE_MIN_W} table-fixed border-collapse`}>
                  <ColGroup cols={cols} />
                  <tbody>
                    {shown.map((row) => (
                      <tr
                        key={row.poolId}
                        className="border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40"
                      >
                        {cellsOf(row, cols, ctx)}
                      </tr>
                    ))}
                    {/* 折叠条：**整行可点**（与账号卡底条同一套做法）—— 只让文字可点的话，
                        可点区域只有约 110px，整行剩下的一千多像素是死区，用户点行内空白没反应。 */}
                    {(hidden > 0 || (!previewAll && expanded.has(cid) && rows.length > PREVIEW_COUNT)) && (
                      <tr className="border-b border-line/40 last:border-b-0">
                        <td colSpan={cols.length} className="p-0">
                          <button
                            type="button"
                            onClick={() => onToggleExpanded(cid)}
                            className="tap flex w-full items-center justify-between gap-2 px-4 py-1.5 text-xs text-ink-faint transition-colors hover:text-brand"
                            aria-expanded={showAll}
                          >
                            <span className="inline-flex items-center gap-1">
                              {hidden > 0 ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronUp className="h-3.5 w-3.5" />
                              )}
                              {hidden > 0 ? `展开剩余 ${hidden} 个模型` : "已全部显示"}
                            </span>
                            {hidden === 0 && <span className="shrink-0 text-ink-soft">收起</span>}
                          </button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </ScrollFade>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 扁平表：全部模型按倍率升序，渠道作为一列。表头同样吸顶（做法与 `GroupedTable` 一致）。 */
function FlatTable({
  cols,
  rows,
  ctx,
}: {
  cols: readonly ColDef[];
  rows: ModelRow[];
  ctx: CellCtx;
}): ReactElement {
  const { register, onScroll } = useScrollSync();
  return (
    <div className="overflow-clip rounded-2xl border border-line bg-raised">
      <div
        className="sticky z-10 rounded-t-2xl bg-raised"
        style={{ top: "var(--mx-sticky-top, 0px)" }}
      >
        <ScrollFade containerRef={register("header")} onScroll={onScroll} className="overflow-x-auto">
          <table className={`w-full ${TABLE_MIN_W} table-fixed border-collapse`}>
            <ColGroup cols={cols} />
            <Head cols={cols} />
          </table>
        </ScrollFade>
      </div>
      <ScrollFade containerRef={register("body")} onScroll={onScroll} className="overflow-x-auto">
        <table className={`w-full ${TABLE_MIN_W} table-fixed border-collapse`}>
          <ColGroup cols={cols} />
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.poolId}
                className="border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40"
              >
                {cellsOf(row, cols, ctx)}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollFade>
    </div>
  );
}
