/**
 * 账号池卡片：展示某渠道下的账号列表、额度与切换/新增/删除操作。
 *
 * 数据形状直接吃后端 `/web/api/commands` 的宽松 JSON（见下方 `AccountPool`）。
 */

import { Plus, Trash2, UserCheck } from "lucide-react";
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
  /** 当日基线（当天第一个账单的 remain），用作 100% 分母。 */
  baseline?: { date: string; remain: number } | null;
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
    health: String(row.health ?? "unknown"),
    fail_streak: Number(row.fail_streak ?? 0),
  };
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
 * 账号展示名：**一律脱敏**（手机号 / 纯数字 UID / 邮箱 / 昵称）。
 *
 * 输出形态：`131****9411`（手机号）、`UID 452****126`（纯数字）、`blu****onk`（其余）。
 * 拿不到展示名时用 key 的头 4 位 + `****`，不暴露完整 key。
 */
function displayName(account: PoolAccount): string {
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
 * 额度百分比：**优先以「当天第一个账单」为 100% 基线**（主人 2026-10-23 要求）——
 * 当天消耗多少就掉多少，跨天自动回到满格。
 *
 * 兜底顺序：基线（>0）→ 后端 `remain_percent` → `remain / size`（上游口径不可靠时）。
 */
function quotaPercent(
  credits: AccountCredits | null | undefined,
  baseline?: { date: string; remain: number } | null,
): number | null {
  if (!credits) return null;
  const remain = Number(credits.remain);
  if (baseline && Number.isFinite(baseline.remain) && baseline.remain > 0 && Number.isFinite(remain)) {
    return Math.max(0, Math.min(100, (remain / baseline.remain) * 100));
  }
  const pct = Number(credits.remain_percent);
  if (Number.isFinite(pct) && pct >= 0) return Math.min(100, pct);
  const size = Number(credits.size);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(remain)) {
    return Math.max(0, Math.min(100, (remain / size) * 100));
  }
  return null;
}

/** 额度语义：耗尽=danger / 紧张=warn / 正常=free / 无数据=中性。 */
function quotaTone(
  credits: AccountCredits | null | undefined,
  baseline?: { date: string; remain: number } | null,
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
 * 单渠道账号池卡片。
 *
 * 信息层级按「用户一眼要看什么」排：卡头是 cid + 登录状态点；
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
  onActivate,
  onRemove,
  onAdd,
  busyKey,
}: {
  pool: AccountPool;
  present: boolean;
  billing?: ChannelBilling;
  onActivate: (cid: string, key: string) => void;
  onRemove: (cid: string, key: string) => void;
  onAdd: (cid: string) => void;
  busyKey: string | null;
}): ReactElement {
  const billingByKey = new Map((billing?.accounts ?? []).map((a) => [a.key, a]));
  // 新鲜度只在渲染时算一次（不挂定时器）：秒数不自己跳，用户刷新页面/数据轮询时才更新
  const now = Date.now();
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
  const activeHealth = activeAccount?.health ?? "ok";
  const channelDown = present && activeAccount !== undefined && activeHealth !== "ok";
  // 额度冷却中与真故障分开着色：冷却会自己好（warn），故障要人介入（danger）
  const cooling = present && activeHealth === "cooldown";
  const dotClass = !present
    ? "bg-ink-faint"
    : cooling
      ? "bg-warn"
      : channelDown
        ? "bg-danger"
        : "bg-free";
  const dotTitle = !present ? "未登录" : cooling ? "额度冷却中（等窗口刷新）" : channelDown ? "当前账号不可用" : "已登录";
  const dotText = !present ? "未登录" : cooling ? "冷却中" : channelDown ? "账号不可用" : "已登录";

  return (
    <div className="panel flex flex-col overflow-hidden transition-colors hover:border-line-strong">
      {/* 卡头：状态点 + cid（池 id 前缀，唯一显示的名字）+ 账号数 + 添加按钮 */}
      <div className="flex items-start gap-2.5 border-b border-line bg-canvas/40 px-4 py-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass} ${
            present && !channelDown ? "live-dot" : ""
          }`}
          aria-label={dotTitle}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="pill shrink-0 bg-brand/12 font-mono text-brand">{pool.cid}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className={cooling ? "text-warn" : channelDown ? "text-danger" : "text-ink-faint"}>
              {dotText}
            </span>
            <span className="text-ink-faint/50">·</span>
            <span>{accounts.length > 0 ? `${accounts.length} 个账号` : "空池"}</span>
          </div>
          {/* 额度周期（渠道声明；没声明就不显示，避免编造周期） */}
          {billing?.quota?.label && (
            <div className="mt-0.5 text-[11px] text-ink-faint/70">{billing.quota.label}</div>
          )}
        </div>
        <button
          type="button"
          aria-label={`为 ${pool.cid} 添加账号`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line text-ink-faint transition-colors hover:border-line-strong hover:bg-overlay hover:text-brand disabled:opacity-50"
          disabled={busyKey !== null}
          onClick={() => onAdd(pool.cid)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <div className="text-xs text-ink-faint">还没有账号</div>
          <div className="mt-1 text-[11px] text-ink-faint/70">点右上角 + 添加账号</div>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {accounts.map((account) => {
            const active = account.key === pool.index.active;
            const bill = billingByKey.get(account.key);
            const health = healthText(account.health);
            const expiry = expiryText(account.expires_at);
            const failStreak = Number(account.fail_streak ?? 0);
            return (
              <li
                key={account.key}
                className={`group relative px-4 py-3 transition-colors hover:bg-overlay/40 ${
                  active ? "bg-brand/[0.04]" : ""
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
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {displayName(account)}
                  </span>
                  {active && <span className="pill shrink-0 bg-brand/12 text-brand">生效中</span>}
                  {health && (
                    <span className={`pill shrink-0 ${healthBadgeClass(account.health)}`}>{health}</span>
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

                {/* 第二行：额度条独占整行（单位不显示，只留数值 + 百分比） */}
                <div className="mt-1.5 pl-3.5">
                  <QuotaMeter
                    credits={bill?.credits}
                    baseline={bill?.baseline}
                    unsupported={billing?.unsupported === true}
                  />
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

                {/* 第三行：时间与状态说明 —— 允许换行，绝不裁切 */}
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-3.5 text-[11px] text-ink-faint">
                  {(() => {
                    const fresh = freshnessText(bill?.billing_at, now);
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
    </div>
  );
}

/**
 * 额度计量：进度条**独占整行宽度**（不挤在时间行里被裁切）+ 数值 + 百分比。
 *
 * 数值**不带单位**（积分 / credits 一律不显示，主人 2026-10-23 要求），
 * 长数字用千分位，百分比固定在右侧。
 */
function QuotaMeter({
  credits,
  baseline,
  unsupported,
}: {
  credits: AccountCredits | null | undefined;
  baseline?: { date: string; remain: number } | null;
  unsupported: boolean;
}): ReactElement {
  const pct = quotaPercent(credits, baseline);
  const tone = quotaTone(credits, baseline);
  if (unsupported || !credits) {
    return (
      <span className="font-mono text-[11px] tabular-nums text-ink-faint">
        {quotaAmount(credits, unsupported)}
      </span>
    );
  }
  const barClass =
    tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "free" ? "bg-free" : "bg-ink-faint";
  const textClass =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "free" ? "text-free" : "text-ink-soft";
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
