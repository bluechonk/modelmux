/**
 * 账号池卡片：展示某渠道下的账号列表、额度与切换/新增/删除操作。
 * 数据形状直接吃后端 `/web/api/commands` 的宽松 JSON（见下方 `AccountPool`）。
 *
 * 视觉分层（参照 DeepSeek 的列表语言）：卡头 = cid + 渠道级状态 pill + 账号数
 * （异常/冷却只给状态点着色，不铺彩色底）；账号行 = **单行扁平结构**
 * （状态点 + 名称 + 状态 pill + 额度 + 操作，内容保持尽量扁平）；名称
 * **渠道给什么就显示什么**，前端不做脱敏（见 `displayName`）；操作按钮
 * 默认隐藏、悬停账号行才出现，触屏常显。
 */

import { ChevronDown, ChevronUp, Plus, Trash2, UserCheck } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PoolAccount } from "../lib/types";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatRecoveryAt, formatTokens } from "../lib/log-format";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 账号池卡片的数据形状（直接吃 /api/commands 的宽松 JSON）。
 *
 * 没有 `display`：卡头只显示 cid —— 它就是模型池 id 的前缀，带功能含义；
 * 渠道展示名（CatPaw / Raccoon…）与 cid 是同一条信息的两种拼写，不并排渲染。
 */
export interface AccountPool {
  cid: string;
  /** 渠道级签到状态（无签到能力的渠道 `supported=false`，「今日签到」行不渲染）。 */
  signin?: ChannelSignin | null;
  index: {
    active: string | null;
    accounts: PoolAccount[] | Array<Record<string, unknown>>;
  };
}

// 状态判定与账单形状在 lib/account-status（纯逻辑，可被表驱动测试钉死）；
// 这里 import + re-export 保持既有导入路径（Accounts.tsx 从组件取这些名字）。
import {
  classifyAccount,
  rowOf,
  signinRows,
  type AccountBilling,
  type AccountCredits,
  type AccountStatus,
  type ChannelBilling,
  type ChannelSignin,
  type QuotaPeriod,
} from "../lib/account-status";
export {
  classifyAccount,
  rowOf,
  signinRows,
  type AccountBilling,
  type AccountCredits,
  type AccountStatus,
  type ChannelBilling,
  type ChannelSignin,
  type QuotaPeriod,
} from "../lib/account-status";

/**
 * 账号展示名：**渠道给什么就显示什么**，不做脱敏。
 *
 * 取用顺序：`name`（渠道给的可读标识：nickname / 用户名 / 邮箱 / 手机号）
 * → `label` → `uid` → `key`，取到即原样返回。
 *
 * **不做脱敏设计**。前端若把「没有 name」的账号
 * 统一打码（`138****0001`、`UID 100****042`），会让同一页面出现两套口径
 * —— astudio 给的是明文手机号、lobsterai 上游只给
 * 打码手机号，界面上看起来自相矛盾。**要不要脱敏由渠道/上游决定**
 * （拿不到明文就别存），前端不再统一加工。
 */
function displayName(account: PoolAccount): string {
  const name = account.name?.trim() ?? "";
  if (name) return name;
  const label = account.label?.trim() ?? "";
  if (label) return label;
  const uid = account.uid?.trim() ?? "";
  if (uid) return uid;
  return account.key || "（无标识）";
}

/**
 * 额度百分比：**以当前额度窗口内第一次账单为 100% 基线** ——
 * 窗口内消耗多少就掉多少，换窗口自动回到满格。
 *
 * 不做兜底猜测：没有基线、或 remain 不是有限数字时返回 null（不画进度条、不显示百分比）。
 * 退回上游 `remain_percent` 会给出误导性的满格 —— 那是窗口占比，不是当日消耗。
 */
function quotaPercent(
  credits: AccountCredits | null | undefined,
  baseline?: { window?: string; date: string; remain: number; at?: string } | null,
): number | null {
  if (!credits || !baseline) return null;
  const remain = Number(credits.remain);
  const base = Number(baseline.remain);
  if (!Number.isFinite(remain) || !Number.isFinite(base)) return null;
  // 0 基线：耗尽当天显示 0%；若随后回升，后端会在下一轮刷新重设基线。
  if (base <= 0) return remain <= 0 ? 0 : null;
  return Math.max(0, Math.min(100, (remain / base) * 100));
}

/** 额度语义：耗尽=danger / 紧张=warn / 正常=free / 无数据=中性。 */
function quotaTone(
  credits: AccountCredits | null | undefined,
  baseline?: { window?: string; date: string; remain: number; at?: string } | null,
): "danger" | "warn" | "free" | "muted" {
  if (!credits) return "muted";
  if (Number(credits.remain) <= 0) return "danger";
  const pct = quotaPercent(credits, baseline);
  if (pct !== null && pct > 0 && pct < 10) return "warn";
  return "free";
}

/**
 * 额度数字：**只显示数值，不带单位**（积分 / credits 不显示）。
 *
 * 千分位 + 最多 2 位小数（`1095.96` → `1,095.96`，`8.76` → `8.76`，`1932` → `1,932`），
 * 免得长数字把卡片挤爆。
 */
function quotaAmount(credits: AccountCredits | null | undefined, unsupported: boolean): string {
  if (unsupported || !credits) return "-";
  const value = Number(credits.remain);
  if (!Number.isFinite(value)) return "-";
  const fixed = Number.isInteger(value) ? value : Number(value.toFixed(2));
  return fixed.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * 账号级状态 pill 的配色与文案（与 `classifyAccount` 一一对应）。
 *
 * 四个状态全部用语义色：正常绿 / 冷却黄 / 异常与没钱红 —— 「正常」不着色时，
 * 一屏里只有坏消息有颜色，反而要多读一遍文字才知道哪个号是好的。
 */
const STATUS_META: Record<AccountStatus, { text: string; pill: string; dot: string }> = {
  ok: { text: "正常", pill: "bg-free/12 text-free", dot: "bg-free live-dot" },
  cooldown: { text: "冷却", pill: "bg-warn/12 text-warn", dot: "bg-warn" },
  down: { text: "异常", pill: "bg-danger/12 text-danger", dot: "bg-danger" },
  broke: { text: "没钱", pill: "bg-danger/12 text-danger", dot: "bg-danger" },
};

/**
 * 状态 pill 文案：**只有状态词本身**（正常 / 冷却 / 异常 / 没钱）。
 *
 * 冷却剩余时间、熔断退避等具体信息由额度条的悬停面板（`statusNoteOf`）承担 ——
 * 这个 pill 只回答「现在是什么状态」，不掺时间，避免语义混杂。
 */
function statusPillText(status: AccountStatus): string {
  return STATUS_META[status].text;
}

/**
 * 账号的状态说明（详情面板下半段）：只回答「还要等多久 / 要不要人介入」。
 *
 * 行内只留 状态点 + 名称 + 状态 pill + 进度条；冷却倒计时、熔断连败、凭据失效
 * 这类长文案全部收进悬停面板，`null` = 状态正常。
 *
 * 判据必须与 pill 同一套（`classifyAccount` 的 status）—— 只读 `health` 会让
 * 「账单已耗尽但 health 仍是 ok」的账号显示成「额度充足」（2026-11-05 实测出现过）。
 */
function statusNoteOf(
  account: PoolAccount,
  status: AccountStatus,
  /** 当前时刻。由页面的 1s 时钟传入（不传则取当下）—— 倒计时会自己走，不必等数据轮询。 */
  now: number = Date.now(),
): { tone: "warn" | "danger"; lines: string[] } | null {
  if (status === "broke") {
    return { tone: "danger", lines: ["额度已耗尽 · 等待上游窗口刷新"] };
  }
  if (account.health === "cooldown") {
    const until = account.cooldown_until ? Date.parse(account.cooldown_until) : Number.NaN;
    // 只给**具体恢复时刻**（绝对 + 本地时区）：「2h 后」是废话，用户要的是「什么时候能用」
    return {
      tone: "warn",
      lines: [
        Number.isFinite(until)
          ? `冷却中 · ${formatRecoveryAt(until, now)} 恢复`
          : "冷却中 · 等待上游窗口刷新",
      ],
    };
  }
  if (account.health === "error") {
    const until = account.trip_until ? Date.parse(account.trip_until) : Number.NaN;
    return {
      tone: "danger",
      lines: [
        Number.isFinite(until)
          ? `熔断中 · ${formatRecoveryAt(until, now)} 自动试探`
          : "熔断中 · 下次请求自动试探",
      ],
    };
  }
  if (account.health === "unauthorized") {
    return { tone: "danger", lines: ["凭据失效 · 需要重新登录"] };
  }
  return null;
}

/**
 * 账号卡片的布局铁律：**默认只露 1 个账号，卡底条恒渲染**（四态见下）。
 *
 *   - 0 个账号 → 铺**一个空位行**占位 + 卡底「暂无账号」
 *   - 1 个账号 → 1 行 + 卡底「已展示全部」
 *   - N 个账号 → 生效账号 + 卡底「展开剩余 N-1 个账号」；展开后卡底变「收起」
 *
 * 为什么空池也要占一行：账号池是**横向等高**的卡片列，没登录的渠道矮一截，
 * 整片网格就参差（主人要求「必须要保持账号池的账号布局一致」）。
 *
 * 为什么卡底条恒渲染：它是卡片高度的收口（0 / 1 / N 个账号三种卡都把底边压在
 * 同一条线上），同时承担「还有几个没露」与「收起」两个动作。
 *
 * 只露 1 个的理由：渠道池动辄 4-6 个账号，全铺开会把「同屏能看几个渠道」压到 1-2 个，
 * 而账号池页要先回答的是「这个渠道还能不能用」。生效账号恒排首位（见 `sort`），
 * 所以默认露出的那行就是最该看的那个。
 *
 * demo.ts 只放数据，布局完全由本组件决定 —— 数据里放几个账号都不影响布局规则。
 */
const PREVIEW_ACCOUNTS = 1;

/**
 * 单渠道账号池卡片。
 *
 * 信息层级按「用户一眼要看什么」排：卡头是 cid + 渠道级状态；
 * 账号行以可读昵称/用户名为主，右侧是**该账号**的剩余额度；key 哈希、凭证字段一律不展示。
 *
 * 卡头**只显示 cid 一个名字**：cid 同时就是模型池 id 的前缀（`mx model list` 里看到的
 * `catpaw/xxx`），有功能含义；`display`（CatPaw / Raccoon…）只是同一渠道的另一种拼写，
 * 与 cid 并列会把同一信息显示两遍，且把池身份挤成一行里两个等价的徽标。
 */

/** 详情浮层的锚点：触发钮的视口矩形（只用到左边缘与上下缘）。 */
interface PanelAnchor {
  left: number;
  top: number;
  bottom: number;
}

/**
 * 账号详情的悬浮面板：portal 到 `document.body`、按锚点实测定位。
 *
 * 为什么 portal：卡片根节点 `overflow-hidden`，不 portal 的绝对定位浮层会被卡底裁掉
 * （最后一行账号的进度条离卡底只有几像素）。
 * 配色跟面板层级走 —— `bg-overlay` 比卡片（`bg-raised`）高一档，再叠 `line-strong` 描边
 * 与投影；不用近黑：深色主题里近黑浮层像另一个应用，和整套「一级灰差」的层次断开。
 * `ResizeObserver` 兜底换肤 / 文字重排后的重新定位。
 */
function AccountDetailPanel({
  anchor,
  children,
}: {
  anchor: PanelAnchor;
  children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const GAP = 8;
    const EDGE = 8;
    const place = (): void => {
      const r = el.getBoundingClientRect();
      const left = Math.min(anchor.left, Math.max(EDGE, window.innerWidth - r.width - EDGE));
      const below = anchor.bottom + GAP;
      // 翻到触发钮**上方**时按其上缘算，否则浮层会盖住进度条本身
      setPos({
        left,
        top: below + r.height > window.innerHeight - EDGE ? anchor.top - GAP - r.height : below,
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={pos ?? { visibility: "hidden" }}
      className="pointer-events-none fixed z-50 w-[300px] max-w-[86vw] divide-y divide-line rounded-xl border border-line-strong bg-overlay px-3 py-2 text-xs leading-relaxed text-ink shadow-xl"
    >
      {children}
    </div>,
    document.body,
  );
}
export function AccountCard({
  pool,
  billing,
  billingLoading = false,
  billingError = false,
  now,
  tokensOf,
  onActivate,
  onRemove,
  onAdd,
  busyKey,
}: {
  pool: AccountPool;
  billing?: ChannelBilling;
  /** 账单查询还没拿到数据（首次加载 / 缓存被回收）：卡片画骨架，不画「未查到」。 */
  billingLoading?: boolean;
  /** 账单查询失败且没有可用数据：显示可重试的失败态，而不是「未查到」。 */
  billingError?: boolean;
  /** 全局时钟（由页面每秒推一次）：新鲜度文案要随时间走。 */
  now?: number;
  /** 账号 key → 今日 tokens（`usage.accounts[]`）；没有该账号的记录时返回 undefined。 */
  tokensOf?: (key: string) => number | undefined;
  onActivate: (cid: string, key: string) => void;
  onRemove: (cid: string, key: string) => void;
  onAdd: (cid: string) => void;
  busyKey: string | null;
}): ReactElement {
  const billingByKey = new Map((billing?.accounts ?? []).map((a) => [a.key, a]));
  /** 该账号的剩余额度；拿不到（没账单行 / 字段非数）返回 null = 未知，不是 0。 */
  const creditsOf = (key: string): number | null => {
    const remain = billingByKey.get(key)?.credits?.remain;
    return typeof remain === "number" && Number.isFinite(remain) ? remain : null;
  };
  // 倒计时基准：页面每秒喂一个 `now`（数据轮询是 5s 级，靠它跳秒）；缺省取当下。
  const clock = now ?? Date.now();
  // 删除确认：点垃圾桶弹确认框（行内展开会撑高账号行）。
  // 同时只允许一个账号处于待确认态；切换账号/忙碌时清空。
  const [pendingRemove, setPendingRemove] = useState<{
    key: string;
    name: string;
    active: boolean;
  } | null>(null);
  /** 被点的那个垃圾桶 —— 取消确认后焦点要还给它（见 `ConfirmDialog.returnFocusTo`）。 */
  const removeTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (busyKey !== null) setPendingRemove(null);
  }, [busyKey]);
  const accounts = [...pool.index.accounts]
    .map(rowOf)
    .sort((a, b) => {
      // 生效账号恒在首位（它回答的是「现在用的是谁」，与额度无关）
      const byActive = Number(b.key === pool.index.active) - Number(a.key === pool.index.active);
      if (byActive !== 0) return byActive;
      // 其余按**剩余额度降序**：优先把还撑得住的号摆在眼前，快没钱的沉底。
      // 没有额度数据的（订阅制 / 账单还没取到）算「未知」，排在已知额度之后，
      // 同类之间保持后端给的顺序 —— 把未知当 0 会让「没用过」的号看起来像「没钱了」。
      const ra = creditsOf(a.key);
      const rb = creditsOf(b.key);
      if (ra === null && rb === null) return 0;
      if (ra === null) return 1;
      if (rb === null) return -1;
      return rb - ra;
    });
  /**
   * 折叠态：默认只露 `PREVIEW_ACCOUNTS` 个。
   *
   * 状态留在组件里，数据轮询刷新时保持当前开合 —— 正在排查时被下一轮结果折回去很烦。
   */
  const [expanded, setExpanded] = useState(false);
  /**
   * 额度详情浮层：记「锚点 + 哪个账号 + 是否固定」。
   * 悬停/聚焦即显示、移开消失；点击可固定（触屏没有悬停，也给键盘一个明确入口），
   * 点别处或按 Esc 关闭。
   */
  const [detail, setDetail] = useState<{ anchor: PanelAnchor; key: string; pinned: boolean } | null>(null);
  useEffect(() => {
    if (!detail?.pinned) return;
    const onPointerDown = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest("[data-quota-meter]")) return;
      setDetail(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDetail(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [detail?.pinned]);
  /** 没露出来的账号条数（0 = 全露或本来就没得折；空池也归 0，用 `empty` 单独判）。 */
  const hiddenCount = Math.max(0, accounts.length - PREVIEW_ACCOUNTS);
  const needsFold = !expanded && hiddenCount > 0;
  const shownAccounts = needsFold ? accounts.slice(0, PREVIEW_ACCOUNTS) : accounts;
  /** 空池：铺一个空位行占位，卡高与「有 1 个账号」的卡一致（布局一致性要求）。 */
  const empty = accounts.length === 0;
  /** 有可折叠内容且已展开 —— 卡底条的左键这时是「收起」。 */
  const collapsedBack = expanded && hiddenCount > 0;
  /** 悬停面板对应的账号（收起后自然失效，面板随之消失）。 */
  const detailAccount = detail ? shownAccounts.find((a) => a.key === detail.key) : undefined;
  const detailBill = detailAccount ? billingByKey.get(detailAccount.key) : undefined;
  const detailStatus = detailAccount ? classifyAccount(detailAccount, billing) : null;
  const detailNote =
    detailAccount && detailStatus ? statusNoteOf(detailAccount, detailStatus, clock) : null;

  return (
    // 展开**不跨列**：卡片只在自己那一格里长高，同行右侧的渠道保持原位、不被挤到下一行。
    // 早期用 `col-span-full` 独占整行（当时是为了避免同行卡片下方留白），代价是
    // 「展开一个渠道 → 右侧渠道全部下移、本卡占满整行」，整块布局跳一下。
    // 现在仍会有行内留白（`items-start` 只让卡片不被拉伸，**行轨道高度仍由该行最高的卡决定**），
    // 但留白落在网格背景上，比整行重排安静得多 —— 这是刻意接受的取舍。
    <>
    <div className="panel flex flex-col overflow-hidden transition-colors">
      {/* 卡头：cid + 账号数（同一行，紧跟渠道名） + 添加按钮；额度周期另起一行。
          状态在各自的账号行上，渠道不显示状态。 */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="shrink-0 font-mono text-[13px] font-medium text-ink">{pool.cid}</span>
            <span className="shrink-0 text-xs text-ink-faint">{`${accounts.length} 个账号`}</span>
          </div>
          {/* 额度周期：**固定两行高度**，彻底拉平卡头。
              为什么固定两行而不是单行 truncate：渠道声明的文案长短差很大（workbuddyai 的
              「免费档每日 1 亿 token（本地 0 点刷新）· 账单口径为 credits」在 3 列布局下恒占两行，
              其余渠道一行），按内容走就必然参差；单行 truncate 又会把长文案截掉一半。
              固定两行 + `line-clamp-2` 让「长文案显示两行、短文案留白到两行」，
              所有卡卡头同高，信息也不丢（完整文案在额度详情浮层里另有）。
              账单查询失败要**显式说明** —— 留空白会把「接口挂了」显示成「这个渠道没有周期」。 */}
          <div className="mt-1 line-clamp-2 min-h-[2rem] text-xs leading-4 text-ink-faint/70">
            {billingError && billing === undefined ? (
              <span className="text-warn">额度周期未知（账单查询失败）</span>
            ) : billing?.quota?.label?.trim() ? (
              billing.quota.label
            ) : (
              "\u00A0"
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={`为 ${pool.cid} 添加账号`}
          className="tap-square grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-50"
          disabled={busyKey !== null}
          onClick={() => onAdd(pool.cid)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/*
        账号列表：只铺 `shownAccounts`（默认 1 个，口径见上方「账号卡片的布局铁律」）；
        空池铺一个空位行，卡片高度与有账号的卡一致。
        展开态**恒一列**（一行一个账号竖向排开）：两列会把每行压成半宽、账号名与进度条
        互相挤，读序也变成「左右左右」。
      */}
      <ul className="grid border-t border-line">
        {empty && (
          // 空位行：结构与真实账号行同高（单行 44px），内容留空 ——
          // 「暂无账号」由卡底条说明，这里只负责把卡撑到与别的卡一样高。
          // 不加 `border-b`：它是唯一的行，多一条边会让空卡比单账号卡高 1px（实测）。
          <li className="list-none" aria-hidden="true">
            <div className="h-11 px-4 max-md:px-3" />
          </li>
        )}
        {shownAccounts.map((account, index) => {
          const active = account.key === pool.index.active;
          const bill = billingByKey.get(account.key);
          const status = classifyAccount(account, billing);
          const meta = STATUS_META[status];
          const health = account.health;
          const failStreak = Number(account.fail_streak ?? 0);
          // 最后一行不画下边框（否则与卡底条的上边框叠成双线）
          const rowBorder = index >= shownAccounts.length - 1 ? "" : "border-b border-line/60";
          return (
            <li
              key={account.key}
              className={`group relative transition-colors hover:bg-overlay/40 ${rowBorder} ${
                active ? "bg-overlay/25" : ""
              }`}
            >
                {/* 生效账号：左侧高亮条 */}
                {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand" aria-hidden />}
                {/*
                  账号行 = 单行（44px）：
                    状态点 + 名称 + 短状态 pill + 状态标签（倒计时 / 需登录）+ 连败计数 | 额度 | 操作
                */}
                <div className="flex h-11 items-center gap-2 px-4 max-md:gap-1.5 max-md:px-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`}
                    aria-label={meta.text}
                  />
                  {/* 名称区：弹性，超长截断；pill 与操作按钮**不压缩**（它们在 44px 单行里必须完整可见） */}
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                    <span className="min-w-0 truncate text-[13px] font-medium text-ink">{displayName(account)}</span>
                    <span className={`pill shrink-0 whitespace-nowrap ${meta.pill}`}>{statusPillText(status)}</span>
                    {failStreak > 0 && (health === "ok" || health === "unknown") && (
                      <span className="pill shrink-0 bg-warn/12 text-warn">连败 {failStreak}</span>
                    )}
                  </div>
                  {/*
                    额度条：整段可悬停 / 可聚焦 / 可点击固定，详情经 portal 浮层逐行展示
                    （剩余额度 / 今日消耗 / 今日 tokens / 今日首次账单 + 状态原因）。
                    订阅制渠道没有额度概念，直接写文字（不画恒满的条）。
                    账单未到画骨架、失败画「账单失败」—— 都不伪装成「查过了但没数据」。
                  */}
                  {billing?.unsupported === true ? (
                    <span className="shrink-0 text-xs text-ink-faint/70">订阅制 · 无额度概念</span>
                  ) : (
                    <button
                      type="button"
                      data-quota-meter
                      aria-label={`${displayName(account)} 的额度详情`}
                      aria-expanded={detail?.key === account.key}
                      onMouseEnter={(e) => {
                        if (detail?.pinned) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        setDetail({
                          anchor: { left: r.left, top: r.top, bottom: r.bottom },
                          key: account.key,
                          pinned: false,
                        });
                      }}
                      onMouseLeave={() =>
                        setDetail((cur) => (cur?.key === account.key && !cur.pinned ? null : cur))
                      }
                      onFocus={(e) => {
                        if (detail?.pinned) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        setDetail({
                          anchor: { left: r.left, top: r.top, bottom: r.bottom },
                          key: account.key,
                          pinned: false,
                        });
                      }}
                      onBlur={() =>
                        setDetail((cur) => (cur?.key === account.key && !cur.pinned ? null : cur))
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setDetail((cur) =>
                          cur?.key === account.key && cur.pinned
                            ? null
                            : {
                                anchor: { left: r.left, top: r.top, bottom: r.bottom },
                                key: account.key,
                                pinned: true,
                              },
                        );
                      }}
                      className="tap flex w-[22%] min-w-0 shrink-0 items-center gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-overlay/40 md:w-auto md:flex-1 md:max-w-[420px]"
                    >
                      {billingLoading ? (
                        <>
                          <span className="h-1.5 min-w-0 flex-1 animate-pulse rounded-full bg-overlay" />
                          <span className="h-2 w-8 shrink-0 animate-pulse rounded bg-overlay" />
                        </>
                      ) : billingError && !bill?.billing_at ? (
                        <span className="shrink-0 text-xs text-warn">账单失败</span>
                      ) : (
                        <QuotaBar credits={bill?.credits} baseline={bill?.baseline} />
                      )}
                    </button>
                  )}
                  {/*
                    操作区：`≥ md` 固定 52px（切换 + 删除两个图标键）；`< md` 放宽到 92px ——
                    两个键各自撑到 44px 的触控下限后，52px 装不下。
                    **默认隐藏，鼠标悬停该账号行才出现**（删除/切换不常使用）；
                    键盘聚焦（`group-focus-within`）时也出现；触屏设备（`pointer-coarse`）常显 ——
                    触屏没有悬停。
                  */}
                  <div className="flex w-[52px] shrink-0 items-center justify-end gap-0.5 opacity-100 transition-opacity max-md:w-[92px] pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100">
                    {!active && (
                      <button
                        className="tap-square shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-brand disabled:opacity-40"
                        disabled={busyKey !== null}
                        onClick={() => onActivate(pool.cid, account.key)}
                        aria-label="切换为生效账号"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      className="tap-square shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-danger/12 hover:text-danger disabled:opacity-40"
                      disabled={busyKey !== null}
                      onClick={(e) => {
                        // 记下触发键：取消确认时焦点要还到这里（见 ConfirmDialog 注释）
                        removeTriggerRef.current = e.currentTarget;
                        setPendingRemove({ key: account.key, name: displayName(account), active });
                      }}
                      aria-label={active ? "删除生效账号（同时登出）" : "从池中删除"}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                </li>
            );
          })}
        </ul>

      {/*
        卡底条：**恒渲染**，四个状态（口径见上方「账号卡片的布局铁律」）——

          - 空池     → 静态「暂无账号」（空位占位行已把卡撑到同高）
          - 还有隐藏 → 整条可点，「展开剩余 N 个账号」
          - 已展开   → 整条可点，「收起」——动作写在**左下角**（与「展开」同一位置，
                       手不用在卡片里左右找；右下角放个「收起」是错位的）
          - 全露     → 静态「已展示全部」

        恒渲染的理由是卡片高度收口：0 / 1 / N 个账号三种卡都要把底边压在同一条线上，
        整片网格才不参差（主人要求「必须要保持账号池的账号布局一致」）。
      */}
      {empty ? (
        <div className="flex items-center border-t border-line px-4 py-1.5 text-xs text-ink-faint/70">
          暂无账号
        </div>
      ) : hiddenCount > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="tap flex items-center gap-1 border-t border-line px-4 py-1.5 text-xs text-ink-faint transition-colors hover:text-brand"
        >
          {collapsedBack ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          {collapsedBack ? "收起" : `展开剩余 ${hiddenCount} 个账号`}
        </button>
      ) : (
        <div className="flex items-center border-t border-line px-4 py-1.5 text-xs text-ink-faint/70">
          已展示全部
        </div>
      )}

      {/* 删除确认：真删不可逆（生效账号会同时登出），用弹窗把决定隔离出来 */}
      {pendingRemove && (
        <ConfirmDialog
          title="删除账号"
          confirmLabel="删除账号"
          busy={busyKey !== null}
          returnFocusTo={removeTriggerRef.current}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const target = pendingRemove;
            setPendingRemove(null);
            onRemove(pool.cid, target.key);
          }}
          body={
            <>
              将从 <span className="font-mono text-ink">{pool.cid}</span> 的账号池中删除
              <span className="font-medium text-ink"> {pendingRemove.name}</span>。
              {pendingRemove.active && "它是当前生效账号，删除后会同时登出。"}
              该操作不可撤销，需要时可重新登录添加。
            </>
          }
        />
      )}
    </div>
      {/* 额度详情浮层（portal 到 body）：数值逐行 + 状态说明；悬停/聚焦显示、点击固定 */}
      {detail && detailAccount && (
        <AccountDetailPanel anchor={detail.anchor}>
          <dl className="space-y-1 pb-2">
            {[
              ...quotaDetailRows(
                detailBill?.credits,
                detailBill?.baseline,
                billing?.unsupported === true,
                tokensOf?.(detailAccount.key),
                typeof billing?.quota?.size === "number" ? billing.quota.size : null,
              ),
              // 今日签到：渠道没有签到能力时这里是空数组（整行不渲染）
              ...signinRows(pool.signin, detailAccount),
            ].map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-faint">{row.label}</dt>
                <dd className="font-mono tabular-nums text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-0.5 pt-2">
            {detailNote ? (
              detailNote.lines.map((line, index) => (
                <div
                  key={`${index}-${line}`}
                  className={
                    index === 0
                      ? `font-medium ${detailNote.tone === "warn" ? "text-warn" : "text-danger"}`
                      : "text-ink-faint"
                  }
                >
                  {line}
                </div>
              ))
            ) : quotaTone(detailBill?.credits, detailBill?.baseline) === "warn" ? (
              // 剩余不足 10%：还够用但「额度充足」会让人放松警惕
              <div className="text-warn">额度紧张 · 剩余不足 10%</div>
            ) : (
              <div className="text-free">状态正常 · 额度充足</div>
            )}
          </div>
        </AccountDetailPanel>
      )}
    </>
  );
}

/**
 * 额度详情（悬停面板的内容）：全部取上游账单字段 —— 剩余额度、今日消耗、今日 tokens、
 * 今日首次账单（即进度条的 100% 基准）。推不出的显示 `-`，不猜。
 *
 * `windowSize` 是渠道声明的窗口发放量（如 loomy 的每日 5000）：基线只在**首次查询**
 * 时抓取，网关若在签到到账后才启动（典型：重启后补查），抓到的就是已消耗的残余。
 * 此时**不能**把它当「首次账单」展示 —— 那会让读者以为今天的额度本来就只有 201。
 * 判据：基线显著低于窗口发放量 → 标注「错过窗口起点」并给出真实发放量。
 */
function quotaDetailRows(
  credits: AccountCredits | null | undefined,
  baseline: { window?: string; date: string; remain: number; at?: string } | null | undefined,
  unsupported: boolean,
  tokens: number | undefined,
  windowSize?: number | null,
): Array<{ label: string; value: string }> {
  let used: number | null = null;
  if (credits && baseline) {
    const base = Number(baseline.remain);
    const remain = Number(credits.remain);
    if (Number.isFinite(base) && Number.isFinite(remain)) used = Math.max(0, base - remain);
  }
  const fmt = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  // 基线错过窗口起点：抓基线时额度已被消耗（< 声明的 80%，留出签到叠加的余量）
  const missedOrigin =
    baseline != null &&
    typeof windowSize === "number" &&
    windowSize > 0 &&
    Number(baseline.remain) < windowSize * 0.8;
  const firstBill = baseline
    ? missedOrigin
      ? `${fmt(Number(baseline.remain))}（错过窗口起点·窗口发放 ${fmt(windowSize!)}）`
      : fmt(Number(baseline.remain))
    : "-";
  return [
    { label: "剩余额度", value: quotaAmount(credits, unsupported) },
    { label: "今日消耗", value: used === null ? "-" : fmt(used) },
    { label: "今日 tokens", value: tokens === undefined ? "-" : formatTokens(tokens) },
    { label: "今日首次账单", value: firstBill },
  ];
}

/**
 * 额度条：以**今日首次账单**（`baseline.remain`）为 100%，画当前 `remain` 的占比。
 *
 * 行里只留「条 + 百分比」，具体数值全部进悬停面板 —— 四个数值并排会把账号标识挤没，
 * 而「还剩几成」一眼就能读完。订阅制渠道没有额度概念，由调用方写文字（不画恒满的条）。
 */
function QuotaBar({
  credits,
  baseline,
}: {
  credits: AccountCredits | null | undefined;
  baseline?: { window?: string; date: string; remain: number; at?: string } | null;
}): ReactElement {
  const tone = quotaTone(credits, baseline);
  const pct = quotaPercent(credits, baseline);
  const fill =
    tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "free" ? "bg-free" : "bg-line-strong";
  return (
    <>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-overlay">
        <span className={`block h-full rounded-full ${fill}`} style={{ width: `${pct ?? 0}%` }} />
      </span>
      {/*
        百分比在窄卡片上也保留：账号池页首先要回答的是「这个渠道还剩多少」，
        只有一条无刻度的进度条读不出具体数字（`docs/WEB-CONSOLE.md` 的窄屏口径
        本来就是「先保剩余额度数值」）。窄屏压到更窄的字号与宽度把空间挤出来。
      */}
      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-faint md:w-9">
        {pct === null ? "—" : `${Math.round(pct)}%`}
      </span>
    </>
  );
}
