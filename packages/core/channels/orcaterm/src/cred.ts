/**
 * OrcaTerm 认证：登录（腾讯云 OAuth）、凭据持久化与有效性探测。
 *
 * 关键约束（端点/字段/实测见 docs/channels/orcaterm/PROTOCOL.md）：
 *   - 只保留腾讯云账号登录：CLI 生成 sessionId → 入口 302 到平台授权页 → 轮询换 ot_session。
 *   - 微信扫码与 GitHub 两条路只作协议事实保留在 PROTOCOL.md，本渠道不提供入口。
 *   - 后台预刷新在续期窗口内异步换 token 并落盘，不阻塞当前请求；真失效由请求路径明确暴露。
 *
 * 铁律：token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  writeJsonSecret,
} from "@modelmux/gateway";

const { fetchWithTimeout, hostOf, decodeJwtPayload, jwtExpMs } = sharedLogin;

// ── 常量 ─────────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = "https://orcaterm.com";

/** OAuth 入口（`/oauth/authorize`）：带任意 `session_id` 即 302 到平台授权页。 */
const OAUTH_AUTHORIZE_URL = `${DEFAULT_BASE_URL}/oauth/authorize`;

const FETCH_TIMEOUT_MS = 30_000;
/** 等用户完成浏览器登录、轮询换 token 的上限 (10 分钟)。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 2000;
const CAPI_URL = `${DEFAULT_BASE_URL}/cgi/api`;

// ── URL 构造 ─────────────────────────────────────────────────────────────────

/** OAuth 入口 URL（带 session_id，值任意；OrcaTerm 会 302 到平台授权页）。 */
function buildAuthEntryUrl(sessionId: string, baseUrl = DEFAULT_BASE_URL): string {
  const entry = baseUrl === DEFAULT_BASE_URL ? OAUTH_AUTHORIZE_URL : `${baseUrl}/oauth/authorize`;
  return `${entry}?provider=txcloud&source=desktop&session_id=${encodeURIComponent(sessionId)}`;
}

// ── 换 token ─────────────────────────────────────────────────────────────────

/** 在响应 JSON 里递归找 AccessToken。 */
function findAccessToken(value: unknown): string {
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
function exchangeError(json: unknown): string {
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
async function exchangeSessionToken(
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

/**
 * 取账号名（CAPI `GetUserInfo` 的 `nickName`）。
 *
 * 该端点返回 `nickName` / `username` / `userId`；实测对部分账号 `nickName`
 * 为空，此时留空 —— JWT 的 `providerUsername`（微信登录）仍是更可靠的名字来源。
 * 失败不阻塞登录。
 */
async function fetchAccountNickname(token: string, baseUrl = DEFAULT_BASE_URL): Promise<string> {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl === DEFAULT_BASE_URL ? CAPI_URL : `${baseUrl}/cgi/api`}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          Cookie: `ot_session=${token}`,
        },
        body: JSON.stringify({ action: "GetUserInfo" }),
      },
      FETCH_TIMEOUT_MS,
    );
    if (res.status !== 200) return "";
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = json["data"];
    const response = data && typeof data === "object" ? (data as Record<string, unknown>)["Response"] : undefined;
    const rec = response && typeof response === "object" ? (response as Record<string, unknown>) : undefined;
    const value = rec?.["nickName"];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  } catch {
    return "";
  }
}

// ── 302 重定向解析 ───────────────────────────────────────────────────────────

/**
 * 解析入口的 302 → 平台授权页直达 URL。
 *
 * state 由 orcaterm 服务端生成（每次调用都不同），必须用服务端下发的。
 */
async function resolvePlatformAuthorizeUrl(
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

interface Credentials {
  /** ot_session 的原文（HS256 JWT）。 */
  accessToken: string;
  /** OrcaTerm 用户 id（JWT userId）。 */
  uid: string;
  /**
   * 账号名（JWT `providerUsername`，微信登录时才有）。
   *
   * 只取 uid 的话，Web 账号池只能显示脱敏 uid；该声明是 JWT 里已有的
   * 可读名称，取不到留空。
   */
  nickname: string;
  domain: string;
  provider: string;
  obtainedAt: string;
  expiresAt: string;
  /**
   * lightai 域的 sid cookie（可选）。
   *
   * 对话端点的 API 会话层票据：[参考] orca.go 的 oauth 分支会带上它，
   * 但上游在缺失时会自动发放 —— 故没有也不影响对话。
   */
  sid: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  uid: "",
  nickname: "",
  domain: "",
  provider: "txcloud",
  obtainedAt: "",
  expiresAt: "",
  sid: "",
};

/** 解析 ot_session (JWT) → 凭据字段。 */
function decodeOtSession(
  token: string,
  provider = "txcloud",
  baseUrl = DEFAULT_BASE_URL,
  sid = "",
): Credentials {
  const payload = decodeJwtPayload(token);
  const uid = String(payload["userId"] ?? payload["uid"] ?? "");
  const expMs = jwtExpMs(token);
  return {
    accessToken: token,
    uid,
    // 账号名：微信登录的 JWT 带 providerUsername；其它 provider 没有则留空
    nickname: jwtNickname(token),
    domain: hostOf(baseUrl),
    provider,
    obtainedAt: sharedLogin.nowIso(),
    expiresAt: expMs > 0 ? new Date(expMs).toISOString() : "",
    sid,
  };
}

/**
 * 从 JWT 载荷提取账号名。
 *
 * 微信登录的 `ot_session` 带 `providerUsername`（微信昵称），其余 provider 没有；
 * 账号信息端点（`GetUserInfo`）虽然也返回 `nickName`，但它要额外一次请求，
 * 且对当前账号可能为空 —— JWT 是登录链路里已经拿到的东西，优先用它。
 */
function jwtNickname(token: string): string {
  const payload = decodeJwtPayload(token);
  for (const key of ["providerUsername", "nickname", "nickName", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** token 指纹（脱敏）。 */
function fingerprint(token: string): string {
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
  const creds: Credentials = {
    ...EMPTY_CREDENTIALS,
    accessToken,
    uid: String(rec["uid"] ?? rec["userId"] ?? ""),
    nickname: String(rec["nickname"] ?? ""),
    domain: String(rec["domain"] ?? ""),
    provider: String(rec["provider"] ?? "txcloud"),
    obtainedAt: String(rec["obtainedAt"] ?? rec["obtained_at"] ?? ""),
    expiresAt: String(rec["expiresAt"] ?? rec["expires_at"] ?? ""),
    sid: String(rec["sid"] ?? ""),
  };
  // 老凭据没有 nickname → 从 JWT 补一次并落盘。
  // 只在缺名字时写，写一次之后读到就有值，不会变成每请求一次 I/O。
  if (!creds.nickname) {
    const nickname = jwtNickname(creds.accessToken);
    if (nickname) {
      creds.nickname = nickname;
      writeJsonSecret(credentialsPath(), creds);
    }
  }
  return creds;
}

/**
 * 原子写凭据 (0600)。
 *
 * 写法统一走共享层 `writeJsonSecret`（tmp → rename → 0600），不再各写一遍。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const payload = {
    accessToken: c.accessToken,
    uid: c.uid,
    nickname: c.nickname,
    domain: c.domain,
    provider: c.provider,
    obtainedAt: c.obtainedAt || sharedLogin.nowIso(),
    expiresAt: c.expiresAt,
    sid: c.sid,
  };
  writeJsonSecret(credentialsPath(), payload);
}

// ── 登录 ──────────────────────────────────────────────────────────────────────

interface LoginOptions {
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
      const creds = decodeOtSession(result.token, "txcloud", baseUrl);
      // 账号名：JWT 声明优先（微信登录才有），CAPI nickName 兜底
      const nickname = creds.nickname || (await fetchAccountNickname(result.token, baseUrl));
      return { ...creds, nickname };
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
  const next = decodeOtSession(token, c.provider || "txcloud", resolveBaseUrl(), c.sid);
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
