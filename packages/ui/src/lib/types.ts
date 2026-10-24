/** 前端自己的 API 数据类型子集（与共享层快照字段对齐）。 */

export interface UiSnapshot {
  ui_state: string;
  message: string;
  /** 授权页 URL。⚠ 不要在这里扫码（每次加载都是新的二维码会话）。 */
  auth_url: string;
  /** 二维码图片 URL，扫码用这一张（对应登录流程本轮轮询的 uuid）。 */
  qr_url: string;
  base_url: string;
  chat_url: string;
  endpoints: string[];
  models: string[];
  /**
   * 每模型附加信息（键 = 池模型 id）。
   *
   * 字段对齐共享层的 `PoolModelMeta`：消耗倍率、营销角标、上下文窗口、
   * 单次输出上限、输入模态（多模态能力）。建模为可选是因为上游目录可能不带这些字段。
   */
  model_info?: Record<
    string,
    {
      multiplier: number | null;
      marketing: string;
      contextWindow: number;
      maxOutputTokens: number;
      inputModalities: string[];
      /**
       * 思考模式（reasoning effort）档位；`null` = 渠道未声明。
       *
       * 与共享层 `PoolModelMeta.effort` 同形：**刻意可空**，界面据此显示
       * 「不支持」而不是编造档位。
       */
      effort?: { supportedLevels: string[]; defaultLevel: string } | null;
    }
  >;
  /**
   * 各渠道的能力位（键 = cid）。
   *
   * `billing: false` = 该渠道没有额度/倍率概念（订阅制）—— 前端据此把它的模型
   * 按「免费」显示。**不硬编码渠道名**：再接一个订阅制渠道，前端不用改。
   */
  channel_caps?: Record<string, { billing: boolean }>;
  theme_mode: string;
  resolved_theme: string;
  gateway_error: string;
}

export interface PoolAccount {
  key: string;
  uid: string;
  domain: string;
  label: string;
  /**
   * 名称类字段（昵称 / 用户名 / 邮箱 / 手机号）；渠道没给就是空串。
   *
   * 与 `label` 的区别：`label` 会退化成 uid / key，而 `name` 只在渠道真的
   * 提供了可读名称时才有值 —— 有 `name` 就显示名字，没有才退回脱敏 id。
   */
  name?: string;
  added_at: string;
  last_used_at: string;
  expires_at: number | null;
  health: string;
  health_at: string;
  /** 连续失败次数（达到上限后 health=error）。 */
  fail_streak?: number;
  /** 冷却截止（ISO8601）；`health === "cooldown"`（额度耗尽，等额度窗口刷新）时有意义。 */
  cooldown_until?: string | null;
  /** 冷却原因（人话，渠道给的判定）。 */
  cooldown_reason?: string;
}

export interface ChannelPool {
  cid: string;
  display: string;
  index: {
    version: 1;
    active: string | null;
    accounts: PoolAccount[];
  };
}

export interface PoolRow {
  model: string;
  candidates: Array<{
    cid: string;
    display: string;
    exposed_id: string;
    score: number;
    used: number;
    unit: string;
    cooling: boolean;
    unsupported?: boolean;
    ok: number;
    fail: number;
    billing_at: string | null;
  }>;
}

export interface ChannelInfo {
  cid: string;
  display: string;
  /** 凭证是否存在（后端 `status` action 的字段名是 `present`）。 */
  present: boolean;
  uid?: string;
}

export interface StatusRow {
  cid: string;
  display: string;
  present: boolean;
}

export interface CreditRow {
  cid: string;
  ok: boolean;
  error?: string;
  used?: number;
  unit?: string;
}

export interface CommandResult {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}
