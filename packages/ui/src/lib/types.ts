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
  /** 网关状态（probing / login / running）；**不承载登录结果**。 */
  ui_state: string;
  /** 上一轮登录的一次性结果：`idle` / `done` / `error`。 */
  login_result?: "idle" | "done" | "error";
  message: string;
  /** 授权页 URL。不要在这里扫码（每次加载都是新的二维码会话）。 */
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
  /** 网关自身版本（如 `0.1.3`），顶栏版本胶囊的数据源。 */
  version: string;
  /**
   * 对外模型池的**「模型 × 渠道」矩阵**：一个 deepseek 模型可能由多个渠道供给。
   *
   * 模型 id 是裸名（不再有 `<cid>/` 前缀）；`meta` 是**该渠道**的元数据
   * （同一模型在不同渠道倍率/规格可能不同）。
   */
  models: Array<{ model: string; cid: string; meta: ModelInfo }>;
  /**
   * 模型级渠道偏好（「这个模型优先走哪家」）。
   *
   * `channels` 是该模型的全部候选渠道，`preferred` 为当前偏好（`null` = 自动选路）。
   * 偏好的渠道在选路里**置顶**，其余渠道仍按剩余额度排在后面；被偏好的渠道
   * 冷却 / 额度耗尽时自然顺延，不需要额外开关。
   */
  model_prefs: Array<{ model: string; channels: string[]; preferred: string | null }>;
  /**
   * 各渠道的能力位（键 = cid）。
   *
   * `billing: false` = 该渠道没有额度/倍率概念（订阅制）—— 前端据此把它的模型
   * 按「免费」显示。**不硬编码渠道名**：再接一个订阅制渠道，前端不用改。
   */
  channel_caps?: Record<string, { billing: boolean }>;
  /** 各接入目标当前的接入态（键 = target；开关式 UI 的状态源）。 */
  integrations?: Record<string, boolean>;
  /** 用户选的主题模式：system（跟随系统）/ dark / light（持久化在网关侧）。 */
  theme_mode: string;
  gateway_error: string;
}

/** 桌面壳的窗口控制桥（desktop/preload.cjs 经 contextBridge 暴露；浏览器里不存在）。 */
declare global {
  interface Window {
    modelmuxWindow?: {
      minimize(): Promise<void>;
      toggleMaximize(): Promise<void>;
      close(): Promise<void>;
      isMaximized(): Promise<boolean>;
      onMaximizeChange(callback: (maximized: boolean) => void): () => void;
      setTheme(mode: "system" | "dark" | "light"): Promise<void>;
    };
  }
}

/**
 * 单个模型的元数据（与共享层 `PoolModelMeta` 对齐）。
 *
 * 建模为可选字段是因为上游目录可能不带这些字段；`effort` 为 `null` 表示**渠道未声明**
 * （界面据此显示「不支持」，而不是编造档位）。
 */
export interface ModelInfo {
  multiplier: number | null;
  marketing: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  effort?: { supportedLevels: string[]; defaultLevel: string } | null;
  /**
   * 窗口 / 输出 / 档位各自从哪来（与共享层 `PoolModelMeta.sources` 同形）。
   *
   * `registry` = 统一模型注册表（`models.json`，与 `/v1/models` 同源）；
   * `web_search` = 联网补全写入，`cross` = 兄弟渠道同 id 的推断值。
   */
  sources?: {
    contextWindow: "upstream" | "spec" | "web_search" | "cross" | "registry" | "default";
    maxOutputTokens: "upstream" | "spec" | "web_search" | "cross" | "registry" | "default";
    effort: "upstream" | "spec" | "web_search" | "cross" | "registry" | "default";
  };
}

/**
 * 一个账号的当日签到记录（后端 `accounts` 命令透出，读的是本地台账）。
 *
 * `null` / 缺省 = 该渠道不按账号签到（或没有签到能力）—— 此时签到状态是**渠道级**的，
 * 见 `ChannelSignin`；不要在这里回落到「未签到」，那会把「不适用」说成「今天没签」。
 */
export interface AccountSignin {
  claimed_today: boolean;
  /** 领取时刻（ISO）；台账没记时刻为 null。 */
  at: string | null;
  /** 今天领到多少额度；渠道报不出数值时为 null。 */
  reward?: { amount: number; unit: string } | null;
  /** 额度数值来源；`carry`（跨窗口对比）是估算，界面会标注。 */
  reward_source?: SigninRewardSource | null;
  /** 最近一次上游探测结论（当天有效）。 */
  probe?: SigninProbe | null;
}

/** 与后端 `SigninRewardSource` 同口：`carry` 最弱（跨窗口对比），只在无其它口径时用。 */
export type SigninRewardSource = "channel" | "daily" | "delta" | "carry";

/** 一次 `signin.status()` 探测结论（控制台展示用）。 */
export interface SigninProbe {
  /** 上游有没有可领的；null = 查不到。 */
  claimable: boolean | null;
  /** 上游说今天已签；null = 渠道判断不了。 */
  claimed_today: boolean | null;
  /** 渠道自己的说明。 */
  summary: string;
  at: string;
}

/**
 * 渠道级签到状态（后端 `accounts` 命令透出）。
 *
 * `supported=false` = 该渠道没有签到功能（如 workbuddyai 国际版）→ 控制台**不渲染**
 * 「今日签到」行：写「未签到」会被读成「今天还没签」，与「根本没这项功能」是两回事。
 */
export interface ChannelSignin {
  supported: boolean;
  /** true = 按账号签到（账号行读账号级台账）；false = 全渠道共用渠道级记录。 */
  per_account: boolean;
  claimed_today: boolean;
  at: string | null;
  /** 今天领到多少额度；渠道报不出数值时为 null。 */
  reward?: { amount: number; unit: string } | null;
  /** 额度数值来源；`carry`（跨窗口对比）是估算，界面会标注。 */
  reward_source?: SigninRewardSource | null;
  /** 最近一次上游探测结论（当天有效）。 */
  probe?: SigninProbe | null;
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
  /**
   * 账号级签到（后端 `accounts` 命令透出）。
   *
   * `null` / 缺省 = 该渠道不按账号签到（或没有签到能力）—— 此时签到状态是**渠道级**的，
   * 见 `ChannelSignin`；不要在这里回落到「未签到」，那会把「不适用」说成「今天没签」。
   */
  signin?: AccountSignin | null;
}

export interface ChannelPool {
  cid: string;
  display: string;
  /** 渠道级签到状态（`supported=false` 时「今日签到」行整行不渲染）。 */
  signin?: ChannelSignin | null;
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

/**
 * 一次请求的结果分桶 —— 只有成功与失败。
 *
 * 历史第三桶 `other`（「中断」：没拿到状态码就断开）实测恒空，且界面多给一个分段
 * 只会让人去猜它什么意思；后端读旧 `other.log` 时按 failure 计。
 */
export type AccessOutcome = "success" | "failure";

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
  /** 首字 token 延迟超标（仅流式参与判定，阈值见 `AccessLogPage.slowThresholds`）。 */
  slowTtfb: boolean;
  /** 生成速率超标（阈值见 `AccessLogPage.slowThresholds`）。 */
  slowTps: boolean;
}

export interface AccessLogStats {
  requests: number;
  success: number;
  failure: number;
  /** 判定为慢的条数（首字延迟或生成速率，口径见 docs/LOGGING.md §3.5）。 */
  slow: number;
  /** 其中首字延迟超标的条数。 */
  slowTtfb: number;
  /** 其中生成速率超标的条数。 */
  slowTps: number;
  avgDurationMs: number | null;
  /** 窗口内**成功请求**的平均生成速率（tokens/s）；一条都算不出时为 null（口径见 docs/LOGGING.md §3.5）。 */
  avgTps: number | null;
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
  /** 「慢」判定的两个阈值（展示归因用，与后端 `slowVerdictOf` 同源）。 */
  slowThresholds: { ttfbMs: number; tps: number };
  scanned: number;
  /** true = 统计只代表读窗口，不代表全天。 */
  truncated: boolean;
  /** 命中筛选的条数（可能大于本次返回的条数）。 */
  total: number;
  stats: AccessLogStats;
  entries: AccessLogEntry[];
}

/** 日志查询参数（键名与 `/web/api/logs` 的 query 一致）。 */
export interface LogQuery {
  date?: string;
  outcome?: AccessOutcome;
  cid?: string;
  model?: string;
  stream?: boolean;
  slow?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * 用量统计的区间（对应 `GET /web/api/usage?range=`）。
 *
 * `365d` 只供热力图（日历恒看一年）；`all` = 累计（日志保留期内全量）。
 */
export type UsageRange = "today" | "7d" | "30d" | "90d" | "365d" | "all";

/** 某一天的用量（趋势图与热力图的数据点）。 */
export interface UsageDaily {
  date: string;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  messages: number;
  /** 该日各（渠道 × 模型）tokens（键 = `<cid>/<模型>`，空串 = 未知）。 */
  byModel: Record<string, number>;
}

/**
 * `POST /web/api/ping` 的返回：一次最小 chat 请求的实测结果。
 *
 * `ms` 量到**响应体读完**；`status` 为 0 表示请求压根没发出去（超时 / 连接失败），
 * 此时 `error` 是原因。`ok` 只看 HTTP 是否 2xx，不看内容。
 */
export interface PingResult {
  ok: boolean;
  model: string;
  ms: number;
  status: number;
  error: string;
}

/** 一个（渠道 × 模型）在区间内的用量与健康度。 */
export interface UsageModelRow {
  /** 聚合键 `<cid>/<模型>`（趋势图按它分序列）。 */
  id: string;
  /** 纯模型名（对外 deepseek id；空串 = 未知模型）。 */
  model: string;
  /** 承接该模型的渠道（空串 = 日志没记渠道）。 */
  cid: string;
  tokens: number;
  input: number;
  output: number;
  cache: number;
  /** 占区间总 tokens 的比例（0–1）。 */
  share: number;
  /** 成功请求数（`success.log` 里该模型 × 渠道的条数）。 */
  ok: number;
  /** 失败请求数（含中断）。 */
  fail: number;
  /** 进过上游排队的请求数；> 0 时模型列表打「排队」标签。 */
  queued: number;
  /** 成功请求的平均生成速率（tokens/s）；一条都算不出时为 null。 */
  avgTps: number | null;
}

/** 一个账号**今日**的 token 消耗（账号池账号行用，与「今日消耗」同口径）。 */
export interface UsageAccountRow {
  key: string;
  tokens: number;
  requests: number;
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
    /** 成功 / 失败条数（与日志页统计条同一口径）；区间 KPI 卡读它。 */
    success: number;
    failure: number;
    /** 判定为慢的条数。 */
    slow: number;
    durationMs: number;
    /** 加权命中率；区间内无一条带缓存字段时为 null（显示 `—`）。 */
    cacheHitRate: number | null;
    /** 命中率分子 / 分母的绝对值。 */
    cacheHit: number;
    cacheTotal: number;
    /** 区间内单请求最长耗时。 */
    longestRequestMs: number | null;
    /** 区间内**成功请求**的平均生成速率（tokens/s）；一条都算不出时为 null。 */
    avgTps: number | null;
    /** 上游没回 usage 的请求数（仪表盘用量明细里要露出来）。 */
    noUsage: number;
  };
  /** 升序（趋势图从左到右）；只含有模型请求的日期。 */
  daily: UsageDaily[];
  /** 按 tokens 降序。 */
  models: UsageModelRow[];
  /** 每个账号**今日**的 token 消耗（降序）；当天无请求时为空数组。 */
  accounts: UsageAccountRow[];
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
    slow: number;
    avg_duration_ms: number | null;
    tokens: { prompt: number; completion: number; total: number };
  /** 缓存命中（加权 `Σhit / Σ(hit+miss)`）；`hitRate` 为 null = 窗口内无一条带缓存字段。 */
  cache: { hit: number; total: number; hitRate: number | null };
  /** 尾部扫描窗口被截断：极端量级下统计只代表窗口内（排障用，页面不展示）。 */
  truncated: boolean;
  /** 本次统计实际扫描的行数。 */
  scanned: number;
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
    /** 失败 / 中断的错误码（如 `upstream_timeout`）；成功行缺省。 */
    error?: string;
    /** 失败 / 中断的说明文案（控制台直接展示，超长由行内截断）。 */
    message?: string;
  }>;
}
