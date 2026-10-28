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
import { useEffect, useRef, useState } from "react";
import type { PoolAccount } from "../lib/types";
import type { ReactElement } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 账号池卡片的数据形状（直接吃 /api/commands 的宽松 JSON）。
 *
 * 没有 `display`：卡头只显示 cid —— 它就是模型池 id 的前缀，带功能含义；
 * 渠道展示名（CatPaw / Raccoon…）与 cid 是同一条信息的两种拼写，不并排渲染。
 */
export interface AccountPool {
  cid: string;
  index: {
    active: string | null;
    accounts: PoolAccount[] | Array<Record<string, unknown>>;
  };
}

/** 单账号的额度快照（按账号查询）。 */
export interface AccountCredits {
  remain: number;
  size: number;
  used: number;
  unit: string;
  remain_percent: number;
}

/** 渠道账本里的账号条目。 */
export interface AccountBilling {
  key: string;
  ok: number;
  fail: number;
  credits?: AccountCredits | null;
  billing_at?: string | null;
  billing_ok?: boolean;
  /** 额度基线（当前窗口内第一次账单的 remain），用作 100% 分母。 */
  baseline?: { window?: string; date: string; remain: number; at?: string } | null;
}

/** 渠道级账本条（billing action 聚合后的形状）。 */
export interface ChannelBilling {
  used: number;
  unit: string;
  cooling: boolean;
  ok: number;
  fail: number;
  models: number;
  /** 该渠道没有额度概念（后端 capabilities.billing=false）。 */
  unsupported?: boolean;
  /** 按账号拆分的请求计数与额度。 */
  accounts?: AccountBilling[];
  billing_at?: string | null;
  /** 额度周期（渠道声明；null = 没声明，前端用通用说明）。 */
  quota?: QuotaPeriod | null;
}

/** 额度周期（与共享层 `QuotaPeriod` 同形）。 */
export interface QuotaPeriod {
  /** 人读文案，如「每天送 5000 积分，本地 0 点刷新」。 */
  label: string;
  /** 本周期总量；null = 上游不公开。 */
  size: number | null;
  unit: string;
  /** 下次刷新时刻（epoch ms）；null = 未知。 */
  resets_at: number | null;
}

function rowOf(account: PoolAccount | Record<string, unknown>): PoolAccount {
  const row = account as PoolAccount;
  return {
    ...row,
    uid: String(row.uid ?? ""),
    label: String(row.label ?? ""),
    name: String(row.name ?? ""),
    health: String(row.health ?? "unknown"),
    fail_streak: Number(row.fail_streak ?? 0),
  };
}

/**
 * 账号级状态分类（页面总览条与账号行共用同一套判定，避免两处口径漂移）。
 *
 * 状态打在**每个账号**上，不是渠道上 —— 一个渠道池里的账号可能各自不同
 * （既有有钱的也有耗尽的）。判定按「用户要做什么」排序，先命中先返回：
 * - `down`：账号 `health` 是 `error`（连败熔断）/ `unauthorized`（凭据失效），
 *   要人工介入
 * - `broke`：账单查到该账号额度耗尽（`credits.remain <= 0`）—— 要充值/换账号。
 *   排在 `cooldown` 之前：额度没了才是根因，冷却只是它的表现（显示「冷却」会
 *   让人以为等一下就好，实际等不到）
 * - `cooldown`：账号额度冷却，会自愈
 * - `ok`：以上都不是
 */
export type AccountStatus = "ok" | "cooldown" | "down" | "broke";

/**
 * 账号的余额是否已耗尽。
 *
 * 只在**真查到了额度**时才算「没钱」：账单失败（`billing_ok === false`）、
 * 或还没查到 `credits` 都返回 false —— 把「查不到」判成「没钱」会让用户去充
 * 一笔不需要充的钱。
 */
function accountBroke(account: PoolAccount, bill?: AccountBilling | null): boolean {
  if (!bill || bill.billing_ok === false || !bill.credits) return false;
  return Number(bill.credits.remain) <= 0;
}

export function classifyAccount(
  account: PoolAccount | Record<string, unknown>,
  billing?: ChannelBilling,
): AccountStatus {
  const row = rowOf(account);
  if (row.health === "error" || row.health === "unauthorized") return "down";
  if (billing?.unsupported !== true) {
    const bill = (billing?.accounts ?? []).find((b) => b.key === row.key);
    if (accountBroke(row, bill)) return "broke";
  }
  if (row.health === "cooldown") return "cooldown";
  return "ok";
}

/** 健康度圆点：正常=free / 异常=danger / 冷却=warn / 其余=中性。 */
function healthDot(health: string): string {
  if (health === "ok") return "bg-free";
  if (health === "error" || health === "unauthorized") return "bg-danger";
  if (health === "cooldown") return "bg-warn";
  return "bg-ink-faint";
}

/**
 * 账号展示名：**渠道给什么就显示什么**，不做脱敏。
 *
 * 取用顺序：`name`（渠道给的可读标识：nickname / 用户名 / 邮箱 / 手机号）
 * → `label` → `uid` → `key`，取到即原样返回。
 *
 * ⚠ **不做脱敏设计**。前端若把「没有 name」的账号
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
 * 正常态用中性底（DeepSeek 的徽标不铺彩色底）；只有需要人介入的状态才着色。
 */
const STATUS_META: Record<AccountStatus, { text: string; pill: string; dot: string }> = {
  ok: { text: "正常", pill: "bg-overlay text-ink-soft", dot: "bg-free live-dot" },
  cooldown: { text: "冷却", pill: "bg-warn/12 text-warn", dot: "bg-warn" },
  down: { text: "异常", pill: "bg-danger/12 text-danger", dot: "bg-danger" },
  broke: { text: "没钱", pill: "bg-danger/12 text-danger", dot: "bg-danger" },
};

/** 剩余时长（粗粒度）：`45s` / `3m` / `2h`。 */
function shortSpan(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * 状态 pill 文案：**只放短状态**，永远不溢出账号行。
 *
 * 完整原因（如「上游用量限额（所有模型都受限）」）走卡头第二行
 * （`tripDetailOf` + 卡头渲染）—— 那里有整卡宽度，可以换行而不裁切。
 */
function statusPillText(
  status: AccountStatus,
  account: { health: string; trip_until?: string | null; cooldown_until?: string | null },
): string {
  if (account.health === "error" && account.trip_until) {
    const left = Date.parse(account.trip_until) - Date.now();
    return left > 0 ? `熔断 · ${shortSpan(left)}` : "熔断 · 即将试探";
  }
  if (account.health === "cooldown" && account.cooldown_until) {
    const left = Date.parse(account.cooldown_until) - Date.now();
    return left > 0 ? `冷却 · ${shortSpan(left)}` : "冷却 · 即将恢复";
  }
  return STATUS_META[status].text;
}

/**
 * 生效账号的状态详情：原因 + 恢复/试探时刻（卡头第二行用）。
 *
 * 账号行只有 44px 且额度区要先占位，长文本塞不进去 —— 放卡头才有整卡宽度，
 * 可以换行（WEB-CONSOLE 铁律：信息直接可见，不靠 hover、不裁切）。
 */
function tripDetailOf(account: PoolAccount): { label: string; detail: string } | null {
  if (account.health === "cooldown") {
    const until = account.cooldown_until ? Date.parse(account.cooldown_until) : Number.NaN;
    const when = Number.isFinite(until)
      ? ` ${shortSpan(until - Date.now())} 后自动恢复`
      : "";
    return { label: "冷却中", detail: `${account.cooldown_reason ?? "额度耗尽，等上游窗口刷新"}${when}` };
  }
  if (account.health === "error") {
    const until = account.trip_until ? Date.parse(account.trip_until) : Number.NaN;
    const when = Number.isFinite(until)
      ? ` ${shortSpan(until - Date.now())} 后自动放行试探`
      : " 即将自动放行试探";
    const backoff = Number(account.trip_backoff_ms ?? 0);
    const retry = backoff > 0 ? `（退避 ${shortSpan(backoff)}，失败则翻倍）` : "";
    return { label: "熔断中", detail: `连续失败 ${Number(account.fail_streak ?? 0)} 次${retry}${when}` };
  }
  if (account.health === "unauthorized") {
    return { label: "凭据失效", detail: "需要重新登录（自动重试不会成功）" };
  }
  return null;
}

/**
 * 账号卡片的布局铁律：
 *
 * **每张卡固定显示 2 个账号位**，无论是否登录、有无账号 ——
 *   - 未登录 / 0 账号 → 2 个空位占位
 *   - 1 个账号       → 1 个真实账号 + 1 个空位
 *   - 2 个账号       → 2 个真实账号（刚好填满，不折叠）
 *   - > 2 个账号     → 2 个真实账号 + 折叠条（展开剩余 N 个）
 *
 * 这样每张卡的高度完全可预期（卡头 + 2 个账号行 + **恒渲染的卡底条**），
 * 账号多的渠道不再把页面撑参差，空卡也不再矮一截。
 *
 * ⚠ 卡底条不能只在 > 2 个账号时出现：那样多账号的卡比 1-2 个账号的高一整条，
 * 两列并排时卡底参差。不需要折叠时用同高的静态说明占位。
 *
 * demo.ts 只放数据，布局完全由本组件决定 —— 数据里放几个账号都不影响布局规则。
 */
const PREVIEW_ACCOUNTS = 2;

/**
 * 单渠道账号池卡片。
 *
 * 信息层级按「用户一眼要看什么」排：卡头是 cid + 渠道级状态；
 * 账号行以可读昵称/用户名为主，右侧是**该账号**的剩余额度；key 哈希、凭证字段一律不展示。
 *
 * ⚠ 卡头**只显示 cid 一个名字**：cid 同时就是模型池 id 的前缀（`mx model list` 里看到的
 * `catpaw/xxx`），有功能含义；`display`（CatPaw / Raccoon…）只是同一渠道的另一种拼写，
 * 与 cid 并列会把同一信息显示两遍，且把池身份挤成一行里两个等价的徽标。
 */
export function AccountCard({
  pool,
  billing,
  billingLoading = false,
  billingError = false,
  now,
  onActivate,
  onReset,
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
  onActivate: (cid: string, key: string) => void;
  /** 解除连败熔断 / 额度冷却（后端清标记，不动凭证）。 */
  onReset: (cid: string, key: string) => void;
  onRemove: (cid: string, key: string) => void;
  onAdd: (cid: string) => void;
  busyKey: string | null;
}): ReactElement {
  const billingByKey = new Map((billing?.accounts ?? []).map((a) => [a.key, a]));
  // 新鲜度只在渲染时算一次（不挂定时器）：秒数不自己跳，用户刷新页面/数据轮询时才更新
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
    .sort((a, b) => Number(b.key === pool.index.active) - Number(a.key === pool.index.active));
  const activeAccount = accounts.find((a) => a.key === pool.index.active);
  // 生效账号的状态详情（冷却原因 / 熔断退避）—— 卡头第二行用，行内放不下
  const tripDetail = activeAccount ? tripDetailOf(activeAccount) : null;
  const activeTrip = tripDetail
    ? {
        ...tripDetail,
        tone:
          activeAccount?.health === "cooldown"
            ? "text-warn"
            : activeAccount?.health === "unauthorized"
              ? "text-danger"
              : "text-danger",
      }
    : null;
  // 折叠态是卡内私有状态：页面不需要知道哪张卡展开了
  const [expanded, setExpanded] = useState(false);
  // 需要折叠：账号数超过固定位数（2）
  const needsFold = accounts.length > PREVIEW_ACCOUNTS;
  // 展开时显示全部，否则只显示前 2 个（不足 2 个时空位补满）
  const shownAccounts = expanded && needsFold ? accounts : accounts.slice(0, PREVIEW_ACCOUNTS);
  // 空位占位数：不足 2 个真实账号时补空行，让卡高一致
  const emptySlots = needsFold ? 0 : PREVIEW_ACCOUNTS - shownAccounts.length;
  // 折叠条文案：折叠态显示「展开剩余 N 个」
  const hiddenCount = accounts.length - PREVIEW_ACCOUNTS;

  return (
    // `@container`：账号行的额度区按**卡片宽度**（而非视口宽度）决定露出多少
    <div className="panel @container flex flex-col overflow-hidden transition-colors">
      {/* 卡头：cid + 账号数 + 添加按钮（状态在各自的账号行上，渠道不显示状态） */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 font-mono text-[13px] font-medium text-ink">{pool.cid}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
            <span>{`${accounts.length} 个账号`}</span>
            {/* 额度周期（渠道声明；没声明就不显示，避免编造周期） */}
            {billing?.quota?.label && (
              <span className="text-ink-faint/70">· {billing.quota.label}</span>
            )}
          </div>
          {/*
            生效账号的状态详情：原因 + 恢复/试探时刻。
            ⚠ 放卡头而不是账号行 —— 行内只有 44px 且额度区要先占位，长文本会被裁切；
            卡头有整卡宽度，可换行（WEB-CONSOLE 铁律：信息直接可见，不靠 hover）。
            ⚠ **始终占位**（无状态时同高空白）：否则一卡有冷却、一卡正常就差一行，
            auto-fill 网格里同一排卡片高度参差。
          */}
          <div className="mt-1.5 flex min-h-[16px] flex-wrap items-baseline gap-x-2 text-[11px]">
            {activeTrip && (
              <>
                <span className={`font-medium ${activeTrip.tone}`}>{activeTrip.label}</span>
                <span className="text-ink-faint">{activeTrip.detail}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={`为 ${pool.cid} 添加账号`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-50"
          disabled={busyKey !== null}
          onClick={() => onAdd(pool.cid)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/*
        账号列表 —— 固定 2 个账号位：
          - 真实账号超过 2 个 → 显示前 2 + 折叠条
          - 真实账号不足 2 个 → 补空位占位，让每张卡高度一致
          - 0 账号（未登录）→ 2 个空位占位
      */}
      <ul className="border-t border-line">
{shownAccounts.map((account) => {
          const active = account.key === pool.index.active;
          const bill = billingByKey.get(account.key);
          const status = classifyAccount(account, billing);
          const meta = STATUS_META[status];
          const health = account.health;
          const failStreak = Number(account.fail_streak ?? 0);
            /**
             * 被打上标记的状态（连败熔断 / 额度冷却）—— 这两种**可以由用户主动解除**：
             * 熔断后路由会一直跳过它、永远等不到「下一次成功」自己清零；冷却虽会到期自动恢复，
             * 但用户可能已经知道额度刷新了（换套餐 / 充值），不想干等。
             * `unauthorized` 不在此列：凭据本身失效，只能重新登录。
             */
            const tripped = account.health === "error" || account.health === "cooldown";
            return (
              <li
                key={account.key}
                className={`group relative flex h-11 items-center gap-2 border-b border-line/60 px-4 transition-colors last:border-b-0 hover:bg-overlay/40 ${
                  active ? "bg-overlay/25" : ""
                }`}
              >
                {/* 生效账号：左侧高亮条 */}
                {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand" aria-hidden />}
                {/*
                  账号行 = **单行扁平结构**：
                    状态点 + 名称 + 状态 pill + 解除 | 额度（条 / 数字 / 百分比）| 操作
                  行高固定 44px。左上高亮条即「生效中」；状态 pill 是账号级状态
                  （正常 / 冷却 / 异常 / 没钱），不额外显示「生效中」。
                */}
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${healthDot(account.health)}`}
                  aria-label={meta.text}
                />
                {/* 名称区：弹性，超长截断；pill 与解除按钮**不压缩**（它们在 44px 单行里必须完整可见） */}
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">{displayName(account)}</span>
                  <span className={`pill shrink-0 whitespace-nowrap ${meta.pill}`}>{statusPillText(status, account)}</span>
                  {failStreak > 0 && (health === "ok" || health === "unknown") && (
                    <span className="pill shrink-0 bg-warn/12 text-warn">连败 {failStreak}</span>
                  )}
                  {/* 解除：异常/冷却账号的恢复动作，常显（非破坏性，不做二次确认） */}
                  {tripped && (
                    <button
                      type="button"
                      className="shrink-0 rounded border border-warn/40 px-1.5 py-0.5 text-[11px] leading-none text-warn transition-colors hover:bg-warn/12 disabled:opacity-40"
                      disabled={busyKey !== null}
                      onClick={() => onReset(pool.cid, account.key)}
                      aria-label={
                        account.health === "cooldown"
                          ? "解除额度冷却，立刻恢复参与路由"
                          : "解除连败熔断，清零失败计数并恢复参与路由"
                      }
                    >
                      解除
                    </button>
                  )}
                </div>
                {/*
                  额度区：**按卡片宽度逐级露出**（容器查询，不用视口断点 ——
                  同一视口下卡片可能整行、也可能只是两列里的半行）：
                    窄 → 只留数字；中 → + 进度条；宽 → + 百分比。
                  ⚠ 账单还没拿到数据时画骨架条，不画 `-`：
                  「-」与「未查到」看起来像「查过了但没有」，会把等待与失败伪装成结果。 */}
                <div className="flex shrink-0 items-center gap-2">
                  {billingLoading ? (
                    <>
                      <span className="hidden h-1 w-14 animate-pulse rounded-full bg-overlay @min-[380px]:block" />
                      <span className="h-2 w-8 animate-pulse rounded bg-overlay" />
                    </>
                  ) : billingError && !bill?.billing_at ? (
                    <>
                      <span className="font-mono text-[11px] tabular-nums text-warn">—</span>
                      <span className="hidden text-[10px] text-warn @min-[420px]:inline">账单失败</span>
                    </>
                  ) : (
                    <QuotaMeter
                      credits={bill?.credits}
                      baseline={bill?.baseline}
                      unsupported={billing?.unsupported === true}
                    />
                  )}
                </div>
                {/*
                  操作区：固定 52px（切换 + 删除两个图标键）。
                  **默认隐藏，鼠标悬停该账号行才出现**（删除/切换不常使用）；
                  键盘聚焦（`group-focus-within`）时也出现；触屏设备（`pointer-coarse`）常显 ——
                  触屏没有悬停。空位行预留同样的 52px，保证额度区起点一致。
                */}
                <div className="flex w-[52px] shrink-0 items-center justify-end gap-0.5 opacity-100 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100">
                  {!active && (
                    <button
                      className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-brand disabled:opacity-40"
                      disabled={busyKey !== null}
                      onClick={() => onActivate(pool.cid, account.key)}
                      aria-label="切换为生效账号"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-danger/12 hover:text-danger disabled:opacity-40"
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
              </li>
            );
          })}
          {/* 空位占位：真实账号不足 2 个时补空行，让每张卡**与有账号的卡同高**。
              ⚠ 必须与真实账号行**逐列对齐**：同样 `h-11`、同样的额度区与 52px 操作区，
              额度区的响应式断点也必须一致（实测：用百分比宽度时两行起点不同，
              空位占位条与真实进度条对不上，布局不统一）。 */}
          {emptySlots > 0 &&
            Array.from({ length: emptySlots }).map((_, i) => (
              <li
                key={`empty-${i}`}
                className="h-11 border-b border-line/60 px-4 last:border-b-0"
                aria-hidden="true"
              >
                {/* `h-11` 必须在 li 上（与真实行同一层）：放在内层 div 上时
                    li 会多出 1px 下边框，空位行 45px、真实行 44px，卡高差 1px。 */}
                <div className="flex h-full items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-line" />
                  <span className="min-w-0 flex-1" />
                  {/* 额度区：与真实行同一套容器查询断点 */}
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="hidden h-1 w-14 rounded-full bg-line/60 @min-[380px]:block" />
                    <span className="block h-2 w-8 rounded bg-line/60" />
                    <span className="hidden w-9 @min-[460px]:block" />
                  </span>
                  {/* 操作区：固定 52px，占位保持位置 */}
                  <span className="w-[52px] shrink-0" />
                </div>
              </li>
            ))}
        </ul>
      {/* 卡底条：**每张卡恒渲染**，高度固定 ——
          只在 > 2 个账号时出现折叠条的话，多账号的卡比 1-2 个账号的高出一整条，
          两列并排时卡底参差。
          不需要折叠时用同高同底色的静态说明占位，卡高才完全一致。 */}
      {needsFold ? (
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 border-t border-line bg-overlay/30 px-4 py-2.5 text-xs font-medium text-ink-soft transition-colors hover:bg-overlay/60 hover:text-ink"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              收起 <ChevronUp className="h-3.5 w-3.5" />
            </>
          ) : (
            <>
              展开剩余 {hiddenCount} 个账号 <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      ) : (
        <div className="flex w-full items-center justify-center gap-1.5 border-t border-line bg-overlay/30 px-4 py-2.5 text-xs font-medium text-ink-faint">
          {accounts.length === 0 ? "暂无账号" : "已全部显示"}
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
  );
}

/**
 * 额度区：两个带标签的数值 —— **剩余额度**（当前 remain）与**今日消耗**
 * （当日基线 remain − 当前 remain，与旧百分比同口径）。
 *
 * 进度条与百分比已移除：数字本身已是完整信息，条会随窗口刷新跳变反而误导。
 * 消耗算不出（无基线）时显示 `-`，不猜。
 *
 * 耗尽（remain ≤ 0）数值染 danger、紧张（< 10%）染 warn，其余中性 ——
 * 与状态 pill 的「没钱」呼应。
 */
function QuotaMeter({
  credits,
  baseline,
  unsupported,
}: {
  credits: AccountCredits | null | undefined;
  baseline?: { window?: string; date: string; remain: number; at?: string } | null;
  unsupported: boolean;
}): ReactElement {
  const tone = quotaTone(credits, baseline);
  // 订阅制渠道：明确写「无额度概念」，而不是一个孤零零的 `-`
  if (unsupported) {
    return (
      <span className="shrink-0 text-[11px] text-ink-faint/70">
        订阅制
        <span className="hidden @min-[440px]:inline"> · 无额度概念</span>
      </span>
    );
  }
  const valueClass =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink-soft";
  // 今日消耗 = 当日基线 remain − 当前 remain；没有基线就不猜
  let used: number | null = null;
  if (credits && baseline) {
    const base = Number(baseline.remain);
    const remain = Number(credits.remain);
    if (Number.isFinite(base) && Number.isFinite(remain)) used = Math.max(0, base - remain);
  }
  const usedText =
    used === null ? "-" : used.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return (
    <>
      <span className="flex items-center gap-1">
        <span className="text-[10px] text-ink-faint">剩余额度</span>
        <span className={`shrink-0 font-mono text-[11px] tabular-nums ${valueClass}`}>
          {quotaAmount(credits, unsupported)}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <span className="text-[10px] text-ink-faint">今日消耗</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-soft">{usedText}</span>
      </span>
    </>
  );
}
