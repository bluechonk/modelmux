/**
 * OrcaTerm 认证：登录（腾讯云 OAuth）、凭据持久化与有效性探测。
 *
 * ## 登录协议（实测，见 channels/orcaterm/docs/PROTOCOL.md）
 *
 * 只保留**腾讯云账号**登录（One way），流程：
 *
 * CLI 自己生成 `sessionId` → 入口接受任意 `session_id` 即 302 到平台授权页
 * → 浏览器完成登录 → CLI 轮询 `POST /cgi/api OAuthExchangeToken` 换 `ot_session`。
 *
 * 只需在浏览器登录一次，CLI 自动换取 token。
 *
 * ## 铁律
 *
 * token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { credentialsPath, ensureDir, login as sharedLogin } from "@modelmux/gateway";

const { fetchWithTimeout, hostOf, decodeJwtPayload, jwtExpMs } = sharedLogin;

// ── 常量 ─────────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = "https://orcaterm.com";

/** 腾讯云开放平台给 OrcaTerm 的 app_id（客户端可见，非密钥）。 */
export const TXCLOUD_APP_ID = "100045893348";
const OAUTH_AUTHORIZE_URL = `${DEFAULT_BASE_URL}/oauth/authorize`;

/** 只读探测端点（refresh 用）。 */
export const USER_INFO_URL_DEFAULT = `${DEFAULT_BASE_URL}/cgi/v2/user/getInfo`;
const USER_INFO_URL_ENV = "ORCATERN_USER_INFO_URL";

const FETCH_TIMEOUT_MS = 30_000;
/** 等用户完成浏览器登录、轮询换 token 的上限 (10 分钟)。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 2000;
const CAPI_URL = `${DEFAULT_BASE_URL}/cgi/api`;

// ── URL 构造 ─────────────────────────────────────────────────────────────────

/** OAuth 入口 URL（带 session_id，值任意；OrcaTerm 会 302 到平台授权页）。 */
export function buildAuthEntryUrl(sessionId: string, baseUrl = DEFAULT_BASE_URL): string {
  return (
    `${baseUrl}/oauth/authorize?provider=txcloud` +
    `&source=desktop&session_id=${encodeURIComponent(sessionId)}`
  );
}

// ── 换 token ─────────────────────────────────────────────────────────────────

/** 在响应 JSON 里递归找 AccessToken。 */
export function findAccessToken(value: unknown): string {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findAccessToken(v);
      if (hit) return hit;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "AccessToken" && typeof v === "string" && v.split(".").length === 3) return v;
      const hit = findAccessToken(v);
      if (hit) return hit;
    }
  }
  return "";
}

/** 取响应里的错误描述。 */
export function exchangeError(json: unknown): string {
  const err = (json as { data?: { Response?: { Error?: { Code?: string; Message?: string } } } })?.data
    ?.Response?.Error;
  return err ? `${err.Code ?? "?"}: ${err.Message ?? ""}` : "no AccessToken in response";
}

/**
 * 用 sessionId 换 token。
 *
 * 实测：sessionId 是**我们自己生成**的那个，浏览器登录完成后即可换取；
 * 未完成/不存在时统一报 TOKEN_EXPIRED（所以轮询只能看「有没有 AccessToken」）。
 */
export async function exchangeSessionToken(
  sessionId: string,
  baseUrl = DEFAULT_BASE_URL,
): Promise<{ token: string; raw: unknown } | { error: string; raw: unknown }> {
  const res = await fetchWithTimeout(
    `${baseUrl === DEFAULT_BASE_URL ? CAPI_URL : `${baseUrl}/cgi/api`}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "OAuthExchangeToken", data: { sessionId } }),
    },
    FETCH_TIMEOUT_MS,
  );
  const json = (await res.json().catch(() => ({}))) as unknown;
  const token = findAccessToken(json);
  return token ? { token, raw: json } : { error: exchangeError(json), raw: json };
}

// ── 302 重定向解析 ───────────────────────────────────────────────────────────

/**
 * 解析入口的 302 → 平台授权页直达 URL。
 *
 * state 由 orcaterm 服务端生成（每次调用都不同），必须用服务端下发的。
 */
export async function resolvePlatformAuthorizeUrl(
  sessionId: string,
  baseUrl = DEFAULT_BASE_URL,
): Promise<string> {
  const res = await fetchWithTimeout(
    buildAuthEntryUrl(sessionId, baseUrl),
    { redirect: "manual" },
    FETCH_TIMEOUT_MS,
  );
  const loc = res.headers.get("location");
  if (!loc) throw new Error(`unexpected /oauth/authorize response (HTTP ${res.status}, no Location)`);
  return loc;
}

// ── 凭据 ──────────────────────────────────────────────────────────────────────

/** 未登录。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message = "not logged in; run `mx login orcaterm` first") {
    super(message);
  }
}

export interface Credentials {
  /** ot_session 的原文（HS256 JWT）。 */
  accessToken: string;
  /** OrcaTerm 用户 id（JWT userId）。 */
  uid: string;
  domain: string;
  provider: string;
  obtainedAt: string;
  expiresAt: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  uid: "",
  domain: "",
  provider: "txcloud",
  obtainedAt: "",
  expiresAt: "",
};

/** 解析 ot_session (JWT) → 凭据字段。 */
export function decodeOtSession(token: string, provider = "txcloud", baseUrl = DEFAULT_BASE_URL): Credentials {
  const payload = decodeJwtPayload(token);
  const uid = String(payload["userId"] ?? payload["uid"] ?? "");
  const expMs = jwtExpMs(token);
  return {
    accessToken: token,
    uid,
    domain: hostOf(baseUrl),
    provider,
    obtainedAt: sharedLogin.nowIso(),
    expiresAt: expMs > 0 ? new Date(expMs).toISOString() : "",
  };
}

/** token 指纹（脱敏）。 */
export function fingerprint(token: string): string {
  if (!token) return "(none)";
  return `${token.slice(0, 8)}…${token.slice(-4)} (len ${token.length})`;
}

// ── 落盘 ──────────────────────────────────────────────────────────────────────

export function resolveBaseUrl(): string {
  return DEFAULT_BASE_URL;
}

/** 读凭据。 */
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
    throw new NotLoggedInError(`credentials file is corrupt (${credentialsPath()}); please log in again`);
  }
  if (typeof data !== "object" || data === null) {
    throw new NotLoggedInError("credentials file has an unexpected structure; please log in again");
  }
  const rec = data as Record<string, unknown>;
  const accessToken = String(rec["accessToken"] ?? rec["access_token"] ?? "");
  if (!accessToken) throw new NotLoggedInError();
  return {
    ...EMPTY_CREDENTIALS,
    accessToken,
    uid: String(rec["uid"] ?? rec["userId"] ?? ""),
    domain: String(rec["domain"] ?? ""),
    provider: String(rec["provider"] ?? "txcloud"),
    obtainedAt: String(rec["obtainedAt"] ?? rec["obtained_at"] ?? ""),
    expiresAt: String(rec["expiresAt"] ?? rec["expires_at"] ?? ""),
  };
}

/** 原子写凭据 (0600)。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  const payload = {
    accessToken: c.accessToken,
    uid: c.uid,
    domain: c.domain,
    provider: c.provider,
    obtainedAt: c.obtainedAt || sharedLogin.nowIso(),
    expiresAt: c.expiresAt,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// ── 登录 ──────────────────────────────────────────────────────────────────────

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
}

/**
 * 腾讯云 登录：本地生成 sessionId → 打开授权页 → 轮询 OAuthExchangeToken 换 token。
 */
async function loginByTxcloud(options: LoginOptions, baseUrl: string): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  const sessionId = randomUUID();
  onStatus?.(`creating an OAuth session (${sessionId.slice(0, 8)}…)`);
  const loginUrl = await resolvePlatformAuthorizeUrl(sessionId, baseUrl);
  onUrl?.(loginUrl);
  onStatus?.("log in in the browser; this command finishes automatically once authorized");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    const result = await exchangeSessionToken(sessionId, baseUrl);
    if ("token" in result) {
      onStatus?.(`session acquired (${fingerprint(result.token)})`);
      return decodeOtSession(result.token, "txcloud", baseUrl);
    }
    if (result.error !== lastError) {
      onStatus?.(`waiting for login… (${result.error})`);
      lastError = result.error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the browser login to complete");
}

/** 登录（mx login orcaterm 的落点）。 */
export async function login(baseUrl = DEFAULT_BASE_URL, _options: LoginOptions = {}): Promise<Credentials> {
  const creds = await loginByTxcloud(_options, baseUrl);
  await save(creds);
  _options.onStatus?.(`logged in as uid=${creds.uid || "(unknown)"} (provider=txcloud)`);
  return creds;
}

// ── 续期 ─────────────────────────────────────────────────────────────────────

/** 刷新令牌：登录响应 `RefreshToken` 的固定字面值（实测，见 PROTOCOL.md §1.6）。 */
const REFRESH_TOKEN_LITERAL = "jti-based-refresh";

/**
 * 续期：`POST /cgi/api OAuthRefreshToken`，实测可用且**幂等**（同一 refreshToken
 * 可反复换取新 token，jti 不变、exp 顺延 7200s）。与桌面端 TokenManager 同一条路。
 * 契约（CONTRACT-TS §5.1/§6）：失效必须抛错。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.accessToken) throw new NotLoggedInError();
  const res = await fetchWithTimeout(
    CAPI_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `ot_session=${c.accessToken}`,
      },
      body: JSON.stringify({ action: "OAuthRefreshToken", data: { refreshToken: REFRESH_TOKEN_LITERAL } }),
    },
    FETCH_TIMEOUT_MS,
  );
  if (res.status === 401 || res.status === 403) {
    throw new NotLoggedInError("OrcaTerm session expired; run `mx relogin orcaterm`");
  }
  const json = (await res.json().catch(() => ({}))) as unknown;
  const token = findAccessToken(json);
  if (!token) throw new NotLoggedInError(`refresh rejected: ${exchangeError(json)}`);
  const next = decodeOtSession(token, c.provider || "txcloud", resolveBaseUrl());
  await save(next);
  return next;
}

/**
 * 后台预刷新：token 进入续期窗口（默认剩余 <10 分钟）时异步换一次新 token 并落盘。
 *
 * 由 `upstream.buildChatHeaders` 在每个对话请求前调用 —— 只读触发、不阻塞当前请求
 * （当前请求继续用旧 token，仍在有效期内；下一个请求 `load()` 时自然读到新的）。
 * 同一时刻只允许一次在途刷新；失败静默（下个请求再试），真失效由请求路径的
 * `upstream_auth_expired` 明确暴露。`ORCATERM_REFRESH_LEAD_MS` 可覆盖窗口（测试用）。
 */
const REFRESH_LEAD_MS = Number(process.env["ORCATERM_REFRESH_LEAD_MS"] || 10 * 60 * 1000);
let refreshInFlight: Promise<unknown> | null = null;

export function ensureFreshInBackground(c: { accessToken: string }): void {
  if (refreshInFlight || !c.accessToken) return;
  const expMs = jwtExpMs(c.accessToken);
  if (expMs <= 0 || Date.now() < expMs - REFRESH_LEAD_MS) return;
  refreshInFlight = refresh(c as Credentials)
    .catch(() => {
      /* 续期失败不打断请求；真失效由请求路径报错 */
    })
    .finally(() => {
      refreshInFlight = null;
    });
}

/**
 * 同步版预续期（网关启动探测用，auth-flow await fetchModels）：
 * token 新鲜则直接返回；进入续期窗口或已过期则换一张并落盘；换不到抛错。
 */
export async function ensureFresh(c: { accessToken: string }): Promise<void> {
  if (!c.accessToken) throw new NotLoggedInError();
  const fresh = (): boolean => {
    const expMs = jwtExpMs(c.accessToken);
    return expMs > 0 && Date.now() < expMs - REFRESH_LEAD_MS;
  };
  if (fresh()) return;
  if (refreshInFlight) {
    // 等别的请求发起的在途续期；成功后 load 路径会读到新 token，
    // 这里只保证「不重复发」，失败留给下面的自查兜底
    await refreshInFlight.catch(() => {});
    return;
  }
  await refresh(c as Credentials);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
