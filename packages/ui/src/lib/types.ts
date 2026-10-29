/** 前端自己的 API 数据类型子集（与共享层快照字段对齐）。 */

/**
 * 待回答的输入请求（渠道两步登录，如 loomy 短信验证码、astudio 滑块验证）。
 *
 * 与共享层 `LoginInputRequest` 同形：`kind` 只影响界面措辞与键盘类型，
 * 渠道名等知识不下发到前端。
 */
export interface LoginInputRequest {
  kind: "phone" | "code" | "captcha";
  prompt: string;
  /**
   * `kind: "captcha"` 的挑战参数（GeeTest v3：`gt` + `challenge`）。
   *
   * 界面在**浏览器里**解滑块（加载官方同款 `gt.js`），解完把
   * `{geetest_challenge, geetest_validate, geetest_seccode}` 作为 JSON 串回传。
   */
  captcha?: { gt: string; challenge: string; success?: unknown };
}

export interface UiSnapshot {
  ui_state: string;
  message: string;
  /** 授权页 URL。⚠ 不要在这里扫码（每次加载都是新的二维码会话）。 */
  auth_url: string;
  /** 二维码图片 URL，扫码用这一张（对应登录流程本轮轮询的 uuid）。 */
  qr_url: string;
  /**
   * 待回答的输入请求；`null` = 当前没有。
   *
   * 非空时登录弹窗**只渲染输入卡**（提示 + 输入框 + 提交/取消），
   * 不渲染授权步骤时间线 —— 两步登录里用户要的就是「填这个框」。
   */
  login_input: LoginInputRequest | null;
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
      /**
       * 窗口 / 输出 / 档位各自从哪来（与共享层 `PoolModelMeta.sources` 同形）。
       *
       * `cross` = 兄弟渠道同 id 的推断值，界面标「推断」；缺省按上游声明呈现
       * （兼容不带该字段的旧快照）。
       */
      sources?: {
        contextWindow: "upstream" | "spec" | "cross" | "default";
        maxOutputTokens: "upstream" | "spec" | "cross" | "default";
        effort: "upstream" | "spec" | "cross" | "default";
      };
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
  /**
   * 熔断试探时刻（ISO8601）；`health === "error"` 时有意义。
   *
   * 到点后下一次请求自动放行做半开试探：成功恢复、再失败退避翻倍。
   */
  trip_until?: string | null;
  /** 当前熔断退避长度（ms）。 */
  trip_backoff_ms?: number;
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

/** 请求结果分桶；`other` = 应答前就断了（连状态码都没给出）。 */
export type AccessOutcome = "success" | "failure" | "other";

/**
 * 一条访问日志（形状与共享层 `AccessEntry` 一致，字段语义见 docs/LOGGING.md §3.1）。
 *
 * 可选字段是真的可能缺席：400/404/405 这类请求校验没过，日志里没有 `model` 与统计量。
 */
export interface AccessLogEntry {
  id: string;
  /** 请求**开始**时刻的 ISO（UTC）—— 界面必须转本地时区再显示。 */
  ts: string;
  method?: string;
  path?: string;
  cid?: string;
  model?: string;
  stream?: boolean;
  status?: number;
  outcome: AccessOutcome;
  error?: string;
  message?: string;
  durationMs?: number;
  upstreamMs?: number;
  ttfbMs?: number;
  /**
   * 纯生成窗口（首帧→末帧，毫秒）；缺省 = 测不到。
   *
   * TPS 的首选分母。旧的 `durationMs - ttfbMs` 减法在非流式下把分母压到 0（实测 76000 t/s），
   * 口径见 docs/LOGGING.md §3.1 与 docs/USAGE-STATS.md。
   */
  generateMs?: number;
  requestBytes?: number;
  messageCount?: number;
  systemChars?: number;
  toolCount?: number;
  /** 上游 usage 归一化结果；上游没给就是 null（失败请求通常没有）。 */
  tokens: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
    /** 缓存命中；null = 该上游**没有缓存字段**（与「命中 0」不同，见 docs/CACHE-HIT-RATE.md）。 */
    cache: { hit: number | null; miss: number | null } | null;
  } | null;
  slow: boolean;
}

export interface AccessLogStats {
  requests: number;
  success: number;
  failure: number;
  other: number;
  slow: number;
  avgDurationMs: number | null;
  /** 窗口内没有 usage 的条数（不把缺失当 0）。 */
  noUsage: number;
  tokens: { prompt: number; completion: number; total: number };
  /** 缓存命中（加权 `Σhit / Σ(hit+miss)`）；`hitRate` 为 null = 窗口内无一条带缓存字段。 */
  cache: { hit: number; total: number; hitRate: number | null };
}

/** 日志页的一次查询结果（对应 `GET /web/api/logs`）。 */
export interface AccessLogPage {
  ok: boolean;
  /** 实际返回的日期（当天无数据时后端已回落）。 */
  date: string;
  /** 可选日期，倒序。 */
  dates: string[];
  /** 窗口内出现过的渠道（未过滤，供下拉用）。 */
  cids: string[];
  slowMs: number;
  scanned: number;
  /** true = 统计只代表读窗口，不代表全天。 */
  truncated: boolean;
  /** 命中筛选的条数（可能大于本次返回的条数）。 */
  total: number;
  stats: AccessLogStats;
  entries: AccessLogEntry[];
}

/** 一条请求正文抓取记录（`phase`：client = 客户端原样体，upstream = 实际上行体）。 */
export interface PayloadRecord {
  ts: string;
  seq: number;
  id: string;
  phase: string;
  attempt?: number;
  cid?: string;
  model?: string;
  stream?: boolean;
  bytes: number;
  truncated: boolean;
  body: string;
}

export interface PayloadQueryResult {
  ok: boolean;
  id: string;
  /** 请求发生的日期（与列表接口的 `date` 同源）。 */
  date: string | null;
  /** 命中该请求的抓取记录（按写入时间排序；正文抓取恒开启，读回不受门控）。 */
  records: PayloadRecord[];
}

/** 日志查询参数（键名与 `/web/api/logs` 的 query 一致）。 */
export interface LogQuery {
  date?: string;
  outcome?: AccessOutcome;
  cid?: string;
  model?: string;
  stream?: boolean;
  slow?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

/** 用量统计的区间（对应 `GET /web/api/usage?range=`）。 */
export type UsageRange = "7d" | "30d" | "90d" | "365d";

/** 某一天的用量（趋势图与热力图的数据点）。 */
export interface UsageDaily {
  date: string;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  messages: number;
  /** 该日各模型 tokens（键 = `<cid>/<模型>`，空串 = 未知模型）。 */
  byModel: Record<string, number>;
}

/** 一个模型在区间内的用量。 */
export interface UsageModelRow {
  /** 池 id（`<cid>/<模型>`）；空串表示「未知模型」。 */
  id: string;
  tokens: number;
  input: number;
  output: number;
  cache: number;
  /** 占区间总 tokens 的比例（0–1）。 */
  share: number;
}

/**
 * `GET /web/api/usage` 的返回（形状与共享层 `UsageStats` 一致）。
 *
 * 口径与指标公式见 docs/USAGE-STATS.md —— 统计只覆盖**模型请求**
 * （`/v1/chat/completions`），且只覆盖日志保留期内的日期。
 */
export interface UsageStats {
  range: UsageRange;
  /** 区间端点（本地日期 `YYYY-MM-DD`，含端点）。 */
  from: string;
  to: string;
  totals: {
    tokens: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    messages: number;
    durationMs: number;
    /** 加权命中率；区间内无一条带缓存字段时为 null（显示 `—`）。 */
    cacheHitRate: number | null;
    /** 区间内单请求最长耗时。 */
    longestRequestMs: number | null;
  };
  /** 升序（趋势图从左到右）；只含有模型请求的日期。 */
  daily: UsageDaily[];
  /** 按 tokens 降序。 */
  models: UsageModelRow[];
  /** 「有请求」的连续天数，今天没请求时 `current` 算到昨天为止。 */
  streak: { current: number; longest: number };
  peak: { date: string; tokens: number; hour: number; hourTokens: number } | null;
  favorite: { id: string; share: number } | null;
}

/** `GET /web/api/overview` 返回的仪表盘聚合视图。 */
export interface OverviewResponse {
  ok: boolean;
  /** 日志扫描的日期。 */
  date: string;
  gateway: { ui_state: string; gateway_error: string };
  usage: {
    date: string;
    requests: number;
    success: number;
    failure: number;
    other: number;
    slow: number;
    avg_duration_ms: number | null;
    tokens: { prompt: number; completion: number; total: number };
  /** 缓存命中（加权 `Σhit / Σ(hit+miss)`）；`hitRate` 为 null = 窗口内无一条带缓存字段。 */
  cache: { hit: number; total: number; hitRate: number | null };
  };
  channels: Array<{
    cid: string;
    models: number;
    statuses: { ok: number; cooldown: number; error: number; unauthenticated: number };
    requests: { success: number; failure: number };
  }>;
  model_pool: { total: number; free: number; vision: number; thinking: number };
  recent: Array<{
    id: string;
    ts: string;
    cid?: string;
    model?: string;
    outcome: AccessOutcome;
    status?: number;
    /** 是否流式 —— TPS 口径要按它取基准（见 `tokensPerSecOf`）。 */
    stream?: boolean;
    /** 纯生成窗口（首帧→末帧）；缺省 = 测不到。 */
    generate_ms?: number;
    duration_ms?: number;
    ttfb_ms?: number;
    upstream_ms?: number;
    tokens: { prompt: number | null; completion: number | null; total: number | null } | null;
  }>;
}
