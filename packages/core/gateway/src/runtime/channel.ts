/**
 * 渠道注册表：共享 gateway 层与渠道独有模块（cred / upstream / catalog / billing）之间
 * **唯一的接缝**。
 *
 * ## 为什么不直接 import
 *
 * 共享层（gateway / daemon / headless / auth-flow）不含渠道知识，但运行期要调用
 * 渠道独有的实现。现在共享模块只认这里的 `Channel` 接口；每个渠道包在入口处
 * 把自己的模块组装成一个 `Channel` 并用 `setChannel()` 注册，共享包不 import
 * 任何渠道模块。
 *
 * 渠道的**落点**（存储根、分层名、目录内文件名）不在这里决定：统一由共享层
 * `paths.ts` 按 `cid` 推导，见 docs/STORAGE-CONVENTION.md。
 *
 * ## 生命周期
 *
 * 渠道包的入口（`src/channel.ts`）在模块加载时调用 `setChannel()`；
 * 共享模块在**函数被调用时**（不是模块加载时）通过 `getChannel()` 取用，
 * 所以注册顺序只需早于第一次网络/路径操作即可。
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

/** 登录流程的界面能力（打到 stdout / 窗口状态机都可以满足）。 */
export interface LoginUi {
  setState(state: string, message?: string, url?: string): void;
  /**
   * 二维码图片 URL（可选）。扫码必须用这一张：它对应本轮长轮询的 uuid，
   * 而授权页每次加载都会生成新的 uuid。
   *
   * ⚠ 实现**不能**把它丢掉：CLI 没有观察者，丢掉就等于没给用户扫码入口
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
    },
  ): Promise<any>;
  refresh(c: any): Promise<any>;
  resolveBaseUrl(realm?: string): string;
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
  modelsUrl(cfg?: any): string;
  buildHeaders(credential: any, cfg?: any): Record<string, string>;
  /**
   * 可选：对话请求的**专用头族**（上游按整组头判定「是否官方客户端」的渠道需要）。
   *
   * 缺省时网关回退 `buildHeaders`（基础鉴权头）——普通 OpenAI 兼容渠道无需声明。
   * 实例：workbuddyai 的官方桌面端身分头族（含每轮新生的会话/请求 ID）。
   */
  buildChatHeaders?(credential: any, cfg?: any): Record<string, string>;
  /**
   * 可选：判定「非 401/403 的响应」是否也算**鉴权失败**（触发 token 刷新 + 换账号）。
   *
   * 有些上游不用标准状态码表达凭据失效 —— 如 codearts 的 APIG 网关对过期 token
   * 回 `HTTP 400 + {"error_code":"APIG.0602"}`。共享层默认只认 401/403，这类渠道
   * 声明本钩子后，其「body 里的鉴权措辞」也能走完整的刷新/转移链路。
   *
   * ⚠ 只对 **4xx 且非 401/403** 的响应调用；返回 true 时网关按 401/403 同路径处理。
   */
  isAuthFailure?(status: number, body: string): boolean;
  /**
   * 可选：上游响应头到达后允许的**连续静默上限**（毫秒），默认 `MODELMUX_READ_TIMEOUT_MS`（120s）。
   *
   * 有些上游排队/长思考时**收下请求（HTTP 200）后长时间零字节**，且不像其他渠道那样
   * 发心跳或排队错误帧 —— 固定 120s 会把还活着的上游误杀成超时。
   * 实测 Qoder 长上下文首字延迟 40–71s，排队时静默可超过 120s（见 docs/channels/qoder/PROTOCOL.md）。
   *
   * ⚠ 只放宽「连接层静默容忍」，不改变任何协议语义；声明后网关的首帧等待、
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
   * ⚠ 返回字符串的渠道不能用 `prepareChat` 钩子（那个钩子接的是对象形态的 body）。
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
   * ⚠ 参数是**网关已经建好的 body**（不是 `req`）：渠道必须基于同一个 body 做前置，
   * 否则再调一次 `buildChatBody` 会生成新的会话 id，前置与对话就指向两个会话。
   *
   * 未实现时网关直接跳过（绝大多数渠道不需要）。
   */
  prepareChat?(body: Record<string, unknown>): Promise<void>;
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
   * ⚠ 只在响应头发出前调用；返回 true 且已吐过字节时不会重试（避免重复内容）。
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
 * ⚠ **倍率不在这里**：消耗倍率统一走池层的 `PoolModelMeta.multiplier`
 * （由各渠道目录里的倍率字段汇聚而来），目录模块不承担倍率文案职责。
 */
export interface CatalogModule {
  exposedIds(): string[];
  resolveModel(name: string): string;
  /**
   * **强制**从上游重拉目录并落盘（CLI 的 `--refresh` 用）。
   *
   * 可选：只有具备「远端目录层」的渠道才实现（catpaw / codearts / lobsterai /
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
   * 已知模型规格（上下文窗口 / 最大输出 token）。
   *
   * 上游目录**通常不下发**这两个数（实测：catpaw / codearts / lobsterai / loomy /
   * qoder / qodercn 都不发）—— 网关 `/v1/models` 只能给兜底值，而 4096 的输出上限
   * 会让客户端把每次回答截到 4k。渠道按**公开规格**维护这张表（数值与来源见
   * `docs/channels/<cid>/PROTOCOL.md`），供池层透出。
   *
   * `modelId` 是对外暴露的 id（与 `exposedIds()` 返回值同形）；渠道内部负责把对外 id
   * 映射到自己的条目。**查不到返回 undefined**（= 上游与公开资料都没有，不编造）。
   */
  modelSpec?(modelId: string): { contextWindow?: number; maxOutputTokens?: number } | undefined;
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
   * 是否**每日**语义。默认 `true`；`false` 表示它不是每日签到（如 raccoon 那种
   * 一次性登录奖励）—— CLI 不会对它套"今天"的话术。
   */
  daily?: boolean;
}

/** 执行签到 / 领取的结果。 */
export interface SigninOutcome {
  ok: boolean;
  /** 人读摘要（如「签到成功，+300 积分」）。 */
  summary: string;
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
 * ⚠ **共享层不做能力探测、也不特判任何渠道**：
 * - 有端点的渠道 → 真的查 / 真的领；
 * - 没有端点的渠道 → 由**渠道自己**返回一句人读说明
 *   （`status()` 给 `claimable: false` + 说明；`claim()` 给 `ok: true` + 同句说明），
 *   不是错误、也不影响退出码。
 *
 * ⚠ `claim()` 是**写**操作（会真的领掉），实现方要保证幂等或至少可安全重复调用。
 */
export interface SigninModule {
  status(): Promise<SigninStatus>;
  claim(): Promise<SigninOutcome>;
}

/** 渠道 `billing.ts` 需要提供的接口。 */
export interface BillingModule {
  CreditsError: new (message?: string) => Error;
  /**
   * 查额度。
   *
   * `credential` 用于**按账号**查询：不传 = 当前生效账号（`cred.load()`）；
   * 传入时用它代替 `cred.load()`，并应配合 `refreshOn401: false`（避免刷新/回写
   * 当前生效账号的凭证文件）。形状见 `credential-shape.ts` 的归一化结果。
   */
  fetchCredits(options?: { refreshOn401?: boolean; credential?: unknown }): Promise<any>;
  /** 签到 / 领取能力（见 `SigninModule`；**每个渠道都必须提供**）。 */
  signin: SigninModule;
}

/** 渠道能力声明（缺省视为支持）。 */
export interface ChannelCapabilities {
  /** 是否提供额度查询。false = 无额度概念，CLI / UI 统一显示 `-`。 */
  readonly billing: boolean;
  /** 是否提供签到 / 领取。false = 无签到概念，CLI 统一显示 `-`。 */
  readonly signin: boolean;
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
   * ⚠ 仓库级（多渠道路由）网关注册多个渠道，**不看这个字段** —— 它固定用
   * `REPO_DEFAULT_ADDR`（`127.0.0.1:8787`）。本字段只在
   * `channels/<cid>/dist/cli.js start|serve` 这类单渠道入口里生效。
   */
  readonly defaultAddr: string;
  /** 单渠道独立运行时的控制台 API 默认端口（仓库级固定用 `REPO_DEFAULT_UI_PORT`）。 */
  readonly uiPort: number;
  /** 抓包落盘目录的环境变量名，如 `CATPAW_DEBUG_DUMP`（值 `1` 表示用渠道内 `debug/`）。 */
  readonly debugDumpEnv: string;
  /**
   * 能力声明（可选）。省略 = `billing` / `signin` 都支持。
   * 无对应能力的渠道声明 false：共享层直接显示 `-`，不再调用上游。
   */
  readonly capabilities?: Partial<ChannelCapabilities>;
}

/** 读取渠道能力（缺省 true）。 */
export function channelCapabilities(config: ChannelConfig): ChannelCapabilities {
  return {
    billing: config.capabilities?.billing ?? true,
    signin: config.capabilities?.signin ?? true,
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
