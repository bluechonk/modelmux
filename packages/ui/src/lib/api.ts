/**
 * 控制台 API 客户端：统一封装 `/web/api/*` 的读写。
 *
 * 关键约束：基址固定为 `<origin>/web`（单端口模式下 UI 与控制台 API 共用网关端口）。
 */

import type {
  AccessLogPage,
  ChannelInfo,
  ChannelPool,
  CommandResult,
  LogQuery,
  OverviewResponse,
  PingResult,
  PoolRow,
  UiSnapshot,
  UsageRange,
  UsageStats,
} from "./types.ts";

/**
 * 后端基地址：单端口模式下 UI 挂在网关的 `/web` 前缀下，
 * 控制台 API 相应地位于 `/web/api/*`（见 `core/gateway/src/http/console/console.ts`）。
 */
const BASE = typeof window === "undefined" ? "" : window.location.origin;
const API_BASE = `${BASE}/web`;

/** 非 2xx 的报错文案：优先取响应体里的 `error`（服务端给的具体原因），退化到状态码。 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // 非 JSON 响应体就按状态码处理
  }
  return `HTTP ${res.status}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  // GET 的错误体同样要透传：payload not found / not ready 这类具体原因
  // 比「HTTP 404」对排障有用得多，不能只让 POST/PUT 独享
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

/** `PUT` 请求（路由注册表整体写用；错误处理与 post 同口径）。 */
async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

export interface WebApi {
  getState(): Promise<UiSnapshot>;
  setTheme(mode: string): Promise<{ ok: boolean }>;
  retryLogin(): Promise<{ ok: boolean }>;
  /**
   * 访问日志查询（只读，`GET /web/api/logs`）。
   *
   * 分页由 `limit` / `offset` 驱动；返回里的 `total` 是命中筛选的总条数。
   */
  logs(query?: LogQuery): Promise<AccessLogPage>;
  /**
   * 用量统计聚合（只读，`GET /web/api/usage`）。
   *
   * 服务端逐日聚合 access 日志并缓存历史日期，前端只负责展示；区间见 `UsageRange`。
   */
  usage(range: UsageRange): Promise<UsageStats>;
  /** 仪表盘聚合视图（`GET /web/api/overview`）：一次拿到 KPI + 渠道 + 模型池 + 最近请求。 */
  overview(): Promise<OverviewResponse>;
  /**
   * ping 一个模型（`POST /web/api/ping`）：向网关自身发一次最小 chat 请求并回耗时。
   *
   * 服务端只允许回环地址，会真的花掉一次上游请求（约 1 个输出 token），并落一条访问日志。
   */
  ping(model: string): Promise<PingResult>;
  readonly commands: {
    /** 各方法返回**已解包 data 的扁平对象**（含 ok / message / error）。 */
    login(cid: string, force: boolean): Promise<CommandData>;
    status(cid?: string): Promise<CommandData>;
    /**
     * 渠道账单快照；`args.refresh = true` 时后端会先重查一遍各渠道账单
     * （控制台「刷新」按钮用）。`cid` 限定单渠道。
     */
    billing(cid?: string, args?: { refresh?: boolean }): Promise<CommandData>;
    accounts(cid?: string): Promise<CommandData>;
    activateAccount(cid: string, key: string): Promise<CommandData>;
    /**
     * 清除某账号的熔断 / 冷却标记（连败 `error` / 额度 `cooldown`）。
     *
     * 与 `activateAccount` 的区别：**不动凭证**，所以池里任何账号都能清，不只是生效那个。
     * 凭据失效（`unauthorized`）时后端拒绝并给出原因 —— 那只能重新登录。
     *
     * 界面**没有**入口（熔断与冷却都会自动恢复，见 AccountCard）；这是后端保留的调用面。
     */
    resetAccount(cid: string, key: string): Promise<CommandData>;
    removeAccount(cid: string, key: string): Promise<CommandData>;
    syncPool(cid: string): Promise<CommandData>;
    /** 模型级渠道偏好：每个对外模型的候选渠道 + 当前偏好（下拉的数据源）。 */
    modelChannels(): Promise<CommandData>;
    /** 设置 / 清除某模型的优先渠道（`cid` 传空串 = 回到自动选路）。 */
    setModelChannel(model: string, cid: string): Promise<CommandData>;
    /**
     * 提交用户粘回的回调链接（一次性 code 的兜底通道）。
     *
     * 回调页线上是 404，`code` 只在浏览器地址栏里；长轮询拿不到时靠这个完成登录。
     */
    pasteCallback(url: string): Promise<CommandData>;
    /**
     * 提交两步登录的输入（如 loomy 短信验证码）。
     *
     * 与 `pasteCallback` 同构：控制台只把字符串转交上去，不认识登录流程本身。
     */
    submitInput(value: string): Promise<CommandData>;
    /** 用户关掉了登录弹窗：让等待输入的渠道收尾（见 `ControlBridge.cancelInput`）。 */
    cancelInput(): Promise<CommandData>;
    /**
     * 一键接入：把本机客户端的模型配置改写成网关的对外模型名。
     *
     * 后端写的是各客户端自己的配置文件（写前备份），返回变更说明。
     */
    integrate(target: "zcode" | "dsh"): Promise<CommandData>;
    /**
     * 一键还原：把目标恢复成**接入前**的配置。
     *
     * 取该目标最近一次接入备份；还原前会先把当前状态再备份一份（可反悔）。
     * `restored` 是写回原内容的文件，`removed` 是接入时新建、还原时删掉的文件。
     */
    restore(target: "zcode" | "dsh"): Promise<CommandData>;
  };
}

/** 命令返回值：后端 `data` 的字段与 `ok` / `message` / `error` 平级。 */
export interface CommandData extends Record<string, unknown> {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * 统一命令载荷：`{ action, cid?, args }`。
 *
 * `args` 必须是**独立字段** —— 后端 `console.ts` 只取顶层的 `action` / `cid` / `args`，
 * 把参数字段扁平拼到顶层会被静默丢弃（登录 force、账号 key 都传不到）。
 *
 * **返回值会自动解包 `data`** —— 后端统一信封是 `{ ok, data?, message?, error? }`，
 * 调用方拿到的就是 `data`。早期版本把整个信封返回，导致各页面按 `res.channels` 读取
 * 而实际在 `res.data.channels`，表现为「（无渠道）」「（无数据）」（实测出现过）。
 */
async function command(
  action: string,
  cid: string | undefined,
  args: Record<string, unknown> = {},
): Promise<CommandData> {
  const body: Record<string, unknown> = { action, args };
  if (cid !== undefined) body["cid"] = cid;
  const envelope = (await post("/api/commands", body)) as {
    ok: boolean;
    data?: unknown;
    message?: string;
    error?: string;
  };
  const data = envelope.data;
  const merged =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  // 保留 ok / message / error，便于调用方按需读取（data 的字段与它们平级）
  return {
    ...merged,
    ok: envelope.ok,
    ...(envelope.message ? { message: envelope.message } : {}),
    ...(envelope.error ? { error: envelope.error } : {}),
  };
}

/** 拼查询串：空串与 `undefined` 一律不带上（服务端按缺省处理）。 */
function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    sp.set(key, String(value));
  }
  const text = sp.toString();
  return text === "" ? "" : `?${text}`;
}

export const api: WebApi = {
  getState: () => get("/api/state"),
  setTheme: (mode) => post("/api/theme", { mode }),
  retryLogin: () => post("/api/retry-login"),
  logs: (query = {}) =>
    get(
      `/api/logs${queryString({
        date: query.date,
        outcome: query.outcome,
        cid: query.cid,
        model: query.model,
        stream: query.stream,
        slow: query.slow === true ? 1 : undefined,
        limit: query.limit,
        offset: query.offset,
      })}`,
    ),
  usage: (range) => get(`/api/usage${queryString({ range })}`),
  ping: (model) => post("/api/ping", { model }),
  overview: () => get("/api/overview"),
  commands: {
    login: (cid, force) => command("login", cid, { force }),
    status: (cid) => command("status", cid),
    billing: (cid, args) => command("billing", cid, args ?? {}),
    accounts: (cid) => command("accounts", cid),
    activateAccount: (cid, key) => command("activateAccount", cid, { key }),
    resetAccount: (cid, key) => command("resetAccount", cid, { key }),
    removeAccount: (cid, key) => command("removeAccount", cid, { key }),
    syncPool: (cid) => command("syncPool", cid),
    modelChannels: () => command("modelChannels", undefined),
    setModelChannel: (model, cid) => command("setModelChannel", undefined, { model, cid }),
    pasteCallback: (url) => command("pasteCallback", undefined, { url }),
    /** 两步登录（如 loomy 短信验证码）：把用户在弹窗里填的内容交回去。 */
    submitInput: (value) => command("submitInput", undefined, { value }),
    /** 关闭登录弹窗：让等待输入的渠道立刻收尾，而不是挂到超时。 */
    cancelInput: () => command("cancelInput", undefined),
    integrate: (target) => command("integrate", undefined, { target }),
    restore: (target) => command("restore", undefined, { target }),
  },
};
