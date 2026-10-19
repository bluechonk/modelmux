/**
 * Raccoon（商汤小浣熊）认证：**唯一登录路径 = 授权码网页登录**（本地 HTTP 回调）、
 * 续期与凭据持久化。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/channels/raccoon/PROTOCOL.md）
 *
 * 1. **唯一登录路径是授权码网页登录**：授权页（`/code/authorize`）在非 desktop 模式
 *    （不带 `login_source`、带 `redirect=http://127.0.0.1:<port>/callback`）下会把
 *    `authorization_code` 拼到 redirect 上；CLI 起本地 HTTP 服务接住授权码，
 *    再 `POST …/login_with_authorization_code` 换 token。
 *    官方桌面端的 `login_source=desktop` + `office-raccoon://` 自定义协议作为兼容
 *    路径保留（本进程注册不了协议，浏览器没有桌面客户端时不会跳转）。
 *    ⚠ 别用 `/login/mp?code=…`：它只给官方手机 App 扫码用，网页端是死链。
 * 2. **短信登录已移除**（协议事实留在 PROTOCOL.md §2.5/§2.6，**无实现路径**）：
 *    零实测记录、结构上跑不通（`captcha_param` 在本仓拿不到）、
 *    三份参考实现零背书、历史唯一的「验证」是本机假服务替身。
 * 3. **过期时间取值优先级**：`expires_at`（显式）→ **JWT 的 `exp`**（本地 base64url
 *    解码 payload，**只解码不验签**）。回退到 JWT 是**必需的**：老凭据/手工导入的
 *    凭据可能没有 `expires_at`，只读它会让过期判定**恒为 false** → `refreshAll`
 *    永远跳过这些账号 → 「凭据悄悄过期、续期从不触发」的静默失效。
 * 4. **续期只返回新的 access_token 时必须保留旧 refresh_token** ——
 *    否则续期一次就把账号变成不可续期。HTTP 401 **或** `code === 200003` 是终态
 *    （提示重新登录，**不重试**）。
 * 5. **续期必须单飞 + 比较写回**：上游的 refresh_token **会轮换**，并发刷新里后到的
 *    会把先到的作废 ⇒ 账号变不可续期（参考实现 agent2api 有同样的单飞表）。
 * 6. **`nickname` 是服务端自动生成的默认名**（实测 `RaccoonAva`），登录**不回传**
 *    用户昵称 —— 多账号消歧要靠 `phone`（`uid` 优先 `user_id`，其次 `phone`）。
 *
 * ## 端点与基址
 *
 * 端点表与基址解析在 `upstream.ts`（渠道的「地址真相源」），本模块**单向导入**它
 * —— 不反向依赖，避免循环依赖。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

import { credentialsPath, ensureDir, login as sharedLogin } from "@modelmux/gateway";

import {
  AUTHORIZATION_CODE_NOT_FOUND,
  USER_AGENT,
  channelBaseUrl,
  exchangeCodeUrl,
  refreshUrl,
  userInfoUrl,
} from "./upstream.js";

/** 接口基址（端点表在 `upstream.ts`；框架按 `cred.DEFAULT_BASE_URL` 取值）。 */
export { DEFAULT_BASE_URL } from "./upstream.js";

/**
 * access_token 寿命约 3 小时（实测 `exp - nbf = 10805s`）。
 *
 * ⚠ 当前**没有**临期主动刷新（只在 401/403 时续期），本常量只作寿命记录。
 */
export const TOKEN_REFRESH_WINDOW_SECONDS = 300;

/** 等待用户完成网页登录的时限。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ── 网页登录（授权码）常量 ────────────────────────────────────────────────────

/** 授权页路径（官方桌面端同款）。 */
export const AUTHORIZE_PATH = "/code/authorize";
/** 官方桌面端上报的登录来源。 */
export const AUTHORIZE_LOGIN_SOURCE = "desktop";
/** 官方桌面端上报的客户端名（**不是** 网站自己的「小浣熊官网」）。 */
export const AUTHORIZE_APPNAME = "办公小浣熊客户端";
/** 回调深链（官方客户端注册的自定义协议；作为兼容路径保留）。 */
export const CALLBACK_SCHEME = "office-raccoon";
export const CALLBACK_HOST = "auth";
export const CALLBACK_PATH = "/callback";
/** 本地 HTTP 回调路径（非 desktop 授权页把 authorization_code 拼到这里）。 */
export const LOCAL_CALLBACK_PATH = "/callback";

const HTTP_TIMEOUT_MS = 60_000;
const NOT_LOGGED_IN_MSG = "No usable credential found, run `raccoon login` first";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 登录态已过期（终态，重试无用，必须重新登录）。 */
export class RefreshTokenExpiredError extends Error {
  override name = "RefreshTokenExpiredError";
}

/** 磁盘布局（snake_case；兼容 camelCase 读取）。 */
export interface Credentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** `user_id`（来自 JWT，字段顺序见 `jwtSubject`）优先，其次 `phone` —— 服务端 `name` 是自动生成的默认名。 */
  readonly uid: string;
  /** Raccoon 端点固定 → 恒空串。 */
  readonly domain: string;
  readonly officeIdentity: string;
  readonly userId: string;
  readonly nickname: string;
  readonly phone: string;
  /** **毫秒时间戳字符串**（显式字段优先，其次 JWT `exp` 推算）。 */
  readonly expiresAt: string;
  readonly obtainedAt: string;
  readonly source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  uid: "",
  domain: "",
  officeIdentity: "",
  userId: "",
  nickname: "",
  phone: "",
  expiresAt: "",
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/** 生成 32 位 hex 设备指纹 / 扫码 code（转发共享层原语）。 */
export function randomHex32(): string {
  return sharedLogin.randomHex(16);
}

// ── JWT / 过期判定 ────────────────────────────────────────────────────────────

/** 解码 JWT 载荷（**只解码不验签**；转发共享层原语）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  return sharedLogin.decodeJwtPayload(token);
}

/**
 * 从 JWT 取用户标识（**只解码不验签**）。
 *
 * 取值顺序：`sub` → `iss` → `user_id` / `userId` / `uid`，第一个非空者胜。
 *
 * ⚠ 三份来源的口径互不相同，故本仓不采信任何一方为定论：
 * - 本仓原实现**只取** `sub`；
 * - agent2api 取 `sid`(hex→十进制) → `iss`(hex→十进制) → `sub`/`id`/`user_id`，
 *   它的本机实测记录明确说 **`sid` 不是纯 hex（带 `w` 前缀与 `-`），真正命中的是 `iss`**
 *   （`reference/agent2api/desktop-tauri/src-tauri/server/src/server/core/providers/raccoon/jwt.rs:53-78`）`[参考]`；
 * - xiaohuanxiong2api 取 `user_id` / `userId` / `uid` / `userID`
 *   （`reference/xiaohuanxiong2api/src/internal/upstream/jwt.go:41-78`）`[参考]`。
 *
 * ⚠ agent2api 对 `iss` 还做 hex→十进制换算；本仓**只取原值** —— 真机确认哪个字段
 * 才是用户 id 之前不做换算（换错了比空值更难排查）`[推断]`。
 * 真机确认见 PROTOCOL.md「已知边界」的待验证项。
 */
export function jwtSubject(token: string): string {
  const claims = decodeJwtPayload(token);
  for (const key of ["sub", "iss", "user_id", "userId", "uid"]) {
    const value = claims[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return String(value);
  }
  return "";
}

/**
 * 过期时刻（毫秒）：**显式 `expires_at` 优先，其次 JWT 的 `exp`**。
 * 都无法解析时返回 null（**不编造**）。转发共享层原语。
 */
export function expiresAtMs(c: Credentials): number | null {
  const explicit = Number.parseInt(c.expiresAt || "0", 10);
  return sharedLogin.resolveExpiresAtMs(
    Number.isFinite(explicit) && explicit > 0 ? explicit : undefined,
    c.accessToken,
  );
}

/** 是否已过期（`expires_at` 缺失时回退 JWT `exp`；都未知则保守 false）。 */
export function isExpired(c: Credentials, leadSeconds = 0): boolean {
  return sharedLogin.isExpiredAt(expiresAtMs(c), leadSeconds * 1000);
}

// ── 业务信封 ──────────────────────────────────────────────────────────────────

/**
 * 业务信封判据（raccoon-oauth.ts:62-73）：
 * `code = record.code if isinstance(record.code, int) else (status if status >= 400 else 0)`。
 *
 * ⚠ 失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code。
 */
export function envelopeCode(payload: unknown, status: number): number {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const code = (payload as Record<string, unknown>)["code"];
    if (typeof code === "number" && Number.isFinite(code)) return code;
  }
  return status >= 400 ? status : 0;
}

/** 错误消息：`message` 与 `details` 用 `: ` 连接。 */
export function envelopeMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const rec = payload as Record<string, unknown>;
  const message = str(rec["message"]);
  const details = typeof rec["details"] === "string" ? rec["details"] : "";
  return [message, details].filter(Boolean).join(": ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 鉴权域请求头（换码 / 续期 / 用户信息）。
 *
 * ⚠ 不带 `X-Client-Platform` / `X-Client-Version` / `X-Client-Device-ID`：
 * 那三个头原先只随**已移除的短信登录**发出，全仓无其它发送方。
 * ⚠ `Authorization` 在未鉴权端点（换码 / 续期）也发（值为空串）—— 保持既有行为不变。
 */
function headers(c: Credentials, opts: { jsonBody?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${c.accessToken}`,
    "X-Org-Code": c.officeIdentity || "",
    "X-Raccoon-Language": "zh",
    "User-Agent": USER_AGENT,
  };
  if (opts.jsonBody) out["Content-Type"] = "application/json";
  return out;
}

interface ApiResult {
  status: number;
  code: number;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
}

/** 发一个业务请求并解析信封（不抛业务码错误，由调用方判定）。 */
async function apiCall(
  url: string,
  init: { method: string; body?: string; headers: Record<string, string>; timeoutMs?: number },
): Promise<ApiResult> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Request ${url} failed: ${String(err)}`);
  }
  let payload: unknown = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON（网关错误页）→ envelopeCode 按状态码推导 */
  }
  const code = envelopeCode(payload, resp.status);
  const record = isRecord(payload) ? payload : {};
  const data = isRecord(record["data"]) ? record["data"] : {};
  return { status: resp.status, code, payload: record, data };
}

// ── 网页登录（授权码） ────────────────────────────────────────────────────────

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
  /**
   * 显式注入回调 URL（测试 / 脚本）。正常 CLI 不传：login 会自动起本地 HTTP
   * 回调服务器。环境变量 `RACCOON_LOGIN_CALLBACK` 等价。
   */
  callback?: string | (() => Promise<string>);
  /**
   * 兼容旧 Web 控制台粘贴通道。正常登录由浏览器自动跳回本地回调，不再需要；
   * 仅在显式注入 callback / 环境变量模式下的 `resolveCallback` 里使用。
   */
  pasteCode?: () => string | undefined;
  /** 等待登录回调的时限（默认 5 分钟）。 */
  timeoutMs?: number;
}

/** 一次登录的 state（32 位 hex）；回调时逐字比对，防「别人的 code 换进你的账号」。 */
export function newLoginState(): string {
  return randomHex32();
}

/**
 * 授权页 URL。
 *
 * - 不传 `redirectUri`：官方 desktop 模式，回调 `office-raccoon://auth/callback`
 *   （需要桌面客户端注册协议；仅作兼容）。
 * - 传 `redirectUri`：**非 desktop 模式**，页面把 `authorization_code` 拼到该
 *   redirect 上。页面校验器只允许 `http://127.0.0.1|localhost|[::1]:<port>`，
 *   因此 CLI 用本地 HTTP 回调服务器即可自动收码。
 *
 * ⚠ 不要用 `/login/mp?code=…`：那条只给**官方手机 App 扫码**用，网页端没有该路由，
 * 浏览器打开是死链（真机踩过，见 docs/channels/raccoon/PROTOCOL.md §2.4）。
 */
export function authorizeUrl(state: string, baseOverride?: string, redirectUri?: string): string {
  const url = new URL(AUTHORIZE_PATH, channelBaseUrl({ override: baseOverride }));
  url.searchParams.set("appname", AUTHORIZE_APPNAME);
  url.searchParams.set("state", state);
  if (redirectUri) {
    url.searchParams.set("redirect", redirectUri);
  } else {
    url.searchParams.set("login_source", AUTHORIZE_LOGIN_SOURCE);
  }
  return url.toString();
}

/** 回调 URL 不合法（协议/主机/路径不对、缺 code、state 不匹配）。 */
export class LoginCallbackError extends Error {
  override name = "LoginCallbackError";
}

export interface LoginCallback {
  code: string;
  /** 是否逐字校验过 state（裸 code 兜底路径与「回调没带 state」均为 false）。 */
  stateVerified: boolean;
}

/**
 * 解析回调 URL，支持两种形态：
 *
 * - `http://127.0.0.1:<port>/callback?authorization_code=…&state=…`（本地回调，主路径）
 * - `office-raccoon://auth/callback?code=…&state=…`（桌面客户端兼容路径）
 *
 * state 的处置：带且不等 → 拒绝；没带 → 放行但标记未校验。兜底：整段文本不是 URL
 * 但像授权码时按裸 code 处理（stateVerified=false）。
 */
export function parseLoginCallback(raw: string, expectedState = ""): LoginCallback {
  const text = (raw ?? "").trim();
  if (!text) throw new LoginCallbackError("empty callback");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    if (/^[A-Za-z0-9._~-]{6,}$/.test(text)) return { code: text, stateVerified: false };
    throw new LoginCallbackError(`not a callback url: ${text.slice(0, 120)}`);
  }

  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host) || !url.port) {
      throw new LoginCallbackError(`unexpected callback origin: ${url.origin}`);
    }
    if (url.pathname !== LOCAL_CALLBACK_PATH) {
      throw new LoginCallbackError(`unexpected callback path: ${url.pathname}`);
    }
    const code = (url.searchParams.get("authorization_code") ?? url.searchParams.get("code") ?? "").trim();
    if (!code) throw new LoginCallbackError("callback has no authorization_code");
    const state = (url.searchParams.get("state") ?? "").trim();
    if (expectedState && state && state !== expectedState) {
      throw new LoginCallbackError("state mismatch: the callback belongs to another login attempt");
    }
    return { code, stateVerified: Boolean(expectedState && state === expectedState) };
  }

  if (url.protocol !== `${CALLBACK_SCHEME}:`) {
    throw new LoginCallbackError(`unexpected scheme: ${url.protocol}`);
  }
  if (url.hostname.toLowerCase() !== CALLBACK_HOST) {
    throw new LoginCallbackError(`unexpected callback host: ${url.hostname}`);
  }
  if (url.pathname !== CALLBACK_PATH) {
    throw new LoginCallbackError(`unexpected callback path: ${url.pathname}`);
  }
  const code = (url.searchParams.get("code") ?? "").trim();
  if (!code) throw new LoginCallbackError("callback has no code");
  const state = (url.searchParams.get("state") ?? "").trim();
  if (expectedState && state && state !== expectedState) {
    throw new LoginCallbackError("state mismatch: the callback belongs to another login attempt");
  }
  return { code, stateVerified: Boolean(expectedState && state === expectedState) };
}

/** 本地回调服务器：登录完成后浏览器跳回这里，CLI 自动收授权码。 */
export interface LoginCallbackServer {
  port: number;
  result: Promise<LoginCallback>;
  close: () => Promise<void>;
}

/**
 * 起本地 HTTP 回调服务器（127.0.0.1 随机端口）。
 *
 * 只接受 `/callback?authorization_code=…&state=…`；state 必须逐字匹配。
 * 成功页直接返回「登录成功」，浏览器可关闭；授权码不打印到 stdout。
 */
export function startLoginCallbackServer(
  state: string,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<LoginCallbackServer> {
  return new Promise<LoginCallbackServer>((resolveReady, rejectReady) => {
    let settle: (value: LoginCallback) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const result = new Promise<LoginCallback>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let server: Server;
    const timer = setTimeout(() => {
      fail(new Error(`waiting for raccoon login callback timed out after ${Math.round(timeoutMs / 1000)}s`));
      server?.close();
    }, timeoutMs);
    timer.unref?.();

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== LOCAL_CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const code = (url.searchParams.get("authorization_code") ?? url.searchParams.get("code") ?? "").trim();
      const gotState = (url.searchParams.get("state") ?? "").trim();
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>授权失败：回调缺少 authorization_code。</h1>");
        return;
      }
      if (gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>授权失败：state 校验不通过，请重新登录。</h1>");
        return;
      }
      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>登录成功，可以关闭此窗口了</h1>");
      settle({ code, stateVerified: true });
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      rejectReady(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number } | null)?.port ?? 0;
      resolveReady({
        port,
        result,
        close: () =>
          new Promise<void>((done) => {
            clearTimeout(timer);
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** 从 stdin 读一行（提示写 stderr —— `--json` 时 stdout 要保持干净的 JSON 流）。 */
function readLineFromStdin(prompt: string): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    rl.question(prompt, (answer) => {
      settled = true;
      rl.close();
      resolve(answer);
    });
    rl.once("close", () => {
      if (!settled) {
        settled = true;
        resolve(null); // stdin 关闭（Ctrl+C / EOF）≠ 空输入：交给调用方区分
      }
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 取回调 URL：注入值 → 环境变量 → stdin 粘贴。 */
async function resolveCallback(options: LoginOptions, timeoutMs: number): Promise<string> {
  const injected = options.callback;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  if (typeof injected === "function") {
    return withTimeout(injected(), timeoutMs, "waiting for login callback");
  }
  const env = (process.env["RACCOON_LOGIN_CALLBACK"] ?? "").trim();
  if (env) return env;
  // Web 控制台（pasteCode 轮询）与终端（stdin）双通道竞争，任一先到先用。
  const tasks: Array<Promise<string>> = [];
  const timeoutError = (): Error =>
    new Error(
      "waiting for pasted callback timed out; run raccoon login again, or paste the callback in the web console",
    );
  if (typeof options.pasteCode === "function") {
    const paste = options.pasteCode;
    tasks.push(
      (async (): Promise<string> => {
        for (;;) {
          if (Date.now() >= deadlineFor(timeoutMs)) throw timeoutError();
          const line = paste();
          const trimmed = typeof line === "string" ? line.trim() : "";
          if (trimmed) return trimmed;
          await sleep(400);
        }
      })(),
    );
  }
  if (process.stdin.isTTY || !process.stdin.readableEnded) {
    // ⚠ 空输入**重问**而不是报错：用户常见动作是「回车看看会发生什么」（真机踩过）。
    // 提示文案压成单行：源码里不出现换行转义（校验器与编辑器都更稳）。
    tasks.push(
      (async (): Promise<string> => {
        for (;;) {
          const remaining = deadlineFor(timeoutMs) - Date.now();
          if (remaining <= 0) throw timeoutError();
          const line = await withTimeout(
            readLineFromStdin(
              "Paste the ENTIRE callback url from the browser address bar (office-raccoon://auth/callback?code=…), then press Enter: ",
            ),
            remaining,
            "waiting for pasted callback",
          );
          if (line === null) {
            // stdin 已 EOF（daemon 场景）：从双通道竞争中**静默退场**（挂起不 resolve），
            // 等待 pasteCode 轮询或超时 —— 在这里抛错会让 Promise.race 提前终止，
            // 把还活着的 Web 粘贴通道一起拖死（真机踩过）。
            // 永不兑现：本通道退场，等 pasteCode 或超时
            return await new Promise<string>(() => {});
          }
          const trimmed = (line as string).trim();
          if (trimmed) return trimmed;
          process.stderr.write(
            "(empty input) Nothing was pasted. Finish the login in the browser first; the address bar will show `office-raccoon://auth/callback?code=…` — copy that whole line and paste it here. ",
          );
        }
      })(),
    );
  }
  if (tasks.length === 0) {
    throw new Error(
      "no callback provided and stdin is not interactive; run login in a terminal, set RACCOON_LOGIN_CALLBACK, or paste the callback in the web console",
    );
  }
  return await Promise.race(tasks);
}

/** 回调等待的绝对截止时刻。 */
function deadlineFor(timeoutMs: number): number {
  return Date.now() + timeoutMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 渠道特有登录指引（单行，分号分隔；CLI 与 Web 提示条共用同一句）。
 */
const RACCOON_LOGIN_GUIDE =
  "Raccoon continues automatically: 1) open the authorization URL in your browser and log in with WeChat / SMS / password; 2) the page redirects to http://127.0.0.1:<port>/callback and the CLI completes the exchange; 3) if the browser cannot reach localhost, rerun `mx login raccoon` (or use the web console).";

/**
 * 网页登录：本地回调服务器 → 授权页 → 用户登录 → 自动收授权码换凭证。
 *
 * 正常路径**不需要粘贴**：授权页在非 desktop 模式下会跳回 127.0.0.1 的本地回调，
 * 浏览器没有注册 `office-raccoon://` 自定义协议也不影响。测试 / 脚本仍可通过
 * `options.callback` 或 `RACCOON_LOGIN_CALLBACK` 注入回调 URL。
 */
export async function login(baseUrlOverride?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const state = newLoginState();

  const injected =
    options.callback !== undefined || (process.env["RACCOON_LOGIN_CALLBACK"] ?? "").trim() !== "";
  if (injected) {
    // 注入模式（测试/脚本）仍给出来源 URL，便于调用方展示；实际回调由调用方提供。
    onUrl?.(authorizeUrl(state, baseUrlOverride));
    onStatus?.(RACCOON_LOGIN_GUIDE);
    const raw = await resolveCallback(options, timeoutMs);
    const parsed = parseLoginCallback(raw, state);
    return exchangeLogin(parsed, baseUrlOverride, onStatus);
  }

  const callback = await startLoginCallbackServer(state, timeoutMs);
  try {
    const redirect = `http://127.0.0.1:${callback.port}${LOCAL_CALLBACK_PATH}`;
    const url = authorizeUrl(state, baseUrlOverride, redirect);
    // ⚠ onUrl 只发**纯 URL**：Web 快照把 auth_url 渲染成可点链接，混入指引文本会让链接
    // 打不开；渠道特有指引走 onStatus 的 message（CLI 与 Web 共用 RACCOON_LOGIN_GUIDE）。
    onUrl?.(url);
    onStatus?.(RACCOON_LOGIN_GUIDE);
    const parsed = await callback.result;
    return await exchangeLogin(parsed, baseUrlOverride, onStatus);
  } finally {
    await callback.close();
  }
}

/** 用授权码换凭证并落盘（正常回调与注入回调共用的收尾）。 */
async function exchangeLogin(
  parsed: LoginCallback,
  baseUrlOverride: string | undefined,
  onStatus?: (message: string) => void,
): Promise<Credentials> {
  if (!parsed.stateVerified) {
    onStatus?.("callback state not verified (missing state in callback); proceeding");
  }

  const result = await apiCall(exchangeCodeUrl(baseUrlOverride), {
    method: "POST",
    headers: headers(EMPTY_CREDENTIALS, { jsonBody: true }),
    body: JSON.stringify({ authorization_code: parsed.code }),
  });
  if (result.code === AUTHORIZATION_CODE_NOT_FOUND) {
    throw new Error("authorization code expired or already consumed; please run login again");
  }
  if (result.code !== 0) {
    throw new Error(`Code exchange failed: code=${result.code} ${envelopeMessage(result.payload)}`);
  }
  const accessToken = str(result.data["access_token"]);
  const refreshToken = str(result.data["refresh_token"]);
  if (!accessToken || !refreshToken) throw new Error("Code exchange response has no tokens");

  let c = credentialsFromLogin(accessToken, refreshToken, result.data, "raccoon-web");
  // 昵称/手机号只用于展示：补一次 user_info（失败不影响登录）
  try {
    const info = await fetchUserInfo(c, baseUrlOverride);
    c = {
      ...c,
      phone: str(info["phone"]) || c.phone,
      nickname: str(info["name"]) || c.nickname, // 服务端 name 是自动生成的默认名
      officeIdentity: c.officeIdentity || str(info["office_identity"]),
    };
  } catch {
    /* 失败不影响登录 */
  }
  await save(c);
  return c;
}

function credentialsFromLogin(
  accessToken: string,
  refreshToken: string,
  data: Record<string, unknown>,
  source: string,
): Credentials {
  const userId = jwtSubject(accessToken);
  return {
    ...EMPTY_CREDENTIALS,
    accessToken,
    refreshToken,
    uid: userId,
    officeIdentity: str(data["office_identity"]),
    userId,
    nickname: str(data["nickname"]),
    phone: str(data["phone"]),
    expiresAt: expiresAtMs({ ...EMPTY_CREDENTIALS, accessToken, expiresAt: "" })?.toString() ?? "",
    obtainedAt: nowIso(),
    source,
  };
}

// ── 续期 ──────────────────────────────────────────────────────────────────────

/**
 * 续期单飞表：同一 `refresh_token` 的并发刷新**只发一次**上游请求，其余等待同一结果。
 *
 * ⚠ 为什么要单飞：上游的 refresh_token **会轮换**，两次并发刷新里后到的会把先到的
 *   结果作废 ⇒ 账号变不可续期（参考实现 agent2api 有同样的单飞表：
 *   `reference/agent2api/.../providers/raccoon/credentials.rs:504-545`）`[参考]`。
 *
 * key 用 refresh_token 的 SHA-256 指纹（截断 16 hex）：**明文不进 key、不打印**。
 */
const refreshFlights = new Map<string, Promise<Credentials>>();

/** 刷新单飞 key：refresh_token 的指纹。 */
function refreshKey(refreshToken: string): string {
  return sharedLogin.sha256Hex(refreshToken).slice(0, 16);
}

/**
 * 续期：`POST {AUTH}/refresh` body `{refresh_token}`。
 *
 * - HTTP 401 **或** `code === 200003` → 终态（「登录态已过期，请重新登录」）
 * - 服务端可能**只返回新的 access_token** → **保留旧 refresh_token**
 * - 服务端不返回的附加字段（昵称、身份）也要保留
 * - **单飞**：同一 refresh_token 的并发调用只发一次请求（见 `refreshFlights`）
 * - **比较-再写**：写回前先读磁盘，盘上凭证已被换掉则**不覆盖**，改用盘上最新值
 */
export async function refresh(c: Credentials, baseOverride?: string): Promise<Credentials> {
  if (!c.refreshToken) throw new RefreshTokenExpiredError("Credential has no refresh_token, cannot refresh");
  const key = refreshKey(c.refreshToken);
  const running = refreshFlights.get(key);
  if (running) return running; // 同一 refresh_token 的并发刷新 → 等同一结果
  const task = refreshOnce(c, baseOverride);
  refreshFlights.set(key, task);
  // 本轮结束即释放表项（成功/失败都释放）⇒ 下一轮必定发起新请求
  void task
    .catch(() => {})
    .finally(() => {
      if (refreshFlights.get(key) === task) refreshFlights.delete(key);
    });
  return task;
}

/** 真正发一次刷新请求，并**比较-再写**落盘。 */
async function refreshOnce(c: Credentials, baseOverride?: string): Promise<Credentials> {
  const result = await apiCall(refreshUrl(baseOverride), {
    method: "POST",
    headers: headers(EMPTY_CREDENTIALS, { jsonBody: true }),
    body: JSON.stringify({ refresh_token: c.refreshToken }),
  });
  if (result.status === 401 || result.code === 200003) {
    throw new RefreshTokenExpiredError("Login state expired, please log in again");
  }
  if (result.code !== 0) {
    throw new Error(`Refresh failed: code=${result.code} ${envelopeMessage(result.payload)}`);
  }
  const accessToken = str(result.data["access_token"]);
  if (!accessToken) throw new Error("Refresh response has no access_token (retryable)");
  const refreshToken = str(result.data["refresh_token"]) || c.refreshToken;

  // 比较-再写：盘上凭证已被别处换掉（用户重登 / 另一轮刷新先落地）时**不覆盖**，
  // 改用盘上的最新值返回（参考实现 agent2api 同一处置：`.../raccoon/credentials.rs:689-742`）`[参考]`。
  const disk = readDiskCredentials();
  if (disk && disk.refreshToken !== c.refreshToken) return disk;

  const base = disk ?? c; // 盘上更权威（可能比内存新）
  const subject = jwtSubject(accessToken);
  const next: Credentials = {
    ...base, // 附加字段（昵称、身份）全部保留
    accessToken,
    refreshToken,
    uid: subject || base.userId || base.phone,
    userId: subject || base.userId,
    expiresAt:
      expiresAtMs({ ...base, accessToken, expiresAt: "" })?.toString() ?? base.expiresAt,
    obtainedAt: nowIso(),
  };
  await save(next);
  return next;
}

/** 读磁盘凭据；读不到（缺文件 / 损坏）返回 null（**不抛**）。 */
function readDiskCredentials(): Credentials | null {
  try {
    return load();
  } catch {
    return null;
  }
}

// ── 用户信息 ──────────────────────────────────────────────────────────────────

/** 用户信息（**失败返回空对象而不是抛错**：只用于昵称展示）。 */
export async function fetchUserInfo(
  c: Credentials,
  baseOverride?: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await apiCall(userInfoUrl(baseOverride), {
      method: "GET",
      headers: headers(c),
    });
    if (result.code !== 0) return {};
    return result.data;
  } catch {
    return {};
  }
}

/**
 * 昵称修复（启动时主动补一次）：**幂等**，已有 `phone` 就不再拉；
 * **不发写请求**（只 GET user_info），失败不阻塞启动。
 */
export async function syncProfile(c: Credentials, baseOverride?: string): Promise<Credentials> {
  if (c.phone) return c; // 已有 phone → 不再请求（幂等）
  const info = await fetchUserInfo(c, baseOverride);
  const phone = str(info["phone"]);
  const name = str(info["name"]);
  if (!phone && !name) return c;
  const next: Credentials = {
    ...c,
    phone: phone || c.phone,
    nickname: c.nickname || name, // 不覆盖已有昵称
    officeIdentity: c.officeIdentity || str(info["office_identity"]),
    uid: c.userId || phone || c.phone,
  };
  await save(next);
  return next;
}

// ── 凭据落盘 ──────────────────────────────────────────────────────────────────

/**
 * 读凭据。
 *
 * - 文件缺失 / JSON 损坏 / 缺 `access_token` → `NotLoggedInError`
 * - `expires_at` 缺失 → 由 JWT `exp` 推算（静默失效的根源，见文件头注释 3）
 * - ⚠ 旧凭据里的 `device_id` **读到了就忽略**（该字段已随短信路径移除，不再落盘也不再上行）
 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError();
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NotLoggedInError(`Credential file is corrupted (${credentialsPath()}), please log in again`);
  }
  if (!isRecord(data)) throw new NotLoggedInError("Credential file has an invalid structure, please log in again");
  const accessToken = str(data["access_token"] ?? data["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();

  const refreshToken = str(data["refresh_token"] ?? data["refreshToken"]);
  const officeIdentity = str(data["office_identity"] ?? data["officeIdentity"]);
  const userId = str(data["user_id"] ?? data["userId"]);
  const nickname = str(data["nickname"]);
  const phone = str(data["phone"]);
  const obtainedAt = str(data["obtained_at"] ?? data["obtainedAt"]);
  const expiresAt =
    str(data["expires_at"] ?? data["expiresAt"]) ||
    (expiresAtMs({ ...EMPTY_CREDENTIALS, accessToken, expiresAt: "" })?.toString() ?? "");

  return {
    accessToken,
    refreshToken,
    uid: userId || phone,
    domain: "",
    officeIdentity,
    userId,
    nickname,
    phone,
    expiresAt,
    obtainedAt,
    source: str(data["source"]),
  };
}

/** 原子写凭据（0600）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  const payload = {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    office_identity: c.officeIdentity,
    user_id: c.userId,
    nickname: c.nickname,
    phone: c.phone,
    expires_at: c.expiresAt,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** 登录基址：Raccoon 端点固定，无 realm 概念（参数仅为满足契约）。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return channelBaseUrl();
}
