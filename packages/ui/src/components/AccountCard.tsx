/**
 * 账号池卡片：展示某渠道下的账号列表、额度与切换/新增/删除操作。
 *
 * 数据形状直接吃后端 `/web/api/commands` 的宽松 JSON（见下方 `AccountPool`）。
 *
 * 视觉分层（参照 DeepSeek 的列表语言）：
 * - 卡头：cid（池 id 前缀，唯一显示的名字）+ 渠道级状态 pill + 账号数；
 *   异常/冷却只给状态点与文字着色，不给整卡铺彩色底（DeepSeek 不用彩色面板）。
 * - 账号行：名称为主、脱敏 UID 退到次行（避免同行互截）；额度条独立一行；
 *   新鲜度/到期/失败次数收在最次行。
 */

import { ChevronDown, ChevronUp, Plus, Trash2, UserCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { PoolAccount } from "../lib/types";
import type { ReactElement } from "react";

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
 * 渠道级状态分类（页面总览条与卡片共用同一套判定，避免两处口径漂移）：
 * - `ok`：已登录且生效账号正常
 * - `cooldown`：生效账号额度冷却（会自己好，warn）
 * - `down`：已登录但生效账号故障/需登录（要人介入，danger）
 * - `offline`：凭据不存在（未登录）
 * - `empty`：已登录但池里没有账号
 */
export type ChannelStatus = "ok" | "cooldown" | "down" | "offline" | "empty";

export function classifyChannel(pool: AccountPool, present: boolean): ChannelStatus {
  if (!present) return "offline";
  const accounts = [...pool.index.accounts].map(rowOf);
  if (accounts.length === 0) return "empty";
  const active = accounts.find((a) => a.key === pool.index.active);
  const health = active?.health ?? "ok";
  if (health === "cooldown") return "cooldown";
  if (health === "error" || health === "unauthorized") return "down";
  return "ok";
}

/** 健康度圆点：正常=free / 不可用=danger / 冷却=warn / 其余=中性。 */
function healthDot(health: string): string {
  if (health === "ok") return "bg-free";
  if (health === "error" || health === "unauthorized") return "bg-danger";
  if (health === "cooldown") return "bg-warn";
  return "bg-ink-faint";
}

/** 健康度文案（空串 = 正常，不出徽标）。 */
function healthText(health: string): string {
  if (health === "error") return "不可用";
  if (health === "cooldown") return "冷却中";
  if (health === "unauthorized") return "需登录";
  if (health === "unknown") return "未知";
  return "";
}

/** 健康度徽标配色：错误=danger / 冷却=warn / 需登录=warn / 未知=中性。 */
function healthBadgeClass(health: string): string {
  if (health === "error") return "bg-danger/12 text-danger";
  if (health === "cooldown" || health === "unauthorized") return "bg-warn/12 text-warn";
  return "bg-overlay text-ink-faint";
}

/** 冷却截止时刻（`MM-DD HH:mm`）；解析不出来给空串。 */
function cooldownUntilText(until: string | null | undefined): string {
  if (!until) return "";
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 账号标识**脱敏**：保留头尾、中间统一换成 `****`（主人 2026-10-23 要求）。
 *
 * 页面上不出现任何完整账号 id / 昵称 / 邮箱 —— 看板可能被投屏、截图分享。
 * 头尾长度按总长比例取（短串也至少留 1 头 1 尾），保证同池两账号还能区分开。
 */
function maskMiddle(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";
  if (text.length <= 2) return `${text.slice(0, 1)}****`;
  if (text.length <= 6) return `${text.slice(0, 1)}****${text.slice(-1)}`;
  const head = Math.min(4, Math.max(2, Math.floor(text.length * 0.3)));
  const tail = Math.min(3, Math.max(1, Math.floor(text.length * 0.2)));
  return `${text.slice(0, head)}****${text.slice(-tail)}`;
}

/**
 * 账号展示名：**有名称就显示名称，没有才脱敏 id**。
 *
 * `account.name` 是渠道给的可读名称（nickname / 用户名 / 邮箱 / 手机号），直接展示
 * 才能区分同渠道的多个账号；`label` 可能退化成 uid / key，那种泛化值按标识脱敏
 * （手机号 / 纯数字 UID / 邮箱 / key）。
 *
 * 输出形态：`demo-user`（名称）、`138****0001`（手机号）、`UID 100****042`（纯数字）、
 * `账号 acc****1234`（key 兜底）。
 */
function displayName(account: PoolAccount): string {
  const name = account.name?.trim() ?? "";
  if (name) return name;
  const label = account.label?.trim() ?? "";
  const raw = label || account.uid?.trim() || "";
  if (raw === "") return `账号 ${maskMiddle(account.key)}`;
  if (/^\d{11}$/.test(raw)) return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
  if (/^\d{7,}$/.test(raw)) return `UID ${maskMiddle(raw)}`;
  const at = raw.indexOf("@");
  if (at > 0) {
    // 邮箱：本地部分脱敏 + 保留域名（域名不是账号标识）
    return `${maskMiddle(raw.slice(0, at))}${raw.slice(at)}`;
  }
  if (raw === account.key) return `账号 ${maskMiddle(raw)}`;
  return maskMiddle(raw);
}

function expiryText(expiresAt: number | null): string {
  if (!expiresAt) return "";
  const ms = expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  if (date.getTime() < Date.now()) return "已过期";
  return `到期 ${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 额度百分比：**以当前额度窗口内第一次账单为 100% 基线**（主人 2026-10-24 确认）——
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
 * 额度数字：**只显示数值，不带单位**（主人 2026-10-23 要求：积分 / credits 不显示）。
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
 * 额度新鲜度：网关每 3 分钟后台并行重查一轮（`startBillingRefresher`），
 * 这里把「这条数字距现在多久」**精确**显示出来 —— 「刚刚更新 / N 分钟前」这种模糊说法
 * 看不出到底多久没刷了。零值单位不显示（`0天5小时` 只写 `5小时`），秒恒显示。
 *
 * 阈值与后端一致：>15 分钟算「偏旧」（正常应 ≤3 分钟，留 5 倍容差给慢查询/失败重试）。
 */
function freshnessText(
  billingAt: string | null | undefined,
  now: number,
): { text: string; stale: boolean } {
  if (!billingAt) return { text: "未查到", stale: true };
  const at = Date.parse(billingAt);
  if (!Number.isFinite(at)) return { text: "未查到", stale: true };
  const totalSeconds = Math.max(0, Math.floor((now - at) / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // 只印「最高非零单位 → 秒」这一段，避免出现「0天0小时0分钟30秒前」这种噪声；
  // 分钟为 0 且天/时也为 0 时也跳过（就只剩 `30秒前`）。
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0 || days > 0) parts.push(`${hours}小时`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}分钟`);
  parts.push(`${seconds}秒`);
  return {
    text: `更新于 ${parts.join("")}前`,
    stale: totalSeconds > 15 * 60,
  };
}

/**
 * 渠道级状态 pill 的配色与文案（与 `classifyChannel` 一一对应）。
 *
 * 正常态用中性底（DeepSeek 的徽标不铺彩色底）；只有需要人介入的异常才着色。
 */
const STATUS_META: Record<ChannelStatus, { text: string; pill: string; dot: string }> = {
  ok: { text: "已登录", pill: "bg-overlay text-ink-soft", dot: "bg-free live-dot" },
  cooldown: { text: "冷却中", pill: "bg-warn/12 text-warn", dot: "bg-warn" },
  down: { text: "账号不可用", pill: "bg-danger/12 text-danger", dot: "bg-danger" },
  offline: { text: "未登录", pill: "bg-overlay text-ink-faint", dot: "bg-ink-faint" },
  empty: { text: "空池", pill: "bg-overlay text-ink-faint", dot: "bg-ink-faint" },
};

/**
 * 卡内默认露出的账号数，其余折进「展开剩余 N 个账号」。
 *
 * 卡片高度因此有上界（卡头 + 4 行 + 折叠条），网格不会被账号多的渠道撑爆；
 * 生效账号恒排首位（见下方 sort），永远不会被折掉。
 */
const PREVIEW_ACCOUNTS = 4;

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
  present,
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
  present: boolean;
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
  // 删除二次确认：点了垃圾桶先进入「确认中」状态，再点一次才真删（主人 2026-10-23 要求）。
  // 同时只允许一个账号处于确认态；切换账号/忙碌时清空。
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  useEffect(() => {
    if (busyKey !== null) setConfirmKey(null);
  }, [busyKey]);
  const accounts = [...pool.index.accounts]
    .map(rowOf)
    .sort((a, b) => Number(b.key === pool.index.active) - Number(a.key === pool.index.active));
  const activeAccount = accounts.find((a) => a.key === pool.index.active);
  // 折叠态是卡内私有状态：页面不需要知道哪张卡展开了
  const [expanded, setExpanded] = useState(false);
  const visibleAccounts = expanded ? accounts : accounts.slice(0, PREVIEW_ACCOUNTS);
  const hiddenAccounts = accounts.length - visibleAccounts.length;

  const status = classifyChannel(pool, present);
  const meta = STATUS_META[status];
  // 异常/冷却只提亮描边，不铺彩色底 —— DeepSeek 的面板一律中性，语义靠点与文字
  const cardClass =
    status === "down"
      ? "border-danger/30 hover:border-danger/50"
      : status === "cooldown"
        ? "border-warn/25 hover:border-warn/45"
        : "border-line hover:border-line-strong";

  return (
    <div className={`panel flex flex-col overflow-hidden transition-colors ${cardClass}`}>
      {/* 卡头：状态点 + cid + 渠道状态 pill + 账号数 + 添加按钮 */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`}
          aria-label={meta.text}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 font-mono text-[13px] font-medium text-ink">{pool.cid}</span>
            <span className={`pill shrink-0 ${meta.pill}`}>{meta.text}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
            <span>{accounts.length > 0 ? `${accounts.length} 个账号` : "空池"}</span>
            {/* 额度周期（渠道声明；没声明就不显示，避免编造周期） */}
            {billing?.quota?.label && (
              <span className="text-ink-faint/70">· {billing.quota.label}</span>
            )}
            {/* 生效账号连续失败：提到卡头，不埋进行内弱色文字 */}
            {activeAccount && Number(activeAccount.fail_streak ?? 0) > 0 && (
              <span className="text-warn">· 连续失败 {Number(activeAccount.fail_streak)} 次</span>
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

      {accounts.length === 0 ? (
        <div className="border-t border-line px-4 py-8 text-center">
          <div className="text-xs text-ink-faint">还没有账号</div>
          <div className="mt-1 text-[11px] text-ink-faint/70">点右上角 + 添加账号</div>
        </div>
      ) : (
        <ul className="border-t border-line">
          {visibleAccounts.map((account) => {
            const active = account.key === pool.index.active;
            const bill = billingByKey.get(account.key);
            const health = healthText(account.health);
            const expiry = expiryText(account.expires_at);
            const failStreak = Number(account.fail_streak ?? 0);
            const showUid = Boolean(account.name?.trim() && account.uid?.trim());
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
                className={`group relative border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-overlay/40 ${
                  active ? "bg-overlay/25" : ""
                }`}
              >
                {/* 生效账号：左侧高亮条 */}
                {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand" aria-hidden />}
                {/* 第一行：脱敏账号名 + 状态徽标（动作按钮 hover 出现） */}
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${healthDot(account.health)}`}
                    aria-label={health || "正常"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex h-[22px] items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {displayName(account)}
                      </span>
                      {active && <span className="pill shrink-0 bg-overlay text-ink-soft">生效中</span>}
                      {health && (
                        <span className={`pill shrink-0 ${healthBadgeClass(account.health)}`}>{health}</span>
                      )}
                    </div>
                    {/* UID 退到次行：不与名称同行互截；**恒渲染**（无 UID 时空占位）——
                        账号行高度不随「有没有标识次行」漂移（布局统一，2026-10-25 主人要求）。
                        固定 16px 行盒 + 6px 上间距：中文名字形下缘低，紧贴会看成与下一行叠字。 */}
                    <div className="mt-1.5 h-4 truncate text-[11px] leading-4 text-ink-faint">
                      {showUid ? `UID ${maskMiddle(account.uid)}` : ""}
                    </div>
                  </div>
                  {/* 解除：异常/冷却账号的**常显**动作 —— 不藏在 hover 里（触屏与键盘拿不到），
                      也不做二次确认（非破坏性：清了标记账号只是重新参与路由）。 */}
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
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {!active && (
                      <button
                        className="rounded p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-brand disabled:opacity-40"
                        disabled={busyKey !== null}
                        onClick={() => onActivate(pool.cid, account.key)}
                        aria-label="切换为生效账号"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      className="rounded p-1 text-ink-faint transition-colors hover:bg-danger/12 hover:text-danger disabled:opacity-40"
                      disabled={busyKey !== null}
                      onClick={() => setConfirmKey(account.key)}
                      aria-label={active ? "删除生效账号（同时登出）" : "从池中删除"}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>

                {/* 第三行：额度条独占整行。
                    **固定高度**：额度条有两种渲染分支 —— 正常分支返回块级 flex 行，
                    「无额度概念」渠道（capabilities.billing=false，如 orcaterm）返回
                    裸行内 span，行盒会更高（实测 24px vs 17px），导致账号块高度不一致、
                    卡片网格参差。统一成固定高度的 flex 行，两个分支同高。

                    ⚠ 账单**还没拿到数据**（加载中 / 失败且无可用数据）时画骨架条，
                    不画 `-` —— 「-」与「未查到」看起来像「查过了但没有」，会把等待与
                    失败伪装成结果（主人 2026-10-24 反馈）。 */}
                <div className="mt-1.5 flex h-[17px] items-center pl-3.5">
                  {billingLoading || (billingError && !bill?.billing_at) ? (
                    <span className="h-1 w-2/5 animate-pulse rounded-full bg-overlay" />
                  ) : (
                    <QuotaMeter
                      credits={bill?.credits}
                      baseline={bill?.baseline}
                      unsupported={billing?.unsupported === true}
                    />
                  )}
                </div>

                {/* 删除二次确认：真删是不可逆的（生效账号会同时登出），先问一次 */}
                {confirmKey === account.key && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/8 px-2 py-1.5 pl-2.5">
                    <span className="text-[11px] text-danger">
                      {active ? "删除生效账号将同时登出，确认？" : "确认删除该账号？"}
                    </span>
                    <button
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() => {
                        setConfirmKey(null);
                        onRemove(pool.cid, account.key);
                      }}
                      className="rounded bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmKey(null)}
                      className="rounded px-2 py-0.5 text-[11px] text-ink-faint transition-colors hover:text-ink"
                    >
                      取消
                    </button>
                  </div>
                )}

                {/* 第四行：时间与状态说明 —— 允许换行，绝不裁切；min-h 兜住空行
                    （订阅制渠道此行全空时也保持行高）。偶发换两行由同行等高卡吸收。
                    账单还没到 / 请求失败时**不写「未查到」**：那是等待态，不是结果。 */}
                <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 pl-3.5 text-[11px] text-ink-faint">
                  {(() => {
                    // 没有额度概念的渠道（`capabilities.billing=false`，如 orcaterm 订阅制）
                    // 不显示账单新鲜度：它永远不会刷新，只会一直累加「更新于 N 天前」，
                    // 看起来像故障（2026-10-24 主人反馈）。
                    if (billing?.unsupported === true) return null;
                    // 账单查询还没数据：画骨架（第三行与第二行同宽度的短条）
                    if (billingLoading) {
                      return <span className="h-2 w-1/3 animate-pulse rounded bg-overlay" />;
                    }
                    // 账单查询失败且没有可用数据：如实说失败，由下一次轮询自动重试
                    if (billingError && !bill?.billing_at) {
                      return <span className="text-warn">账单获取失败，稍后自动重试</span>;
                    }
                    const fresh = freshnessText(bill?.billing_at, clock);
                    return (
                      <span className={fresh.stale ? "text-warn" : "text-ink-faint/70"}>
                        {fresh.text}
                      </span>
                    );
                  })()}
                  {expiry !== "" && <span className="text-ink-faint/60">· {expiry}</span>}
                  {failStreak > 0 && <span className="text-warn">· 连续失败 {failStreak} 次</span>}
                  {/* 冷却中：把「等到什么时候」直接写出来（额度耗尽不是故障，会自己好） */}
                  {account.health === "cooldown" && cooldownUntilText(account.cooldown_until) !== "" && (
                    <span className="text-warn">
                      · 冷却到 {cooldownUntilText(account.cooldown_until)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {/* 折叠条：账号数超过预览上限时出现（点击展开，不用 hover —— 触屏/键盘也要能到达） */}
      {accounts.length > PREVIEW_ACCOUNTS && (
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 border-t border-line px-4 py-2 text-[11px] text-ink-faint transition-colors hover:bg-overlay/40 hover:text-ink"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {hiddenAccounts > 0 ? (
            <>
              展开剩余 {hiddenAccounts} 个账号 <ChevronDown className="h-3 w-3" />
            </>
          ) : (
            <>
              收起 <ChevronUp className="h-3 w-3" />
            </>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * 额度计量：进度条**独占整行宽度**（不挤在时间行里被裁切）+ 数值 + 百分比。
 *
 * 数值**不带单位**（积分 / credits 一律不显示，主人 2026-10-23 要求），
 * 长数字用千分位，百分比固定在右侧。
 *
 * 进度条底色用 `bg-canvas`（比卡片更暗），填充色只在紧张/耗尽时着色 ——
 * 正常额度是中性灰，避免整屏绿条抢视线。
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
  const pct = quotaPercent(credits, baseline);
  const tone = quotaTone(credits, baseline);
  // 订阅制渠道：明确写「无额度概念」，而不是一个孤零零的 `-`
  if (unsupported) {
    return <span className="text-[11px] text-ink-faint/70">订阅制 · 无额度概念</span>;
  }
  // 没有基线 / 数值不可用：只显示数额，不画进度条也不显示百分比（不猜 100%）
  if (!credits || pct === null) {
    return (
      <span className="font-mono text-[11px] tabular-nums text-ink-faint">
        {quotaAmount(credits, unsupported)}
      </span>
    );
  }
  // 正常额度用中性灰条：只有紧张（warn）与耗尽（danger）才着色
  const barClass =
    tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : "bg-ink-faint";
  const textClass =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink-soft";
  return (
    <div className="flex w-full items-center gap-2">
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">
        <span
          className={`block h-full rounded-full ${barClass}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      <span className={`shrink-0 font-mono text-[11px] tabular-nums ${textClass}`}>
        {quotaAmount(credits, unsupported)}
      </span>
      {pct !== null && (
        <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-faint">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
