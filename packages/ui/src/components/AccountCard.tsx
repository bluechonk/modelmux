import { Plus, Trash2, UserCheck } from "lucide-react";
import type { PoolAccount } from "../lib/types";
import type { ReactElement } from "react";

/** 账号池卡片的数据形状（直接吃 /api/commands 的宽松 JSON）。 */
export interface AccountPool {
  cid: string;
  display?: string;
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

/** 健康度圆点颜色：ok 绿 / unauthorized、error 红 / 其他灰。 */
function healthDot(health: string): string {
  if (health === "ok") return "bg-green-400";
  if (health === "unauthorized" || health === "error") return "bg-red-500";
  return "bg-gray-600";
}

function healthText(health: string): string {
  if (health === "error") return "不可用";
  if (health === "unauthorized") return "需登录";
  if (health === "unknown") return "未知";
  return "";
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

function quotaText(accountBilling: AccountBilling | undefined, unsupported: boolean): string {
  if (unsupported) return "-";
  if (accountBilling?.credits) {
    const { remain, unit } = accountBilling.credits;
    return `${remain} ${unit || ""}`.trim();
  }
  // 额度未拿到（未加载 / 查询失败 / 无账本条）统一以 - 表示
  return "-";
}

function quotaClass(accountBilling: AccountBilling | undefined): string {
  const credits = accountBilling?.credits;
  if (!credits) return "text-gray-500";
  if (credits.remain <= 0) return "text-red-400";
  if (credits.remain_percent > 0 && credits.remain_percent < 10) return "text-amber-300";
  return "text-emerald-300";
}

/**
 * 单渠道账号池卡片。
 *
 * 信息层级按「用户一眼要看什么」排：渠道只显示小写 cid；账号行以可读昵称/用户名为主，
 * 右侧是**该账号**的剩余额度；key 哈希、凭证字段、渠道展示名一律不展示。
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
  const dotClass = !present ? "bg-gray-600" : channelDown ? "bg-red-500" : "bg-green-400";
  const dotTitle = !present ? "未登录" : channelDown ? "当前账号不可用" : "已登录";

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-900 transition-colors hover:border-gray-700">
      {/* 卡头：cid + 登录状态 + 账号数 + 添加按钮 */}
      <div className="flex items-center gap-2 border-b border-gray-800/70 bg-gray-950/40 px-4 py-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} title={dotTitle} />
        <span className="font-mono text-sm font-semibold text-gray-100">{pool.cid}</span>
        <span className="text-xs text-gray-500">
          {accounts.length > 0 ? `${accounts.length} 个账号` : "空池"}
        </span>
        <button
          type="button"
          aria-label={`为 ${pool.cid} 添加账号`}
          title="添加账号（走授权流程，成功后自动入池）"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-50"
          disabled={busyKey !== null}
          onClick={() => onAdd(pool.cid)}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-600">
          点右上角 + 添加账号
        </div>
      ) : (
        <ul className="divide-y divide-gray-800/60">
          {accounts.map((account) => {
            const active = account.key === pool.index.active;
            const bill = billingByKey.get(account.key);
            const health = healthText(account.health);
            const expiry = expiryText(account.expires_at);
            return (
              <li
                key={account.key}
                className={`group relative px-4 py-2.5 transition-colors hover:bg-gray-800/30 ${
                  active ? "bg-sky-500/[0.06]" : ""
                }`}
              >
                {/* 生效账号：左侧高亮条 */}
                {active && (
                  <span className="absolute inset-y-0 left-0 w-0.5 bg-sky-400" aria-hidden />
                )}
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${healthDot(account.health)}`}
                    title={health || "正常"}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">
                    {displayName(account)}
                  </span>
                  {/* 生效账号的高亮由左侧色条与背景区分，无需"当前"文字标记 */}
                  {health && (
                    <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
                      {health}
                    </span>
                  )}
                  <span className={`shrink-0 font-mono text-sm tabular-nums ${quotaClass(bill)}`}>
                    {quotaText(bill, billing?.unsupported === true)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-gray-500">
                  <span className="min-w-0 truncate">{expiry}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {!active && (
                      <button
                        className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-sky-300 disabled:opacity-40"
                        disabled={busyKey !== null}
                        onClick={() => onActivate(pool.cid, account.key)}
                        title="切换为生效账号"
                        aria-label="切换为生效账号"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      className="rounded p-1 text-gray-500 transition-colors hover:bg-red-950/60 hover:text-red-300 disabled:opacity-40"
                      disabled={busyKey !== null}
                      onClick={() => onRemove(pool.cid, account.key)}
                      title={active ? "删除生效账号 = 同时登出" : "从池中删除"}
                      aria-label="删除账号"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

    </div>
  );
}
