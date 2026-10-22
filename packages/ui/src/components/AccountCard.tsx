/**
 * 账号池卡片：展示某渠道下的账号列表、额度与切换/新增/删除操作。
 *
 * 数据形状直接吃后端 `/web/api/commands` 的宽松 JSON（见下方 `AccountPool`）。
 */

import { Plus, Trash2, UserCheck } from "lucide-react";
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

/** 健康度圆点：正常=free / 不可用=danger / 其余=中性。 */
function healthDot(health: string): string {
  if (health === "ok") return "bg-free";
  if (health === "unauthorized" || health === "error") return "bg-danger";
  return "bg-ink-faint";
}

/** 健康度文案（空串 = 正常，不出徽标）。 */
function healthText(health: string): string {
  if (health === "error") return "不可用";
  if (health === "unauthorized") return "需登录";
  if (health === "unknown") return "未知";
  return "";
}

/** 健康度徽标配色：错误=danger / 需登录=warn / 未知=中性。 */
function healthBadgeClass(health: string): string {
  if (health === "error") return "bg-danger/12 text-danger";
  if (health === "unauthorized") return "bg-warn/12 text-warn";
  return "bg-overlay text-ink-faint";
}

/** 手机号只露头尾；纯数字 id 标成 UID；其余展示名原样。 */
function displayName(account: PoolAccount): string {
  const label = account.label?.trim() ?? "";
  const raw = label || account.uid?.trim() || "";
  if (/^\d{11}$/.test(raw)) return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
  if (/^\d{7,}$/.test(raw)) return `UID ${raw}`;
  if (raw && raw !== account.key) return raw;
  return `账号 ${account.key.slice(0, 6)}`;
}

function expiryText(expiresAt: number | null): string {
  if (!expiresAt) return "";
  const ms = expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  if (date.getTime() < Date.now()) return "已过期";
  return `到期 ${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 额度百分比：优先后端给的 remain_percent，缺失时按 remain/size 估算。 */
function quotaPercent(credits: AccountCredits | null | undefined): number | null {
  if (!credits) return null;
  const pct = Number(credits.remain_percent);
  if (Number.isFinite(pct) && pct >= 0) return Math.min(100, pct);
  const size = Number(credits.size);
  const remain = Number(credits.remain);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(remain)) {
    return Math.max(0, Math.min(100, (remain / size) * 100));
  }
  return null;
}

/** 额度语义：耗尽=danger / 紧张=warn / 正常=free / 无数据=中性。 */
function quotaTone(credits: AccountCredits | null | undefined): "danger" | "warn" | "free" | "muted" {
  if (!credits) return "muted";
  if (Number(credits.remain) <= 0) return "danger";
  const pct = quotaPercent(credits);
  if (pct !== null && pct > 0 && pct < 10) return "warn";
  return "free";
}

/** 额度文案：剩余值 + 单位；无额度概念或未加载时统一用 -。 */
function quotaText(credits: AccountCredits | null | undefined, unsupported: boolean): string {
  if (unsupported || !credits) return "-";
  return `${credits.remain} ${credits.unit || ""}`.trim();
}

/**
 * 额度新鲜度：网关每 5 分钟后台并行重查一轮（`startBillingRefresher`），
 * 这里把「这条数字多久前查的」显示出来 —— 否则用户看到旧数会以为面板没生效。
 *
 * 阈值与后端一致：>15 分钟算「偏旧」（正常应 ≤5 分钟，留 3 倍容差给慢查询/失败重试）。
 */
function freshnessText(billingAt: string | null | undefined): { text: string; stale: boolean } {
  if (!billingAt) return { text: "未查到", stale: true };
  const at = Date.parse(billingAt);
  if (!Number.isFinite(at)) return { text: "未查到", stale: true };
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return { text: "刚刚更新", stale: false };
  if (mins < 60) return { text: `${mins} 分钟前`, stale: mins > 15 };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { text: `${hours} 小时前`, stale: true };
  return { text: `${Math.floor(hours / 24)} 天前`, stale: true };
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
  const accounts = [...pool.index.accounts]
    .map(rowOf)
    .sort((a, b) => Number(b.key === pool.index.active) - Number(a.key === pool.index.active));
  const activeAccount = accounts.find((a) => a.key === pool.index.active);
  const channelDown = present && activeAccount !== undefined && activeAccount.health !== "ok";
  // 登录状态点：已登录=绿 / 当前账号异常=红 / 未登录=中性灰
  const dotClass = !present ? "bg-ink-faint" : channelDown ? "bg-danger" : "bg-free";
  const dotTitle = !present ? "未登录" : channelDown ? "当前账号不可用" : "已登录";
  const dotText = !present ? "未登录" : channelDown ? "账号不可用" : "已登录";

  return (
    <div className="panel flex flex-col overflow-hidden transition-colors hover:border-line-strong">
      {/* 卡头：状态点 + cid（池 id 前缀，唯一显示的名字）+ 账号数 + 添加按钮 */}
      <div className="flex items-start gap-2.5 border-b border-line bg-canvas/40 px-4 py-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass} ${
            present && !channelDown ? "live-dot" : ""
          }`}
          title={dotTitle}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="pill shrink-0 bg-brand/12 font-mono text-brand">{pool.cid}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className={channelDown ? "text-danger" : "text-ink-faint"}>{dotText}</span>
            <span className="text-ink-faint/50">·</span>
            <span>{accounts.length > 0 ? `${accounts.length} 个账号` : "空池"}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label={`为 ${pool.cid} 添加账号`}
          title="添加账号（走授权流程，成功后自动入池）"
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
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${healthDot(account.health)}`}
                    title={health || "正常"}
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
                        title="切换为生效账号"
                        aria-label="切换为生效账号"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      className="rounded p-1 text-ink-faint transition-colors hover:bg-danger/12 hover:text-danger disabled:opacity-40"
                      disabled={busyKey !== null}
                      onClick={() => onRemove(pool.cid, account.key)}
                      title={active ? "删除生效账号 = 同时登出" : "从池中删除"}
                      aria-label="删除账号"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-3.5">
                  <span className="min-w-0 truncate text-[11px] text-ink-faint">{expiry}</span>
                  {failStreak > 0 && (
                    <span className="shrink-0 text-[11px] text-warn">连续失败 {failStreak} 次</span>
                  )}
                  {/* 额度新鲜度：让「数字是不是旧的」一眼可见（网关每 5 分钟后台重查） */}
                  {(() => {
                    const fresh = freshnessText(bill?.billing_at);
                    return (
                      <span
                        className={`shrink-0 text-[11px] ${fresh.stale ? "text-warn" : "text-ink-faint/70"}`}
                        title={`额度查询时间：${bill?.billing_at ?? "未知"}（网关每 5 分钟自动重查）`}
                      >
                        {fresh.text}
                      </span>
                    );
                  })()}
                  <div className="ml-auto shrink-0">
                    <QuotaMeter
                      credits={bill?.credits}
                      unsupported={billing?.unsupported === true}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 额度计量条：细进度条 + 剩余值 + 百分比。 */
function QuotaMeter({
  credits,
  unsupported,
}: {
  credits: AccountCredits | null | undefined;
  unsupported: boolean;
}): ReactElement {
  const pct = quotaPercent(credits);
  const tone = quotaTone(credits);
  if (unsupported || !credits) {
    return (
      <span
        className="font-mono text-[11px] tabular-nums text-ink-faint"
        title={unsupported ? "该渠道无额度概念" : "额度未加载"}
      >
        {quotaText(credits, unsupported)}
      </span>
    );
  }
  const barClass =
    tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "free" ? "bg-free" : "bg-ink-faint";
  const textClass =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "free" ? "text-free" : "text-ink-soft";
  return (
    <div
      className="flex items-center gap-2"
      title={pct === null ? undefined : `剩余 ${Math.round(pct)}%`}
    >
      <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-canvas">
        <span
          className={`block h-full rounded-full ${barClass}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      <span className={`shrink-0 font-mono text-[11px] tabular-nums ${textClass}`}>
        {quotaText(credits, unsupported)}
      </span>
      {pct !== null && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
