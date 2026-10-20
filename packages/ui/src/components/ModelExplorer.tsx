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

/** 单个模型的元数据（与共享层 `PoolModelMeta` 对齐）。 */
export interface ModelMeta {
  multiplier: number | null;
  marketing: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
}

/** 倍率格式化：最多 4 位小数并去掉尾随 0。 */
export function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(4)));
}

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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">
          <Rows3 className="h-4 w-4 text-brand" />
          可用模型
          <span className="text-xs font-normal text-ink-faint">渠道/模型</span>
        </h2>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型或渠道…"
              className="w-52 rounded-lg border border-line bg-raised py-1.5 pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint focus:border-brand/50 focus:outline-none"
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
            className="rounded-lg border border-line bg-raised px-2 py-1.5 text-xs text-ink-soft focus:border-brand/50 focus:outline-none"
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
              title="按渠道分组"
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setFlat(true)}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                flat ? "bg-overlay text-ink" : "text-ink-faint hover:text-ink"
              }`}
              title="全部按倍率排平"
            >
              <Rows3 className="h-3.5 w-3.5" />
            </button>
          </div>

          <span className="text-[11px] text-ink-faint">
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
    <thead className="sticky top-0 z-10 bg-raised/95 backdrop-blur">
      <tr className="border-b border-line text-[11px] text-ink-faint">
        <th className="px-4 py-2 text-left font-normal">模型</th>
        {showChannel && <th className="px-3 py-2 text-left font-normal">渠道</th>}
        <th className="px-3 py-2 text-right font-normal">倍率</th>
        <th className="hidden px-3 py-2 text-right font-normal lg:table-cell">上下文</th>
        <th className="hidden px-3 py-2 text-right font-normal lg:table-cell">输出上限</th>
        <th className="px-3 py-2 text-left font-normal">输入</th>
        <th className="w-10 px-2 py-2" />
      </tr>
    </thead>
  );
}

/** 倍率单元格：免费档用绿色徽标，其余用等宽数字。 */
function MultiplierCell({ row, freePlanCids }: { row: ModelRow; freePlanCids: ReadonlySet<string> }): ReactElement {
  const m = row.meta?.multiplier ?? null;
  const freePlan = freePlanCids.has(row.cid);
  if (m === 0 || (m == null && freePlan)) {
    return (
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <span className="pill bg-free/12 font-mono text-free" title={m === 0 ? "零消耗" : "订阅制，无额外计费"}>
          免费
        </span>
      </td>
    );
  }
  if (m == null) {
    return <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-faint">—</td>;
  }
  return (
    <td
      className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft"
      title={`消耗倍率 ×${formatMultiplier(m)}`}
    >
      ×{formatMultiplier(m)}
    </td>
  );
}

/** 输入模态单元格：能吃图才给徽标，纯文本留白。 */
function ModalityCell({ row }: { row: ModelRow }): ReactElement {
  const modes = row.meta?.inputModalities ?? [];
  const vision = modes.includes("image");
  if (!vision) {
    return <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-faint">文本</td>;
  }
  return (
    <td className="whitespace-nowrap px-3 py-2">
      <span className="pill bg-brand/12 text-brand" title={`输入模态：${modes.join(" / ")}`}>
        <ImageIcon className="h-3 w-3" />
        文本+图
      </span>
    </td>
  );
}

/** 模型名单元格：等宽字体，超长截断（悬停看全名）。 */
function ModelNameCell({ row }: { row: ModelRow }): ReactElement {
  return (
    <td className="max-w-[22rem] truncate px-4 py-2 font-mono text-xs text-ink" title={row.id}>
      {row.id}
    </td>
  );
}

/** 窗口/上限单元格。 */
function SizeCell({ value }: { value: number | undefined }): ReactElement {
  return (
    <td className="hidden whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-ink-soft lg:table-cell">
      {value ? compactNumber(value) : "—"}
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
}: {
  groups: Map<string, ModelRow[]>;
  freePlanCids: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (cid: string) => void;
}): ReactElement {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-raised">
      <table className="w-full border-collapse">
        <Head showChannel={false} />
        {[...groups.entries()].map(([cid, rows]) => {
          const isCollapsed = collapsed.has(cid);
          const free = rows.filter((r) => isFree(r, freePlanCids)).length;
          const vision = rows.filter((r) => (r.meta?.inputModalities ?? []).includes("image")).length;
          const mults = rows
            .map((r) => r.meta?.multiplier)
            .filter((m): m is number => m != null && m > 0);
          return (
            <tbody key={cid}>
              <tr>
                <th colSpan={7} scope="rowgroup" className="border-b border-line bg-canvas/60 text-left">
                  <div className="flex items-center gap-2.5 px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => onToggle(cid)}
                      className="grid h-5 w-5 place-items-center rounded text-ink-faint transition-colors hover:text-ink"
                      aria-label={isCollapsed ? `展开 ${cid}` : `折叠 ${cid}`}
                    >
                      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <span className="pill bg-brand/12 font-mono text-brand">{cid}</span>
                    <span className="text-[11px] text-ink-faint">{rows.length} 个模型</span>
                    {free > 0 && <span className="pill bg-free/12 text-free">{free} 个免费</span>}
                    {vision > 0 && <span className="pill bg-overlay text-ink-soft">{vision} 个可吃图</span>}
                    {mults.length > 0 && (
                      <span className="ml-auto text-[11px] text-ink-faint">
                        倍率 ×{formatMultiplier(Math.min(...mults))}–×{formatMultiplier(Math.max(...mults))}
                      </span>
                    )}
                  </div>
                </th>
              </tr>
              {!isCollapsed &&
                rows.map((row) => (
                  <tr
                    key={row.poolId}
                    className="border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40"
                  >
                    <ModelNameCell row={row} />
                    <MultiplierCell row={row} freePlanCids={freePlanCids} />
                    <SizeCell value={row.meta?.contextWindow} />
                    <SizeCell value={row.meta?.maxOutputTokens} />
                    <ModalityCell row={row} />
                    <CopyCell row={row} />
                  </tr>
                ))}
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
    <div className="overflow-hidden rounded-2xl border border-line bg-raised">
      <table className="w-full border-collapse">
        <Head showChannel={true} />
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.poolId}
              className="border-b border-line/40 transition-colors last:border-b-0 hover:bg-overlay/40"
            >
              <ModelNameCell row={row} />
              <td className="px-3 py-2">
                <span className="pill bg-brand/12 font-mono text-brand">{row.cid}</span>
              </td>
              <MultiplierCell row={row} freePlanCids={freePlanCids} />
              <SizeCell value={row.meta?.contextWindow} />
              <SizeCell value={row.meta?.maxOutputTokens} />
              <ModalityCell row={row} />
              <CopyCell row={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
