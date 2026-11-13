/**
 * 渠道注册表：共享 gateway 层与渠道独有模块（cred / upstream / catalog / billing）之间
 * **唯一的接缝**。
 *
 * 共享层不含渠道知识但运行期要调用渠道实现 —— 共享模块只认这里的 `Channel` 接口，
 * 每个渠道包在入口把模块组装成 `Channel` 并 `setChannel()` 注册，共享包不 import
 * 任何渠道模块。落点（存储根 / 分层名 / 文件名）统一由 `paths.ts` 按 `cid` 推导
 * （docs/STORAGE-CONVENTION.md）。生命周期：渠道包模块加载时 `setChannel()`，
 * 共享模块在**函数被调用时** `getChannel()` 取用 —— 注册顺序只需早于第一次
 * 网络/路径操作即可。
 */

/** 凭据的最小契约（见 docs/CONTRACT-TS.md §3）。渠道可带更多字段。 */
export interface Credential {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
}

/** 上游流翻译器：必须增量（见 CONTRACT-TS.md）。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
  /**
   * 上游已发出终止标记（`finish()` 已在 `feed()` 内完成）。
   * 网关据此立即停止读上游，不再等 TCP 关闭 —— 部分渠道（如 catpaw）的
   * 事件流不随 turn 结束关闭，只等 close 会让请求挂到超时。
   */
  isDone?(): boolean;
  /**
   * 已收到**客户端可执行**的工具调用，但上游还在等后续（拿不到结束标记）。
   * 网关据此在空闲一段时间后主动收尾，把 tool_calls 交给客户端 ——
   * 否则上游等工具结果、网关等上游结束，互等至上游超时。
   */
  hasPendingToolCall?(): boolean;
  /**
   * 收到内容后上游静默超过该毫秒数即视为本轮结束（毫秒）。
   * 用于上游发完正文却不关流的场景（catpaw 实测沉默 170s）。
   */
  idleCutoffAfterContentMs?(): number;
  /** 主动回报会话完成（上游保持连接时用它解卡）。 */
  ackConversation?(): void;
}

/** 上游连接配置（渠道自定义字段由各渠道补）。 */
export interface UpstreamConfig {
  baseUrl: string;
  [key: string]: unknown;
}

export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
  days_left?: number | null;
  [key: string]: unknown;
}

export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  claimable?: Array<Record<string, unknown>>;
}

/**
 * 登录过程中需要用户提供的一段输入（两步登录用）。
 *
 * `kind` 只用于界面措辞与键盘类型（手机号 → 数字键盘，验证码 → 数字），
 * **不是**渠道知识 —— 渠道只负责在需要时发起请求，界面怎么渲染由界面决定。
 */
export interface LoginInputRequest {
  kind: "phone" | "code" | "captcha";
  /** 给用户看的一句话（如「手机号」「验证码已发送至 138****0001」）。 */
  prompt: string;
  /**
   * `kind: "captcha"` 时的挑战参数（GeeTest v3：`gt` + `challenge`）。
   *
   * 界面用它在**浏览器里**解滑块（加载官方同款 `gt.js`），解完把
   * `{geetest_challenge, geetest_validate, geetest_seccode}` 作为输入值回传。
   *
   * 这个字段是**通用**形态（不绑定任何厂商）：它只描述「一个需要浏览器
   * 完成的挑战」，具体怎么解由界面决定。渠道拿不到解法时的兜底是
   * 改走别的登录路（astudio：读桌面应用的会话文件）。
   */
  captcha?: { gt: string; challenge: string; success?: unknown };
}

/** 登录流程的界面能力（打到 stdout / 窗口状态机都可以满足）。 */
export interface LoginUi {
  setState(state: string, message?: string, url?: string): void;
  /**
   * 二维码图片 URL（可选）。扫码必须用这一张：它对应本轮长轮询的 uuid，
   * 而授权页每次加载都会生成新的 uuid。
   *
   * 实现**不能**把它丢掉：CLI 没有观察者，丢掉就等于没给用户扫码入口
   * （终端里得把这条 URL 打出来，让用户打开图片扫码）。
   */
  setQr?(url: string): void;
  /**
   * 取走用户粘回的回调链接（可选，只消费一次）。
   *
   * 回调页线上是 404，`code` 只出现在浏览器地址栏；没有浏览器的进程
   * （网关/CLI）只能靠用户把它粘回来 —— 故 CLI 侧要收 stdin 一行。
   */
  takePastedCallback?(): string | undefined;
  /**
   * 向用户要一段输入（可选，两步登录用，如 loomy 的短信验证码）。
   *
   * 返回用户填的内容；用户取消 / 界面关闭 / 无人应答 → 返回 `undefined`，
   * 由渠道自己决定怎么办（一般是回落到环境变量或报「已取消」）。
   *
   * **无界面实现不要实现它**（CLI 的 `StdoutLoginUi` 就不实现）：
   * 渠道必须先试 `requestInput`，拿到 `undefined` 再回落到自己的输入来源
   * （环境变量 / 文件），否则终端用户会卡在等一个永远不来的输入框。
   */
  requestInput?(req: LoginInputRequest): Promise<string | undefined>;
}

/*
 * 下面四个接口描述「渠道模块必须提供哪些成员」。凭据/配置形态各渠道不同，
 * 故这些位置用 `any`：共享层只在**结构**上依赖它们（调用点已由 CONTRACT-TS.md
 * 固定），不做跨渠道的类型统一 —— 那会在多个异构渠道间制造大量摩擦。
 */

/** 渠道 `cred.ts` 需要提供的接口。 */
export interface CredModule {
  DEFAULT_BASE_URL: string;
  NotLoggedInError: new (message?: string) => Error;
  load(): any;
  save(c: any): Promise<void>;
  login(
    baseUrl: string,
    options?: {
      onUrl?: (url: string) => void;
      onStatus?: (msg: string) => void;
      /** 二维码图片 URL（loomy 的微信扫码用；扫码必须用这张）。 */
      onQr?: (url: string) => void;
      /** 取走用户粘回的回调链接（回调页 404，code 只在地址栏里）。 */
      pasteCode?: () => string | undefined;
      /**
       * 向用户要一段输入（两步登录用；见 `LoginUi.requestInput`）。
       *
       * **无界面时不要传**（CLI 的实现不提供它）——
       * 渠道必须能回落到自己的输入来源（环境变量 / 读外部会话文件）。
       */
      requestInput?: (req: LoginInputRequest) => Promise<string | undefined>;
      /**
       * 强制重读（`mx relogin`）：跳过「已有凭据就复用」的短路。
       *
       * astudio 这类「凭据来自外部会话文件」的渠道不传就永远是空操作。
       */
      force?: boolean;
    },
  ): Promise<any>;
  refresh(c: any): Promise<any>;
  resolveBaseUrl(realm?: string): string;
  /**
   * 可选：**登出** —— 销毁本渠道的本地凭据。
   *
   * 与「删除池里的某个账号」（`account-pool.ts` 的 `removeAccount`）不是一回事：
   * 那是从池里摘掉一个条目，这是**整渠道登出**（凭据 + 池内账号一起清）。
   * 渠道没声明本钩子时，CLI / 控制台只能退回 `removeAccount` 的等价效果。
   *
   * 各渠道的「吊销上游会话」能力不同（多数拿不到登出端点），
   * 故契约只要求「本地销毁」，上游是否真的失效由渠道在实现里说明。
   */
  logout?(): Promise<void>;
  /**
   * 可选：渠道自带的**扫码登录**入口（与 `login` 并列的第二条登录路径）。
   *
   * 共享层只负责把界面回调（授权页 URL / 二维码图 / 状态 / 粘贴兜底）递进去，
   * 不关心扫码协议本身 —— 渠道没声明本钩子时，CLI 的扫码登录参数直接报「不支持」。
   *
   * 参数与 `login` 的 options 同形，便于共享层用同一套界面回调驱动两条路径。
   */
  loginWechat?(
    baseUrl?: string,
    options?: {
      onUrl?: (url: string) => void;
      onStatus?: (msg: string) => void;
      /** 二维码图片 URL（扫码必须用这一张）。 */
      onQr?: (url: string) => void;
      /** 取走用户粘回的回调链接。 */
      pasteCode?: () => string | undefined;
    },
  ): Promise<any>;
}

/** 渠道 `upstream.ts` 需要提供的接口。 */
export interface UpstreamModule {
  DEFAULT_BASE_URL: string;
  /** `openai`（标准 SSE delta）或 `custom`（需翻译层）。 */
  WIRE: "openai" | "custom";
  /** 展示名（状态页与日志用）。 */
  DISPLAY_NAME: string;
  UpstreamUnauthorized: new (message?: string) => Error;
  defaultConfig(): any;
  loadConfig(): [any, boolean];
  saveConfig(cfg: any): Promise<void>;
  chatUrl(cfg?: any): string;
  /**
   * 可选：**按模型**决定对话端点。
   *
   * 有些上游**每个模型走不同的网关主机**（AStudio 实测：模型配置里每个 model
   * 各带一个 `base_url`，如 `maas-api.cn-huabei-1.xf-yun.com/v2` 与
   * `spark-api-open.xf-yun.com/agent/v1`）—— 硬编码一个 host 会对部分模型 404。
   *
   * 声明本钩子后，网关用**它**的结果而不是 `chatUrl()`。
   * 入参是**上游模型名**（已经过 `catalog.resolveModel()`）。
   */
  chatUrlForModel?(upstreamModel: string, cfg?: any): string;
  modelsUrl(cfg?: any): string;
  buildHeaders(credential: any, cfg?: any): Record<string, string>;
  /**
   * 可选：发请求前确保凭据可用（如 token **已过期**时阻塞续期）。
   *
   * 为什么需要：`buildHeaders` 是同步的，无法「先续期再发」。而有些渠道的
   * 预刷新是惰性的（由请求触发、非阻塞），一旦 token 已经过期，当前请求会
   * 拿着死 token 发出去 —— 上游回 HTTP 200 + 鉴权失效帧，客户端报请求失败，
   * 而后台刷新其实已经把下一个请求修好了。声明本钩子后，网关在 `buildHeaders`
   * 之前先 `await` 它；钩子只需在**已过期**时阻塞，续期窗口内不必阻塞
   * （否则每个请求都要多等一次网络往返）。
   *
   * 钩子可就地改写传入的 credential（如换上新 accessToken），使随后的
   * `buildHeaders` 用上新 token。
   */
  refreshIfExpired?(credential: any): Promise<void>;
  /**
   * 可选：对话请求的**专用头族**（上游按整组头判定「是否官方客户端」的渠道需要）。
   *
   * 缺省时网关回退 `buildHeaders`（基础鉴权头）——普通 OpenAI 兼容渠道无需声明。
   * 实例：workbuddyai 的官方桌面端身分头族（含每轮新生的会话/请求 ID）。
   *
   * `body`（可选）：网关已序列化的请求体。**签名类渠道**要用它把 payload 哈希
   * 计进签名（如华为云 `SDK-HMAC-SHA256` 的 `X-Sdk-Content-Sha256` 与
   * `Authorization` 头）—— 签名覆盖 body 时必须在建头阶段算好，而网关的
   * `fetch` 只认这组网。不签名的渠道忽略该参数即可（向后兼容）。
   */
  buildChatHeaders?(credential: any, cfg?: any, body?: Buffer): Record<string, string>;
  /**
   * 可选：判定某个**非 200** 响应是否算**鉴权失败**（触发 token 刷新 + 标记账号不可用）。
   *
   * 共享层默认只认 401；403 默认也算（有的上游用它表示「账号被限制」）。
   * 声明本钩子后 403 改由钩子判定 —— 实例：AStudio 用 `403 + 业务码 11200` 表示
   * 「无有效订单 / 额度不足」，那是权益问题，刷新令牌没有用，误判会白刷一次 token
   * 并把账号错标成 `unauthorized`。
   *
   * 401 恒为鉴权失败，不调用本钩子；其它 4xx 无钩子时不算。
   * 返回 true 时网关按 401/403 同路径处理，非标准状态码归一成 401。
   */
  isAuthFailure?(status: number, body: string): boolean;
  /**
   * 可选：声明本渠道的**额度信号**（业务码 / 专有措辞）。
   *
   * 为什么需要它：额度类业务码是**渠道知识**（如 workbuddyai 的 `code=6004`
   * 「usage exceeds frequency limit」），共享层不许硬编码。共享层只认**通用**措辞
   * （`insufficient_quota`、「余额不足」这类任何上游都可能用的说法）；渠道自己的
   * 码与专有措辞通过本钩子上报。
   *
   * @returns `usage_limit` = **账户级用量限额**（对所有模型生效，含倍率 0 的，一律冷却）；
   *          `balance` = **余额不足**（只影响计费用量，免费模型仍可继续打上游）。
   *          认不出返回 `null`。
   */
  quotaSignal?(status: number, body: string): QuotaSignal | null;
  /**
   * 可选：从**上游错误体**里认出「额度耗尽 + 下次刷新时刻」。
   *
   * 共享层已有一层通用判定（`isQuotaExhausted`，看措辞），命中就**冷却**该账号；
   * 但「等到什么时候」只有渠道知道 —— 有的上游直接把重置时间放在错误体里
   * （主人实测 workbuddyai 花完 1 亿 token 后返回下次刷新时间），有的按自然日重置。
   *
   * @param bodySnippet 上游错误响应体的片段（可能被截断，见 `BUFFER_LIMIT`）。
   * @returns 下次刷新时刻（epoch ms）；**认不出返回 `null`**，共享层回落次日本地 0 点。
   *          不要为了「显得完整」编一个时间 —— 编错会让账号冷却到错误的时刻。
   */
  quotaResetAt?(bodySnippet: string): number | null;
  /**
   * 可选：上游响应头到达后允许的**连续静默上限**（毫秒），默认 `MODELMUX_READ_TIMEOUT_MS`（120s）。
   *
   * 有些上游排队/长思考时**收下请求（HTTP 200）后长时间零字节**，且不像其他渠道那样
   * 发心跳或排队错误帧 —— 固定 120s 会把还活着的上游误杀成超时。
   * 实测 Qoder 长上下文首字延迟 40–71s，排队时静默可超过 120s（见 docs/channels/qoder/PROTOCOL.md）。
   *
   * 只放宽「连接层静默容忍」，不改变任何协议语义；声明后网关的首帧等待、
   * 空闲守卫与探测层统一用这个上限。
   */
  idleTimeoutMs?(): number;
  /**
   * 构造上游请求体。
   *
   * 返回**对象**时，网关会 `JSON.stringify` 后发出（绝大多数渠道）。
   * 返回**字符串**时，网关**按字符串直发**（一个字节都不再包装）—— 供「请求体本身
   * 要经过渠道自己的编码」的上游使用（如 qoder 的 COSY 自定义 Base64 变体）。
   *
   * 返回字符串的渠道不能用 `prepareChat` 钩子（那个钩子接的是对象形态的 body）。
   */
  buildChatBody(
    req: Record<string, unknown>,
    upstreamModel: string,
  ): Record<string, unknown> | string;
  /**
   * 可选：发上游请求**之前**要完成的异步前置动作（网关会 `await` 它）。
   *
   * 为什么需要这个钩子：`buildChatBody` 是**同步**契约（网关拿到 body 就发），
   * 但有些上游要求「先建会话 → 再标记 running → 最后才发对话」这种多步顺序，
   * 错一步就被拒。若从 `buildChatBody` 里 fire-and-forget 发起，会与对话请求
   * 竞争（实测 catpaw：round/event 未完成时 turn 已发出，上游回「会话未在执行中」）。
   *
   * 参数是**网关已经建好的 body**（不是 `req`）：渠道必须基于同一个 body 做前置，
   * 否则再调一次 `buildChatBody` 会生成新的会话 id，前置与对话就指向两个会话。
   *
   * 未实现时网关直接跳过（绝大多数渠道不需要）。
   */
  prepareChat?(body: Record<string, unknown>): Promise<void>;
  /**
   * 可选：由渠道自行提供**本次对话的响应字节流**，覆盖网关默认的 POST chatUrl 读响应体。
   *
   * 为什么需要它：有些上游的对话内容不在主 POST 的响应体上 —— 主 POST 只回一个受理结果，
   * 内容经另一条长连接（SSE / WS）回流。没有本钩子时，这种渠道只能在 prepareChat 里把
   * 整轮跑完再一次性交给翻译器，流式退化成末尾突发：客户端在整个生成期间收不到任何字节
   * （连响应头都没有），与卡死无法区分。
   *
   * 声明本钩子后，网关不再向 chatUrl() 建连（buildHeaders / chatUrlForModel 不会为此被调用），
   * 改为把返回的 ReadableStream 当作上游响应体交给翻译器增量消费；首帧、心跳、空闲守卫与
   * 探测重试走既有同一套管线。返回 null 时回落到默认的 POST chatUrl 路径。
   *
   * 返回流的字节形态必须与 WIRE / newTranslator() 对齐。鉴权建连由渠道自己完成（在
   * runInChannel 上下文里 cred.load() 取凭据）；建连阶段的凭据失效必须抛 UpstreamUnauthorized，
   * 网关据此走刷新重试。只有内容确实在侧信道的渠道才声明它。
   */
  openChatStream?(body: Record<string, unknown>): Promise<ReadableStream<Uint8Array> | null>;
  fetchModels(credential: any): Promise<Record<string, unknown>>;
  resolveConfig(data: Record<string, unknown>, fallback?: any): any;
  /**
   * 仅 `WIRE === "custom"` 时需要。
   *
   * 传入客户端原始请求（可选）：渠道可据此读取 `tools` / `tool_choice`，
   * 把上游调用名归一化到客户端工具（如 catpaw 的提示词工具模拟）。
   */
  newTranslator(request?: Record<string, unknown>): StreamTranslator;
  /**
   * 可选：判定**流内错误帧**是否为「排队」语义（上游还在处理，稍后可重发）。
   *
   * 背景：有些上游对过载/排队不拒绝连接，而是回 HTTP 200 + SSE 里投递一个
   * 业务错误帧（如 qoder 的 `code:"10605"` + `retryAfterSeconds`）。共享层在
   * **尚未向客户端写出任何字节**时收到这类帧会等待并重开上游重试；声明本钩子的
   * 渠道才能触发该行为，未声明的渠道照旧把错误帧透传给客户端。
   *
   * 只在响应头发出前调用；返回 true 且已吐过字节时不会重试（避免重复内容）。
   */
  isQueueError?(frame: Record<string, unknown>): boolean;
  /**
   * 可选：候选**对话主机**清单（主机级故障切换用）。
   *
   * 有些上游是多主机部署，个别主机对「200 后零字节 / 断流」是坏的，换台机器就恢复。
   * 网关的**探测重试**在失败后会换主机重开上游，未声明本钩子的渠道照旧原地重试。
   *
   * 返回**副本**语义由渠道保证（调用方会缓存并按序取用）。
   */
  chatHostCandidates?(): string[];
  /**
   * 可选：切换本次应答使用的对话主机（`null` = 回到默认 / 记忆中的主机）。
   *
   * 与 `chatHostCandidates` 配套：网关换主机时调用它，改写后续请求的落点。
   */
  setChatHostOverride?(host: string | null): void;
  /**
   * 可选：读取本次应答实际使用的主机。
   *
   * 网关用它记下「这条应答跑在哪台机器上」，换主机重试成功后据此回报。
   */
  currentChatHost?(): string;
  /**
   * 可选：换主机成功后把主机**持久化**（后续请求直接用这台，别再从坏机器开始）。
   *
   * 参数是网关观测到的主机（提示）；实现也可自行取当前主机。
   */
  rememberChatHost?(host?: string): void;
}

/**
 * 渠道 `catalog.ts` 需要提供的接口。
 *
 * **倍率不在这里**：消耗倍率统一走池层的 `PoolModelMeta.multiplier`
 * （由各渠道目录里的倍率字段汇聚而来），目录模块不承担倍率文案职责。
 */
export interface CatalogModule {
  exposedIds(): string[];
  resolveModel(name: string): string;
  /**
   * **强制**从上游重拉目录并落盘（CLI 的 `--refresh` 用）。
   *
   * 可选：只有具备「远端目录层」的渠道才实现（catpaw / lobsterai /
   * traecn / raccoon / loomy）。目录本身就是静态内置表的渠道
   * （workbuddyai / qoder）**不实现** —— 共享层据此回报
   * 「该渠道的模型表是内置的，没有可刷新的远端」，而不是假装刷了一遍。
   *
   * 实现约定：
   * - 成功时把新目录写进 `cache/models.json`（见 `catalog-cache.ts`），
   *   使**下一个进程**直接读到它；
   * - 失败**抛错**（与自动路径的「静默回落」相反）—— 用户显式要求刷新时
   *   必须知道到底成没成，而不是看到一张旧表还以为刷成功了。
   */
  refresh?(): Promise<void>;
  /**
   * 可选：渠道按**公开规格**维护的模型规格（窗口 / 输出上限 / 思考档位 / 消耗倍率）。
   *
   * 用于没有目录端点、只有内置快照的渠道 —— 那种情况下上游目录读不出来，
   * 池层的四层回落会拿不到任何值，只能靠本钩子（来源标 `spec`）。
   *
   * **只填实测值**：查不到就整个字段省略（`undefined`），不要让池层填占位数字 ——
   * 客户端会按它算钱，无源填 1 与编造无异（云端目录没有对应行的模型就必须省略）。
   */
  modelSpec?(modelId: string): {
    contextWindow?: number;
    maxOutputTokens?: number;
    effort?: { supportedLevels: string[]; defaultLevel: string };
    /** 消耗倍率（积分倍率）；省略 = 未知。 */
    multiplier?: number;
  } | undefined;
}

/** 签到 / 领取的**只读**状态。 */
export interface SigninStatus {
  /** 是否有可领的；`null` = 查不到（不代表"没有"）。 */
  claimable: boolean | null;
  /** 人读摘要（各渠道自己的说法，如「今日未签到」「已领 300 积分」）。 */
  summary: string;
  /** 可领取项明细（有就给）。 */
  items?: Array<Record<string, unknown>>;
  /**
   * **今天是否已签**（渠道能判断就给；判断不了就用 `null`）。
   *
   * CLI 的「今日是否签到过」判定顺序是：这个字段优先，其次是本地签到台账，
   * 都拿不到就明确报"不知道"（不猜）。上面 `claimable: false` 单独用**分不清**
   * 「今天已签」与「没有可领的东西」，所以这个字段是必要的。
   */
  claimedToday?: boolean | null;
  /**
   * **今天已领多少额度**（可选，仅 `claimedToday === true` 时有意义）。
   *
   * 用途：控制台在账号详情里显示「今日签到 +N」。有的渠道只在**状态查询**里
   * 给当天入账额（raccoon 的账单、traecn 的 checkin status），领取接口本身不回数字 ——
   * 调度器据此给「台账已签但没记额度」的记录补一次额度（见 `auto-signin`）。
   * 领不到就不填，绝不从 summary 里正则抠数字。
   */
  reward?: SigninReward;
  /**
   * 本渠道**每日签到发放的额度**（可选，与 `reward` 无关）。
   *
   * `reward` 是「今天实际入账多少」；这个是「每天发多少」的公布值 —— 适用于**签到动作
   * 本身就是当日额度的发放**（loomy 的每日重置：领到就是 5000/天）而上游不回报入账额的渠道。
   * 必须是上游公布或实测的值，**不能是猜的**；拿不准就不填。
   */
  dailyReward?: SigninReward;
  /**
   * 当前签到窗口的**结束**时刻（epoch ms，可选）。
   *
   * 用途：有的渠道签到日界不是本地 0 点（qodercn 是 10:00 UTC+8）。调度器把领取时的
   * `resetAt` 记进台账，`Date.now() > resetAt` 就说明已进入新窗口，允许再领一轮 ——
   * 不声明则按本地自然日判定。
   */
  resetAt?: number;
  /**
   * 当前签到窗口的**开始**时刻（epoch ms，可选）。
   *
   * 用途：判定**旧台账记录**（没有记窗口）是否属于已结束的窗口 ——
   * `windowStartsAt > 记录时刻` 就说明记录是上一窗口的，需要再领一轮。
   * 只在成功查询到状态时用作一次性判定，不落台账。
   */
  windowStartsAt?: number;
  /**
   * 是否**每日**语义。默认 `true`；`false` 表示它不是每日签到（如 raccoon 那种
   * 一次性登录奖励）—— CLI 不会对它套"今天"的话术。
   */
  daily?: boolean;
}

/** 一次领取到手的额度（签到奖励）。 */
export interface SigninReward {
  /** 数量；上游没给具体数值就不填（不要从摘要里猜）。 */
  amount: number;
  /** 单位（`积分` / `credits` / `Points`…，渠道给的原文）。 */
  unit: string;
}

/** 执行签到 / 领取的结果。 */
export interface SigninOutcome {
  ok: boolean;
  /** 人读摘要（如「签到成功，+300 积分」）。 */
  summary: string;
  /**
   * **这次实际领到多少额度**（可选）。
   *
   * 只有渠道能从上游回答「发放了多少」时才填：控制台据此在账号详情里显示
   * 「今日签到 +N」，并记进本地台账。填不出来（上游只回一句 message）就省略 ——
   * 从 `summary` 里正则抠数字会把「连续 3 天」这类文案当成额度。
   */
  reward?: SigninReward;
  /** 渠道原始返回（`--json` 时给）。 */
  detail?: unknown;
}

/**
 * 渠道的**签到 / 领取**能力（**必需**：每个渠道都要给）。
 *
 * 有的渠道叫「签到」（check-in / signin），有的叫「活动领取」（claim / 奖励），
 * 还有的**根本没有端点**（奖励由上游自动发）。统一收敛成这两个动作，CLI 的
 * 签到已自动化（auto-signin.ts），网关运行期对**所有**渠道一视同仁地调用它们。
 *
 * **共享层不做能力探测、也不特判任何渠道**：
 * - 有端点的渠道 → 真的查 / 真的领；
 * - 没有端点的渠道 → 由**渠道自己**返回一句人读说明
 *   （`status()` 给 `claimable: false` + 说明；`claim()` 给 `ok: true` + 同句说明），
 *   不是错误、也不影响退出码。
 *
 * `claim()` 是**写**操作（会真的领掉），实现方要保证幂等或至少可安全重复调用。
 */
export interface SigninModule {
  status(): Promise<SigninStatus>;
  /**
   * 执行签到 / 领取。
   *
   * @param options.credential 指定**哪个账号**的凭据（形状已由共享层归一化）；
   *   不传 = 渠道按自己的「当前生效凭证」执行（保持原行为）。
   *   只有当渠道声明 `perAccount: true` 时共享层才会逐个账号传它。
   */
  claim(options?: { credential?: Record<string, unknown> }): Promise<SigninOutcome>;
  /**
   * 是否支持**按账号**签到 / 领取（默认 `false` = 只对当前生效账号）。
   *
   * 为什么需要这个能力位：账号池里每个账号的额度/奖励是**各自独立**的
   * （实测 loomy 4 个账号各有自己的每日赠送与一次性新手任务），但绝大多数渠道的
   * `claim()` 只能作用于生效凭证 —— 共享层若对它们逐个账号调用，只会重复打同一个账号
   * （N 次无效请求）。故由渠道显式声明支持，调度器才逐账号循环。
   */
  perAccount?: boolean;
}

/**
 * 渠道声明的额度信号类型。
 *
 * - `usage_limit`：**账户级用量限额**（如 workbuddyai `6004`）—— 对所有模型生效，
 *   连倍率 0 的也受限 → 网关**一律冷却**该账号（等到渠道认的重置时刻）。
 * - `balance`：**余额不足**（如 loomy `402 insufficient_quota`）—— 只影响计费用量，
 *   免费模型仍可继续打上游 → 只冷却**付费**模型。
 * - `rate_limit`：**频率/速率超限**（如 traecn `3004`）—— 上游说「等会儿再试」，
 *   但**没给等待时长**；账号级冷却挡不住它（生效凭据照样被使用，其他账号的额度
 *   仍让渠道保持高优先级），故改为**渠道级短冷却**，让请求先落到别家。
 */
export type QuotaSignal = "usage_limit" | "balance" | "rate_limit";

/**
 * 渠道的额度周期（可选能力，见 `BillingModule.quotaPeriod`）。
 *
 * 共享层靠它做两件事：**展示**（「每天 5000 积分，0 点刷新」）与**冷却判定**
 * （额度耗尽时等到 `resets_at`）。渠道不给就回落共享层的兜底（次日本地 0 点）。
 */
export interface QuotaPeriod {
  /** 人读文案，如「每天 5000 积分，0 点刷新」。 */
  label: string;
  /** 本周期额度总量；上游不公开给 `null`（不要编造）。 */
  size: number | null;
  /** 单位（积分 / credits / token…）。 */
  unit: string;
  /** 下次额度刷新时刻（epoch ms）；未知给 `null`。 */
  resets_at: number | null;
}

/** 渠道 `billing.ts` 需要提供的接口。 */
export interface BillingModule {
  CreditsError: new (message?: string) => Error;
  /**
   * 查额度。
   *
   * `credential` 用于**按账号**查询：不传 = 当前生效账号（`cred.load()`）；
   * 传入时用它代替 `cred.load()`。形状见 `credential-shape.ts` 的归一化结果。
   *
   * `refreshOn401` 为真且上游拒绝凭据时，渠道应续期后重试一次。**传入 `credential`
   * 的调用方必须先套 `accounts.runForAccountCredential(cid, key, …)`** —— 否则
   * 渠道 `refresh()` 的落盘会写进 live 文件，把生效账号的凭据顶掉。
   */
  fetchCredits(options?: { refreshOn401?: boolean; credential?: unknown }): Promise<any>;
  /**
   * 额度周期（**可选**）：周期文案 + 总量 + 下次刷新时刻。
   *
   * 用途见 `QuotaPeriod`。渠道**不认识自己的周期就别实现** —— 共享层有兜底（次日 0 点），
   * 编一个假的周期比不实现更糟。
   */
  quotaPeriod?(): QuotaPeriod | null;
  /** 签到 / 领取能力（见 `SigninModule`；**每个渠道都必须提供**）。 */
  signin: SigninModule;
}

/** 渠道能力声明（缺省视为支持）。 */
export interface ChannelCapabilities {
  /** 是否提供额度查询。false = 无额度概念，CLI / UI 统一显示 `-`。 */
  readonly billing: boolean;
  /** 是否提供签到 / 领取。false = 无签到概念，CLI 统一显示 `-`。 */
  readonly signin: boolean;
  /**
   * 上游是否可能**排队**（请求被收下但长时间不出字）。
   *
   * true 时：网关的排队探测会**立即放弃本候选、换下一条**（不等待）；
   * 模型偏好的自动排序也把它往后放（用户默认不该把排队渠道设为首选）。
   * 省略 = `false`。
   */
  readonly queue: boolean;
}

/**
 * 渠道的静态配置：cid / 展示名 / 版本 / 端口集中在一个对象里。
 */
export interface ChannelConfig {
  /** 渠道 id，如 `catpaw`。用于日志前缀、服务名、CLI 名，以及统一存储根下的**分层名**。 */
  readonly cid: string;
  /** 展示名，如 `CatPaw`。 */
  readonly display: string;
  /** CLI 版本号。 */
  readonly version: string;
  /**
   * **单渠道独立运行**时的网关默认监听地址，如 `127.0.0.1:8803`。
   *
   * 仓库级（多渠道路由）网关注册多个渠道，**不看这个字段** —— 它固定用
   * `REPO_DEFAULT_ADDR`（`127.0.0.1:4412`，见 `runtime/cli-consts.ts`）。本字段只在
   * `channels/<cid>/dist/cli.js start|serve` 这类单渠道入口里生效。
   */
  readonly defaultAddr: string;
  /** 单渠道独立运行时的控制台 API 默认端口（仓库级固定用 `defaultUiPort()`）。 */
  readonly uiPort: number;
  /** 抓包落盘目录的环境变量名，如 `CATPAW_DEBUG_DUMP`（值 `1` 表示用渠道内 `debug/`）。 */
  readonly debugDumpEnv: string;
  /**
   * 能力声明（可选）。省略 = `billing` / `signin` 都支持。
   * 无对应能力的渠道声明 false：共享层直接显示 `-`，不再调用上游。
   */
  readonly capabilities?: Partial<ChannelCapabilities>;
  /**
   * 选路权重乘数（可选，缺省 1）。
   *
   * 乘进 `priorityOf()` 的「剩余额度 × 速度 × 可靠性」—— 权重 2 表示「同样的额度，
   * 这个渠道先被用掉」。用于**额度每天刷新、不用就浪费**的渠道：它的额度是易失的，
   * 留在池里不用等于白扔，应该优先消耗，把能攒的额度（积分 / credits）留到最后。
   *
   * 为什么由渠道自己声明而不是共享层硬编码：共享层不许出现渠道知识
   * （`verify-layering` 会拦）。渠道知道自己额度是不是每天清零，共享层不知道。
   *
   * 取值建议：`2`（易失额度）/ `1`（默认）/ 不设。别设太大 —— 会盖过额度差异，
   * 让「只剩 5 额度」的渠道压过「剩 5000」的。
   */
  readonly priorityWeight?: number;
  /**
   * 选路**档位**（可选，缺省 1；**数值越小越优先**）。
   *
   * 与 `priorityWeight` 的区别是「硬」的：档位不同的渠道**永不按额度互相比较**，
   * 低档位只要还有额度就一定排在前面；额度只在**同档位内**决定先后。
   *
   * 用于「额度当天清零、且必须在别的渠道之前用掉」的渠道 —— 乘法权重做不到这一点：
   * 权重 2 遇到 2.3 倍的额度差就被翻盘（实测 loomy 1020×2 < traecn 2329×1，
   * 易失额度照样留着不用）。
   *
   * 约束：低档位渠道**全部不可用**（无额度 / 冷却 / 未登录）时才轮到高档位 ——
   * 这正是「先用完易失的，再动能攒的」。
   */
  readonly priorityTier?: number;
}

/** 读取渠道能力（缺省 true）。 */
export function channelCapabilities(config: ChannelConfig): ChannelCapabilities {
  return {
    billing: config.capabilities?.billing ?? true,
    signin: config.capabilities?.signin ?? true,
    queue: config.capabilities?.queue ?? false,
  };
}

/** 一个渠道的完整装配：配置 + 四个渠道独有模块。 */
export interface Channel {
  readonly config: ChannelConfig;
  readonly cred: CredModule;
  readonly upstream: UpstreamModule;
  readonly catalog: CatalogModule;
  readonly billing: BillingModule;
}

const registry = new Map<string, Channel>();

/** 注册（或替换）一个渠道。渠道包的 `channel.ts` 加载时调用；同 cid 重复注册即替换。 */
export function setChannel(channel: Channel): void {
  registry.set(channel.config.cid, channel);
}

/** 全部已注册渠道（按注册顺序）。 */
export function channels(): Channel[] {
  return [...registry.values()];
}

/** 按 cid 取渠道；未注册抛错。 */
export function channelFor(cid: string): Channel {
  const found = registry.get(cid);
  if (!found) {
    const known = [...registry.keys()].join(", ") || "(no channels registered)";
    throw new Error(`channel not registered: ${cid} (registered: ${known})`);
  }
  return found;
}

/**
 * 取渠道。
 *
 * - 传 `cid`：取该渠道（未注册抛错）。
 * - 不传：**仅在恰好注册了一个渠道时**返回它（单渠道模式，各渠道包的 CLI 就是这样）。
 *   注册了多个渠道时必须显式传 `cid` —— 否则无法判断请求该发给谁。
 */
export function getChannel(cid?: string): Channel {
  if (cid !== undefined) return channelFor(cid);
  if (registry.size === 0) {
    throw new Error(
      "channel not registered: import the channel package (its channel.ts calls setChannel) before using the gateway runtime",
    );
  }
  if (registry.size > 1) {
    throw new Error(
      `multi-channel routing requires an explicit cid (registered: ${[...registry.keys()].join(", ")})`,
    );
  }
  return registry.values().next().value as Channel;
}

/** 是否已注册（供测试/工具探测，不抛错）。传 cid 则判断该渠道是否已注册。 */
export function hasChannel(cid?: string): boolean {
  return cid === undefined ? registry.size > 0 : registry.has(cid);
}

/** 清空注册表（**仅供测试**：一个进程内反复注册不同渠道时用）。 */
export function clearChannels(): void {
  registry.clear();
}

/** 已注册渠道数（1 = 单渠道模式）。 */
export function channelCount(): number {
  return registry.size;
}
