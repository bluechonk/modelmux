/**
 * 控制台 API 客户端：统一封装 `/web/api/*` 的读写（演示模式下换成内存数据）。
 *
 * 关键约束：
 *  - 基址固定为 `<origin>/web`（单端口模式下 UI 与控制台 API 共用网关端口）
 *  - 演示模式由构建期常量 `__DEMO_MODE__` 判定，真实构建里该分支被静态消除
 */

import type {
  AccessLogPage,
  ChannelInfo,
  ChannelPool,
  CommandResult,
  LogQuery,
  PayloadQueryResult,
  PoolRow,
  UiSnapshot,
} from "./types";
import {
  createDemoState,
  demoAccountPools,
  demoActivate,
  demoBilling,
  demoCompleteLogin,
  demoEndLogin,
  demoLogPayload,
  demoLogin,
  demoLogs,
  demoModels,
  demoRemove,
  demoReset,
  demoSettings,
  demoStatus,
  demoSubmitLoginInput,
  type DemoState,
} from "./demo";

/**
 * 后端基地址：单端口模式下 UI 挂在网关的 `/web` 前缀下，
 * 控制台 API 相应地位于 `/web/api/*`（见 `core/gateway/src/http/console/console.ts`）。
 *
 * 演示模式（GitHub Pages 静态部署）下不走这里 —— 见 `IS_DEMO`。
 */
const BASE = typeof window === "undefined" ? "" : window.location.origin;
const API_BASE = `${BASE}/web`;

/**
 * 是否运行在演示模式。
 *
 * 由构建期注入（`vite.config.ts` 的 `define` 把 `__DEMO_MODE__` 换成字面量），
 * 所以真实构建里这段分支会被静态消除，不产生任何运行时开销。
 *
 * Pages 是纯静态托管，没有 `/web/api/*`，且网关不发 CORS、写命令有同源校验、
 * Chrome 还拦「公网页 → 127.0.0.1」—— 演示模式因此用内存数据替换 fetch。
 */
declare const __DEMO_MODE__: boolean;
const IS_DEMO = typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__;

/** 演示态（懒创建；生产构建里这段是死代码）。 */
let demoState: DemoState | null = null;
function demo(): DemoState {
  demoState ??= createDemoState();
  return demoState;
}

/** 小延迟：让界面上的 loading 态真实可见，而不是瞬间完成。 */
const DEMO_DELAY_MS = 180;
function demoLater<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), DEMO_DELAY_MS));
}


async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      // 非 JSON 响应体就按状态码处理
    }
    throw new Error(msg);
  }
  return await res.json() as T;
}

/**
 * 演示模式下的状态快照。
 *
 * 模型列表每次现算 —— 「添加账号」把渠道标记为已登录后，模型墙会立刻多出该渠道。
 */
function demoGetState(): UiSnapshot {
  return demoSettings(demo());
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
  /** 某条请求的正文抓取记录（`enabled: false` = 抓取开关没开）。 */
  logPayload(id: string, date?: string): Promise<PayloadQueryResult>;
  readonly commands: {
    /** 各方法返回**已解包 data 的扁平对象**（含 ok / message / error）。 */
    login(cid: string, force: boolean): Promise<CommandData>;
    status(cid?: string): Promise<CommandData>;
    models(cid?: string): Promise<CommandData>;
    /**
     * 渠道账单快照；`args.refresh = true` 时后端会先重查一遍各渠道账单
     * （控制台「刷新」按钮用）。`cid` 限定单渠道。
     */
    billing(cid?: string, args?: { refresh?: boolean }): Promise<CommandData>;
    accounts(cid?: string): Promise<CommandData>;
    activateAccount(cid: string, key: string): Promise<CommandData>;
    /**
     * 解除某账号的熔断状态（连败 `error` / 额度 `cooldown`）。
     *
     * 与 `activateAccount` 的区别：**不动凭证**，所以池里任何账号都能清，不只是生效那个。
     * 凭据失效（`unauthorized`）时后端拒绝并给出原因 —— 那只能重新登录。
     */
    resetAccount(cid: string, key: string): Promise<CommandData>;
    removeAccount(cid: string, key: string): Promise<CommandData>;
    syncPool(cid: string): Promise<CommandData>;
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
 * ⚠ `args` 必须是**独立字段** —— 后端 `console.ts` 只取顶层的 `action` / `cid` / `args`，
 * 把参数字段扁平拼到顶层会被静默丢弃（登录 force、账号 key 都传不到）。
 *
 * ⚠ **返回值会自动解包 `data`** —— 后端统一信封是 `{ ok, data?, message?, error? }`，
 * 调用方拿到的就是 `data`。早期版本把整个信封返回，导致各页面按 `res.channels` 读取
 * 而实际在 `res.data.channels`，表现为「（无渠道）」「（无数据）」（实测踩过）。
 */
async function command(
  action: string,
  cid: string | undefined,
  args: Record<string, unknown> = {},
): Promise<CommandData> {
  if (IS_DEMO) return (await demoCommand(action, cid, args)) as CommandData;
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
  return { ...merged, ok: envelope.ok, ...(envelope.message ? { message: envelope.message } : {}), ...(envelope.error ? { error: envelope.error } : {}) };
}

/**
 * 演示模式的动作分发：与真实 `/web/api/commands` 同形（解包后的扁平对象）。
 *
 * 每个动作只改内存状态，因此界面上的「添加账号 / 切换 / 删除 / 刷新账单」都能
 * 真实反映出来 —— 演示的是**交互流程**，不是假死截图。
 */
async function demoCommand(
  action: string,
  cid: string | undefined,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const st = demo();
  switch (action) {
    case "status":
      return { ...demoStatus(st), ok: true };
    case "models": {
      const channels = st.channels.map((ch) => {
        const ids = demoModels(st)
          .filter((m) => m.startsWith(`${ch.cid}/`))
          .map((m) => m.slice(ch.cid.length + 1));
        return { cid: ch.cid, display: ch.display, catalog: ids, pool: ids, out_of_pool: 0 };
      });
      return { channels, ok: true };
    }
    case "accounts":
      return { ...demoAccountPools(st), ok: true };
    case "billing":
      return { ...demoBilling(st), ok: true };
    case "login": {
      const target = cid ?? "";
      const res = demoLogin(st, target);
      return { ...res, ok: res.started, ...(res.started ? {} : { error: res.message }) };
    }
    case "activateAccount": {
      const key = typeof args["key"] === "string" ? args["key"] : "";
      const ok = demoActivate(st, cid ?? "", key);
      return ok ? { active: key, ok: true } : { ok: false, error: `账号 ${key} 不在池中` };
    }
    case "resetAccount": {
      const key = typeof args["key"] === "string" ? args["key"] : "";
      const res = demoReset(st, cid ?? "", key);
      return res.cleared
        ? { key, health: res.health, ok: true }
        : { key, health: res.health, ok: false, error: res.reason ?? "该账号没有需要解除的标记" };
    }
    case "removeAccount": {
      const key = typeof args["key"] === "string" ? args["key"] : "";
      const ok = demoRemove(st, cid ?? "", key);
      return ok ? { removed: key, ok: true } : { ok: false, error: `账号 ${key} 不在池中` };
    }
    case "syncPool":
      return { ok: true };
    case "pasteCallback": {
      // 演示模式：视为授权完成 —— 把流程真的走完（渠道转已登录 + 账号入池）
      const res = demoCompleteLogin(st);
      return { submitted: true, message: res.message, ok: true };
    }
    case "submitInput": {
      // 两步登录的演示：第一次提交是手机号，第二次是验证码 —— 都走完才入池。
      const res = demoSubmitLoginInput(st, String(args["value"] ?? ""));
      return { submitted: true, message: res.message, ok: true };
    }
    case "cancelInput":
      // 演示模式：直接结束这轮登录（不造账号）
      demoEndLogin(st);
      return { cancelled: true, ok: true };
    default:
      return { ok: false, error: `演示模式不支持动作 ${action}` };
  }
}

/** 演示模式下 `setTheme` / `retryLogin` 的桩。 */
async function demoNoop(): Promise<{ ok: boolean }> {
  return demoLater({ ok: true });
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
  getState: () => (IS_DEMO ? demoLater(demoGetState()) : get("/api/state")),
  setTheme: (mode) => (IS_DEMO ? demoNoop() : post("/api/theme", { mode })),
  retryLogin: () => (IS_DEMO ? demoNoop() : post("/api/retry-login")),
  logs: (query = {}) =>
    IS_DEMO
      ? demoLater(demoLogs(query))
      : get(
          `/api/logs${queryString({
            date: query.date,
            outcome: query.outcome,
            cid: query.cid,
            model: query.model,
            stream: query.stream,
            slow: query.slow === true ? 1 : undefined,
            q: query.q,
            limit: query.limit,
            offset: query.offset,
          })}`,
        ),
  logPayload: (id, date) =>
    IS_DEMO
      ? demoLater(demoLogPayload(id))
      : get(`/api/logs/payload${queryString({ id, date })}`),
  commands: {
    login: (cid, force) => command("login", cid, { force }),
    status: (cid) => command("status", cid),
    models: (cid) => command("models", cid),
    billing: (cid, args) => command("billing", cid, args ?? {}),
    accounts: (cid) => command("accounts", cid),
    activateAccount: (cid, key) => command("activateAccount", cid, { key }),
    resetAccount: (cid, key) => command("resetAccount", cid, { key }),
    removeAccount: (cid, key) => command("removeAccount", cid, { key }),
    syncPool: (cid) => command("syncPool", cid),
    pasteCallback: (url) => command("pasteCallback", undefined, { url }),
    /** 两步登录（如 loomy 短信验证码）：把用户在弹窗里填的内容交回去。 */
    submitInput: (value) => command("submitInput", undefined, { value }),
    /** 关闭登录弹窗：让等待输入的渠道立刻收尾，而不是挂到超时。 */
    cancelInput: () => command("cancelInput", undefined),
  },
};
