/**
 * WorkBuddy 国内版凭据：浏览器设备登录、持久化与令牌刷新。
 *
 * 关键约束（端点/字段/实测见 docs/channels/workbuddy/PROTOCOL.md）：
 *   - 登录只有 `login()` 一条路径（网页设备授权），不提供第二种登录方式（手机号 OneID / 桌面端 `.info` 路线均不采纳）。
 *   - 设备授权无本机回环：`pasteCode` 只作「浏览器已完成」信号，转交同一轮询处理器再取一次令牌。
 *   - 本渠道只有一个域（国内版 `codebuddy.ai`），账号属于哪个域就用哪个渠道登录。
 */

import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  pasteDetect,
  writeJsonSecret,
} from "@modelmux/gateway";

/** 登录基址（国内版 CodeBuddy）。 */
export const DEFAULT_BASE_URL = "https://copilot.tencent.com";

/** 向插件端点标识本客户端。 */
const PLATFORM_QS = "platform=workbuddy";

/** 轮询窗口：官方客户端口径 300s（`[参考]` hub docs/protocol-reference.md:2164-2167）。 */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
/** 轮询间隔：官方客户端口径 1000ms（同上）。 */
const POLL_INTERVAL_MS = 1000;
const MAX_LOGIN_ROUNDS = 2;
const HTTP_TIMEOUT_MS = 30_000;

const NOT_LOGGED_IN_MSG = "no credentials found; start the gateway to log in";

/** 磁盘上不存在可用凭证。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** credentials.json 的磁盘布局。JSON 字段名与 Go 版一致（camelCase）。 */
export interface Credentials {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  sessionState: string;
  domain: string;
  uid: string;
  /** 企业 ID（账号档案端点给）；空 = 个人账号。 */
  enterpriseId: string;
  /** 昵称（账号档案端点给）；仅展示用。 */
  nickname: string;
  expiresIn: string;
  expiresAt: unknown;
  refreshExpiresIn: string;
  refreshExpiresAt: unknown;
  obtainedAt: string;
  source: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  tokenType: "",
  scope: "",
  sessionState: "",
  domain: "",
  uid: "",
  enterpriseId: "",
  nickname: "",
  expiresIn: "",
  expiresAt: null,
  refreshExpiresIn: "",
  refreshExpiresAt: null,
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语，见 `@modelmux/gateway` 的 `login.ts`）。 */
const str = sharedLogin.str;

/**
 * 解析登录基址。
 *
 * 国内版**只有一个域**，`realm` 参数仅作兼容保留（共享层 CLI 会传进来）。
 */
export function resolveBaseUrl(_realm = "auto"): string {
  return DEFAULT_BASE_URL;
}

/** 从 base URL 提取主机名（转发共享层原语）。 */
function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/** 从 JWT 载荷提取 sub 声明（转发共享层原语）。 */
function jwtSub(token: string): string {
  return sharedLogin.jwtSubject(token);
}

/**
 * 从 JWT 载荷提取账号名（档案端点的 `nickname` 可能为空）。
 *
 * 档案端点带一次性 `state`，登录后无法重放；而 JWT 在登录链路里已经拿到，
 * 缺名字时从声明里取，避免 Web 只能显示脱敏 uid。
 *
 * 取值优先级：`nickname` → `name` → `given_name` → 邮箱/`preferred_username` 的
 * `@` 前本地部分（域名不是账号标识）→ `preferred_username`。
 */
function jwtNickname(token: string): string {
  const claims = sharedLogin.decodeJwtPayload(token);
  const pick = (key: string): string => {
    const value = claims[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };
  for (const key of ["nickname", "name", "given_name"]) {
    const value = pick(key);
    if (value) return value;
  }
  for (const key of ["email", "preferred_username"]) {
    const value = pick(key);
    if (!value) continue;
    const at = value.indexOf("@");
    if (at > 0) return value.slice(0, at);
  }
  return pick("preferred_username");
}

/** 当前时间的 RFC3339 字串（转发共享层原语）。 */
const nowRfc3339 = sharedLogin.nowIso;

/**
 * 从磁盘读取凭证。
 *
 * 文件缺失 / JSON 损坏 / accessToken 为空时一律抛 NotLoggedInError。
 * uid 为空时从 JWT sub 提取补上。
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
    throw new NotLoggedInError();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new NotLoggedInError();
  const rec = data as Record<string, unknown>;
  const c: Credentials = {
    accessToken: str(rec["accessToken"]),
    refreshToken: str(rec["refreshToken"]),
    tokenType: str(rec["tokenType"]),
    scope: str(rec["scope"]),
    sessionState: str(rec["sessionState"]),
    domain: str(rec["domain"]),
    uid: str(rec["uid"]),
    enterpriseId: str(rec["enterpriseId"]),
    nickname: str(rec["nickname"]),
    expiresIn: str(rec["expiresIn"]),
    expiresAt: rec["expiresAt"] ?? null,
    refreshExpiresIn: str(rec["refreshExpiresIn"]),
    refreshExpiresAt: rec["refreshExpiresAt"] ?? null,
    obtainedAt: str(rec["obtainedAt"]),
    source: str(rec["source"]),
  };
  if (!c.accessToken) throw new NotLoggedInError();
  if (!c.uid) c.uid = jwtSub(c.accessToken);
  // 老凭据没有 nickname（档案端点当时返回空）→ 从 JWT 补一次并落盘。
  // 只在缺名字时写，写一次之后读到就有值，不会变成每请求一次 I/O。
  if (!c.nickname) {
    const nickname = jwtNickname(c.accessToken);
    if (nickname) {
      c.nickname = nickname;
      writeJsonSecret(credentialsPath(), c);
    }
  }
  return c;
}

/**
 * 以 0600 权限写入凭证文件（Windows 上 chmod 意义有限，仍保持一致）。
 *
 * 先写临时文件再原子替换：写入过程崩溃不会留下半截 JSON 导致凭证损坏。
 * 写法统一走共享层 `writeJsonSecret`（tmp → rename → 0600），不再各写一遍。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), c);
}

/** 账号档案（`/v2/plugin/login/account` 的 data 字段）。 */
interface AccountProfile {
  uid: string;
  enterpriseId: string;
  nickname: string;
}

const EMPTY_PROFILE: AccountProfile = { uid: "", enterpriseId: "", nickname: "" };

function fromToken(
  access: string,
  refresh: string,
  tokenType: string,
  scope: string,
  session: string,
  domain: string,
  profile?: AccountProfile,
): Credentials {
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: access,
    refreshToken: refresh,
    tokenType,
    scope,
    sessionState: session,
    domain,
    uid: profile?.uid || jwtSub(access),
    enterpriseId: profile?.enterpriseId ?? "",
    // 档案端点的 nickname 可能为空 → 回落 JWT 声明（见 jwtNickname）
    nickname: profile?.nickname?.trim() || jwtNickname(access),
    obtainedAt: nowRfc3339(),
    source: "workbuddy-login-poll",
  };
}

/**
 * 插件端点的通用头（Origin / Referer / UA 等）。
 *
 * ⚠ 登录期 UA 用的是桌面三段式，与参考实现的 CLI 形态不一致 —— 未验证，
 * 登记在 `docs/channels/workbuddy/PROTOCOL.md`「已知边界」，**本轮不改**。
 */
function commonHeaders(): Record<string, string> {
  return {
    // reference cmd/login 的 commonHeaders：Origin/Referer 缺失上游会拒（CN 是 codebuddy.cn 站点域）
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: "https://codebuddy.cn",
    Referer: "https://codebuddy.cn/",
    "User-Agent": "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1",
  };
}

/**
 * 把请求标记为匿名（未鉴权）的插件端点头。
 *
 * 官方客户端在授权完成前必须带这四个抑制头（值均为字符串 `"true"`），
 * 否则会被判成「未授权访问受保护接口」（`[参考]` hub
 * docs/protocol-reference.md:2165-2167）。
 */
function anonHeaders(): Record<string, string> {
  return {
    ...commonHeaders(),
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
}

function anyToStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function unixAfter(startMs: number, value: unknown): number | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    seconds = parsed;
  } else return null;
  return Math.trunc(startMs / 1000 + seconds);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = HTTP_TIMEOUT_MS, ...rest } = init;
  return sharedLogin.fetchWithTimeout(url, rest, timeoutMs);
}

async function createLoginState(
  baseUrl: string,
): Promise<Record<string, unknown>> {
  const resp = await fetchWithTimeout(`${baseUrl}/v2/plugin/auth/state?${PLATFORM_QS}`, {
    method: "POST",
    body: "{}",
    headers: { ...anonHeaders(), "Content-Type": "application/json" },
  });
  if (resp.status !== 200) throw new Error(`create login link: HTTP ${resp.status}`);
  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`create login link: invalid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0 || !env["data"]) {
    throw new Error(
      `failed to create login link: code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`,
    );
  }
  const state = env["data"] as Record<string, unknown>;
  if (!state["state"]) throw new Error("login state is empty");
  return state;
}

/**
 * 轮询取令牌。
 *
 * 粘贴兜底：设备授权**没有本机回环**（令牌由服务端按 `state` 下发），
 * 故粘回的内容只作「浏览器那一步已完成」的信号 —— 转交**同一个轮询处理器**
 * 立刻再取一次，不是第二条登录路径。
 */
async function pollToken(
  baseUrl: string,
  state: string,
  options: LoginOptions = {},
): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  let pasteReported = false;
  while (Date.now() < deadline) {
    // 粘贴兜底：认「授权被拒」的措辞（立刻收尾），否则当作「浏览器那步已完成」。
    // 措辞识别是**渠道无关**的通用启发式（见共享层 auth/paste-detect.ts）：
    // 认出就立刻结束等待，不白等 5 分钟。
    const pasted = options.pasteCode?.();
    if (typeof pasted === "string" && pasted.trim()) {
      const reason = pasteDetect.pastedAuthFailureReason(pasted);
      if (reason) throw new Error(`browser authorization failed: ${reason}`);
      if (!pasteReported) {
        options.onStatus?.("got the pasted callback, fetching the token now...");
        pasteReported = true;
      }
    }
    try {
      const resp = await fetchWithTimeout(url, { headers: anonHeaders() });
      if (resp.status === 200) {
        const env = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (env && env["code"] === 0 && env["data"]) {
          const data = env["data"] as Record<string, unknown>;
          if (data["accessToken"]) return data;
        }
      }
    } catch {
      /* 轮询失败下一轮再试 */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
  /**
   * 取走用户粘回的浏览器回调内容（可选，一次性消费）。
   *
   * 设备授权**没有本机回环**（令牌由服务端按 `state` 下发），故粘回的内容只作
   * 「浏览器那一步已完成」的信号 —— 转交**同一个轮询处理器**立刻再取一次令牌。
   */
  pasteCode?: () => string | undefined;
}

/**
 * 取账号档案：`GET {base}/v2/plugin/login/account?state=<state>`（带 Bearer）。
 *
 * 这是**登录链路内的最后一步**，不是第二条登录路径：拿的是同一次授权对应的
 * 账号身份（uid / enterpriseId / nickname），拿不到也不影响登录成功 ——
 * uid 仍可从 JWT `sub` 提取。
 *
 * 参考 go `cmd/login/main.go:266-278`、panel `cmd/login/main.go:273`。
 */
async function fetchAccountProfile(
  baseUrl: string,
  state: string,
  accessToken: string,
): Promise<AccountProfile> {
  if (!accessToken) return EMPTY_PROFILE;
  const url = `${baseUrl}/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
  try {
    const resp = await fetchWithTimeout(url, {
      headers: { ...commonHeaders(), Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status !== 200) return EMPTY_PROFILE;
    const env = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!env || env["code"] !== 0 || !env["data"]) return EMPTY_PROFILE;
    const data = env["data"] as Record<string, unknown>;
    return {
      uid: str(data["uid"]),
      enterpriseId: str(data["enterpriseId"]),
      nickname: str(data["nickname"]),
    };
  } catch {
    // 档案拿不到不是登录失败：uid 回落 JWT sub，其余字段留空。
    return EMPTY_PROFILE;
  }
}

/** 运行交互式浏览器登录并持久化结果。 */
export async function login(baseUrl: string, options: LoginOptions = {}): Promise<Credentials> {
  const base = baseUrl || DEFAULT_BASE_URL;
  const { onUrl, onStatus } = options;

  for (let round = 1; round <= MAX_LOGIN_ROUNDS; round += 1) {
    const state = await createLoginState(base);
    let authUrl = str(state["authUrl"]);
    if (!authUrl) {
      authUrl = `${base}/login?${PLATFORM_QS}&state=${encodeURIComponent(str(state["state"]))}`;
    }
    onUrl?.(authUrl);
    onStatus?.(
      `Round ${round}/${MAX_LOGIN_ROUNDS}: waiting for authorization ` +
        `(open the URL above in a browser; up to ${LOGIN_WINDOW_MS / 60000} min)…` +
        (options.pasteCode
          ? " — after signing in you can paste the address bar back here to fetch the token immediately."
          : ""),
    );
    const stateId = str(state["state"]);
    const token = await pollToken(base, stateId, options);
    if (!token) {
      onStatus?.(`Round ${round} timed out, retrying…`);
      continue;
    }
    const accessToken = str(token["accessToken"]);
    // 账号档案：登录链路内的最后一步（拿 uid / enterpriseId / nickname）。
    const profile = await fetchAccountProfile(base, stateId, accessToken);
    const c = fromToken(
      accessToken,
      str(token["refreshToken"]),
      str(token["tokenType"]),
      str(token["scope"]),
      str(token["sessionState"]),
      str(token["domain"]),
      profile,
    );
    if (!c.domain) c.domain = hostOf(base);
    c.expiresIn = anyToStr(token["expiresIn"]);
    c.refreshExpiresIn = anyToStr(token["refreshExpiresIn"]);
    const now = Date.now();
    c.expiresAt = unixAfter(now, token["expiresIn"]);
    c.refreshExpiresAt = unixAfter(now, token["refreshExpiresIn"]);
    await save(c);
    return c;
  }
  throw new Error(`no login detected after ${MAX_LOGIN_ROUNDS} attempt(s)`);
}

/** 用存储的刷新令牌换取新的访问令牌。失败由调用方回退到交互登录。
 *
 * 端点与鉴权形态按 hub 实测（`wb_accounts.py` 的 `_refresh_locked`，cn 的
 * refresh 也打在 chat 上游 copilot.tencent.com）：路径带 `/token/` 段，
 * 令牌走 `X-Refresh-Token` 头、请求体为空对象；来源头 cn 为 `workbuddy`。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("no refresh token available");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "X-Refresh-Token": c.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
    "X-User-Id": c.uid,
    "X-Domain": c.domain || "copilot.tencent.com",
    "X-CodeBuddy-Request": "1",
  };
  // 企业账号的刷新同样要带企业身份头（go internal/upstream/headers.go:437-439）。
  if (c.enterpriseId) headers["X-Enterprise-Id"] = c.enterpriseId;
  const resp = await fetchWithTimeout("https://copilot.tencent.com/v2/plugin/auth/token/refresh", {
    method: "POST",
    body: "{}",
    headers,
  });
  if (resp.status !== 200) throw new Error(`refresh failed: HTTP ${resp.status}`);
  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`refresh: invalid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0 || !env["data"]) {
    throw new Error(`refresh failed: code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`);
  }
  const token = env["data"] as Record<string, unknown>;
  if (!token["accessToken"]) throw new Error("refresh returned an empty access token");

  const or = (value: unknown, fallback: string): string => {
    const s = typeof value === "string" ? value : anyToStr(value);
    return s || fallback;
  };
  const next = fromToken(
    str(token["accessToken"]),
    or(token["refreshToken"], c.refreshToken),
    or(token["tokenType"], c.tokenType),
    or(token["scope"], c.scope),
    or(token["sessionState"], c.sessionState),
    or(token["domain"], c.domain),
    // 刷新响应不带账号档案：沿用旧值，别把企业身份与昵称丢掉。
    { uid: c.uid, enterpriseId: c.enterpriseId, nickname: c.nickname },
  );
  const now = Date.now();
  next.expiresIn = anyToStr(token["expiresIn"]);
  next.refreshExpiresIn = anyToStr(token["refreshExpiresIn"]);
  next.expiresAt = unixAfter(now, token["expiresIn"]);
  next.refreshExpiresAt = unixAfter(now, token["refreshExpiresIn"]);
  if (!next.uid) next.uid = c.uid;
  if (!next.domain) next.domain = c.domain || hostOf(DEFAULT_BASE_URL);
  await save(next);
  return next;
}
