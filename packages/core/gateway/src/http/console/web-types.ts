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

/**
 * 渠道级签到状态（控制台只读**本地台账**，不查上游 —— 见 `web-command-handler` 的说明）。
 *
 * `supported` 是渠道能力位（`capabilities.signin`）：false 时前端整行不渲染，
 * 而不是显示「未签到」—— 没有签到功能的渠道显示「未签到」会被读成「今天还没签」。
 */
export interface WebChannelSignin {
  /** 渠道是否有签到 / 领取能力（false = 控制台不显示「今日签到」）。 */
  supported: boolean;
  /** 是否按账号签到：true 时账号行用账号级台账，false 时全渠道共用渠道级记录。 */
  per_account: boolean;
  /** 渠道级「今天领过」（非 `per_account` 渠道的唯一口径）。 */
  claimed_today: boolean;
  /** 渠道级最后一次领取时刻（ISO）；没有记录为 null。 */
  at: string | null;
  /** 今天领到多少额度（渠道能报才有；控制台据此显示「+N」）。 */
  reward: { amount: number; unit: string } | null;
  /** 最近一次上游探测结论（当天有效）；null = 没探测过或已跨天。 */
  probe: SigninProbeView | null;
}

/** 一次 `signin.status()` 探测的结论（控制台展示用）。 */
export interface SigninProbeView {
  /** 上游有没有可领的；null = 查不到。 */
  claimable: boolean | null;
  /** 上游说今天已签；null = 渠道判断不了。 */
  claimed_today: boolean | null;
  /** 渠道自己的说明。 */
  summary: string;
  /** 探测时刻（ISO）。 */
  at: string;
}

/** 一次账号池查询里带上的签到视图：渠道级状态 + 账号级状态（仅按账号签到的渠道有值）。 */
export interface WebSigninView {
  channel: WebChannelSignin;
  accounts: Record<string, Omit<WebChannelSignin, "supported" | "per_account">>;
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
  signin: WebSigninView,
): Record<string, unknown> {
  return {
    cid,
    display,
    signin: signin.channel,
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
        // 仅按账号签到的渠道有账号级记录；其余渠道为 null（前端据此回落到渠道级口径）
        signin: signin.accounts[a.key] ?? null,
      })),
    },
  };
}
