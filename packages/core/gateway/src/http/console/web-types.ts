/** Web 层专用数据形状（`/api/commands` 的请求与响应、渠道池快照视图）。 */

export interface WebCommandBody {
  action: string;
  cid?: string;
  args?: Record<string, unknown>;
}

export interface WebCommandResult {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

export interface WebChannelStatus {
  cid: string;
  display: string;
  present: boolean;
}

/** 把 `PoolIndex` 转换成 Web 展示形态（独立于 account-cli.ts 的 render）。 */
export function renderChannelPool(
  cid: string,
  display: string,
  index: {
    version: 1;
    active: string | null;
    accounts: Array<{
      key: string;
      label: string;
      name?: string;
      uid: string;
      health: string;
      expires_at: number | null;
      fail_streak?: number;
      cooldown_until?: string | null;
      cooldown_reason?: string;
    }>;
  },
): Record<string, unknown> {
  return {
    cid,
    display,
    index: {
      version: index.version,
      active: index.active,
      accounts: index.accounts.map((a) => ({
        key: a.key,
        label: a.label,
        // 名称类字段：Web 有名字就显示名字，没有才退回脱敏 id
        name: a.name ?? "",
        uid: a.uid,
        health: a.health,
        expires_at: a.expires_at,
        fail_streak: a.fail_streak ?? 0,
        // 冷却信息必须透出：Web 要显示「冷却中，到 MM-DD HH:mm」与原因
        cooldown_until: a.cooldown_until ?? null,
        cooldown_reason: a.cooldown_reason ?? "",
      })),
    },
  };
}
