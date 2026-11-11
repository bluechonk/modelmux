/**
 * CodeArts（华为云码道）凭据：浏览器 OAuth2（PKCE + DPoP）登录、STS 临时凭证续期。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codearts/PROTOCOL.md）：
 *   - 登录只有 `login()` 一条路径：本地回调 + 浏览器授权页（用户在华为云页面
 *     用手机号+短信完成登录）→ 用授权码换 STS 临时凭证。
 *   - **DPoP 私钥必须与 refresh_token 一起落盘**：STS 把 refresh_token 绑定到
 *     首次换取时的 DPoP 公钥，换密钥刷新会被拒（InvalidDPoPHeader）。
 *   - `refresh()` 用 refresh_token 换新 STS 凭证；终态失效（过期 / 被拒）抛
 *     `NotLoggedInError`，由共享层提示重新登录。
 */

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";
import { readFileSync } from "node:fs";

import {
  credentialsPath,
  login as sharedLogin,
  loginFlow,
  writeJsonSecret,
} from "@modelmux/gateway";

/** 对话 + 模型网关（snap-engine）。 */
export const DEFAULT_BASE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com";
/** OAuth 门户（授权页入口，注意带 /portal）。 */
const PORTAL_HOST = "https://codearts.huaweicloud.com/portal";
/** STS 令牌服务（oauth2/tokens）。 */
const STS_HOST = "https://sts.cn-north-4.myhuaweicloud.com";
/** 官方 CodeArts Agent 插件的 OAuth client（refresh_token 与之绑定）。 */
const CLIENT_ID = "codearts-agent";
/** 本地回调路径（与官方插件一致）。 */
const REDIRECT_PATH = "/oauth/callback";
/** 插件身份（portal 要求，缺失会被拒）。 */
const PLUGIN_NAME = "snap_AIIDE";
const PLUGIN_VERSION = "5.2.0";

const TOKEN_PATH = "/v1/oauth2/tokens";

/** DPoP P-256 私钥（JWK 形态，落盘复用）。 */
interface DpopJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d: string;
}

/** 凭据（落盘形态）。 */
export interface Credentials {
  /** STS security_token —— 对话请求的 `x-auth-token`。 */
  accessToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  refreshToken: string;
  /** PKCE code_verifier（refresh 时仍要用）。 */
  codeVerifier: string;
  clientId: string;
  dpopPrivateKey: DpopJwk | null;
  /** STS 凭证过期时间（RFC3339）。 */
  expiration: string;
  obtainedAt: string;
  userId: string;
  userName: string;
  domainId: string;
  source: string;
}

/** 未登录 / 凭据失效（终态，需重新登录）。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

const EMPTY: Credentials = {
  accessToken: "",
  accessKeyId: "",
  secretAccessKey: "",
  refreshToken: "",
  codeVerifier: "",
  clientId: CLIENT_ID,
  dpopPrivateKey: null,
  expiration: "",
  obtainedAt: "",
  userId: "",
  userName: "",
  domainId: "",
  source: "",
};

function str(v: unknown): string {
  return sharedLogin.str(v);
}

/** 读凭据；不存在 / 损坏 → 抛 NotLoggedInError。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("no credentials; run `mx login codearts`");
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("credentials file is corrupted; run `mx login codearts`");
  }
  const token = str(doc["accessToken"]);
  if (!token) throw new NotLoggedInError("credentials carry no access token; run `mx login codearts`");
  return { ...EMPTY, ...doc, accessToken: token } as Credentials;
}

/** 落盘（0600，原子写）。 */
export async function save(c: Credentials): Promise<void> {
  await writeJsonSecret(credentialsPath(), c as unknown as Record<string, unknown>);
}

// ── DPoP（RFC 9449，ES256 / P-256）──────────────────────────────────────────

/** 生成一对新的 DPoP P-256 密钥（登录时用）。 */
function generateDpopJwk(): DpopJwk {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const priv = privateKey.export({ format: "jwk" }) as { d?: string };
  return {
    kty: "EC",
    crv: "P-256",
    x: pub.x ?? "",
    y: pub.y ?? "",
    d: priv.d ?? "",
  };
}

/** 用落盘的 JWK 恢复私钥对象（刷新时复用同一密钥对）。 */
function dpopPrivateKey(jwk: DpopJwk | null): KeyObject | null {
  if (!jwk || !jwk.d || !jwk.x || !jwk.y) return null;
  try {
    return createPrivateKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
  } catch {
    return null;
  }
}

/** DPoP 公钥 JWK（随证明头一起发出）。 */
function dpopPublicJwk(jwk: DpopJwk | null): { kty: string; crv: string; x: string; y: string } | null {
  if (!jwk || !jwk.x || !jwk.y) return null;
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/** 生成 DPoP 证明 JWT（htm=POST，htu=令牌端点）。 */
function signDpopProof(key: KeyObject | null, htu: string, jwk: DpopJwk | null): string | null {
  if (!key) return null;
  const pub = dpopPublicJwk(jwk);
  if (!pub) return null;
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "dpop+jwt", jwk: pub }));
  const payload = b64url(
    JSON.stringify({
      htm: "POST",
      htu,
      iat: Math.floor(Date.now() / 1000),
      jti: randomBytes(16).toString("hex"),
    }),
  );
  const input = `${header}.${payload}`;
  const sig = cryptoSign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

// ── PKCE ────────────────────────────────────────────────────────────────────

/** 生成 code_verifier + S256 challenge（`BASE64URL(SHA256(verifier))`）。 */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── 令牌端点 ─────────────────────────────────────────────────────────────────

/** oauth2/tokens 的响应（含身份与 STS 凭证）。 */
interface TokenResponse {
  user_id: string;
  user_name: string;
  domain_id: string;
  refresh_token: string;
  credentials: {
    access_key_id: string;
    secret_access_key: string;
    security_token: string;
    expiration: string;
  };
  error?: string;
  error_code?: string;
  error_msg?: string;
}

/** 终态失效判定：这些码出现即 refresh_token 已死，重试无意义。 */
function isTerminalRefreshError(code: string, msg: string): boolean {
  const c = code.toLowerCase();
  const m = msg.toLowerCase();
  return (
    c.includes("expiredrefreshtoken") ||
    c.includes("invaliddpoheader") ||
    c.includes("invalidclientid") ||
    m.includes("has been used") ||
    m.includes("invalid refresh token")
  );
}

/**
 * 向 STS 令牌端点发请求（form + DPoP 头）。
 *
 * @param form  already-encoded form body（调用方按 grant 组装）
 * @param jwk    DPoP 私钥（新凭证随机生成；刷新必须用签发的那个）
 * @returns 解析后的响应；HTTP >= 400 时抛错（终态刷新失败抛 NotLoggedInError）
 */
async function requestToken(
  form: URLSearchParams,
  jwk: DpopJwk | null,
  terminalRefresh: boolean,
): Promise<TokenResponse> {
  const url = `${STS_HOST}${TOKEN_PATH}`;
  const key = dpopPrivateKey(jwk);
  const dpop = signDpopProof(key, url, jwk);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (dpop) headers["DPoP"] = dpop;

  const resp = await sharedLogin.fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  const text = await resp.text();
  let doc: TokenResponse;
  try {
    doc = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`token endpoint returned non-JSON (HTTP ${resp.status})`);
  }
  if (resp.status >= 400) {
    const code = doc.error_code ?? "";
    const msg = doc.error_msg ?? text.slice(0, 200);
    if (terminalRefresh && isTerminalRefreshError(code, msg)) {
      throw new NotLoggedInError(`refresh_token rejected (${code || resp.status}); run \`mx login codearts\``);
    }
    throw new Error(`token endpoint HTTP ${resp.status}: ${msg}`);
  }
  if (!doc.credentials?.security_token) {
    throw new Error("token response carries no credentials");
  }
  return doc;
}

/** 授权码换凭证（登录）。 */
async function exchangeCode(code: string, verifier: string, redirectUri: string, jwk: DpopJwk): Promise<Credentials> {
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const doc = await requestToken(form, jwk, false);
  return {
    ...EMPTY,
    accessToken: doc.credentials.security_token,
    accessKeyId: doc.credentials.access_key_id,
    secretAccessKey: doc.credentials.secret_access_key,
    refreshToken: doc.refresh_token,
    codeVerifier: verifier,
    clientId: CLIENT_ID,
    dpopPrivateKey: jwk,
    expiration: doc.credentials.expiration,
    obtainedAt: sharedLogin.nowIso(),
    userId: doc.user_id,
    userName: doc.user_name,
    domainId: doc.domain_id,
    source: "codearts-oauth",
  };
}

/** 用 refresh_token 换新 STS 凭证（续期）。 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new NotLoggedInError("no refresh token; run `mx login codearts`");
  const form = new URLSearchParams({
    client_id: c.clientId || CLIENT_ID,
    code_verifier: c.codeVerifier,
    grant_type: "refresh_token",
    refresh_token: c.refreshToken,
  });
  const doc = await requestToken(form, c.dpopPrivateKey, true);
  const next: Credentials = {
    ...c,
    accessToken: doc.credentials.security_token,
    accessKeyId: doc.credentials.access_key_id,
    secretAccessKey: doc.credentials.secret_access_key,
    expiration: doc.credentials.expiration,
    obtainedAt: sharedLogin.nowIso(),
  };
  if (doc.refresh_token) next.refreshToken = doc.refresh_token;
  if (doc.user_id) next.userId = doc.user_id;
  if (doc.user_name) next.userName = doc.user_name;
  await save(next);
  return next;
}

// ── 登录（浏览器授权）────────────────────────────────────────────────────────

/** 本地回调端口（被占用时共享层会退到随机端口，调用方用返回值重算 URL）。 */
const CALLBACK_PORT = 18090;
/** 等待授权回调的超时。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  force?: boolean;
}

/** 构造门户授权链接（PKCE + 本地回调端口 + 插件身份）。 */
function buildAuthorizeUrl(port: number, challenge: string, ticketId: string): string {
  const q = new URLSearchParams({
    theme: "2",
    locale: "zh-cn",
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(port),
    code_challenge: challenge,
    code_challenge_method: "SHA-256",
    ticket_id: ticketId,
    "plugin-name": PLUGIN_NAME,
    "plugin-version": PLUGIN_VERSION,
  });
  return `${PORTAL_HOST}/authorize?${q.toString()}`;
}

/**
 * 登录：**浏览器授权，唯一路径**。
 *
 * 流程：本地回调服务器 → 打印授权链接（用户在华为云页面用手机号+短信登录）
 * → 门户带 code 回调 → 换 STS 凭证 → 落盘。
 *
 * 为什么走浏览器：华为云登录页的短信发码受 hwsiamcaptcha 保护，
 * 纯接口流必须解滑块（无 CLI 可行路径）；浏览器里由用户自己完成。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus, force = false } = options;
  void baseUrl;

  if (!force) {
    try {
      const existing = load();
      onStatus?.("复用已有的 CodeArts 凭据");
      return existing;
    } catch {
      /* 没有可复用的凭据 → 走下面的登录 */
    }
  } else {
    onStatus?.("强制重新登录（relogin）");
  }

  const callback = await loginFlow.startCallbackServer({
    port: CALLBACK_PORT,
    pathPrefix: REDIRECT_PATH,
    html: loginFlow.callbackPageHtml("ok"),
  });
  try {
    const { verifier, challenge } = pkce();
    const ticketId = sharedLogin.randomHex(16);
    const redirectUri = `http://127.0.0.1:${callback.port}${REDIRECT_PATH}`;
    const authorizeUrl = buildAuthorizeUrl(callback.port, challenge, ticketId);

    onUrl?.(authorizeUrl);
    onStatus?.(`等待授权回调（本地端口 ${callback.port}）…`);

    const flat = await callback.wait(LOGIN_TIMEOUT_MS);
    const code = str(flat["code"]);
    if (!code) {
      throw new Error("授权回调缺少 code（登录未完成或被拒绝）");
    }

    onStatus?.("正在换取 STS 凭证…");
    const jwk = generateDpopJwk();
    const creds = await exchangeCode(code, verifier, redirectUri, jwk);
    await save(creds);
    onStatus?.(`登录成功：${creds.userName || creds.userId || "(unknown)"}`);
    return creds;
  } finally {
    callback.close();
  }
}

/** 登出：只清本地凭据（上游 STS 凭证随过期自然失效）。 */
export async function logout(): Promise<void> {
  await writeJsonSecret(credentialsPath(), {} as Record<string, unknown>);
}

/** 对话域（落盘/日志用）。 */
export function resolveBaseUrl(): string {
  return DEFAULT_BASE_URL;
}

/**
 * 会话亲和 id（32 位十六进制，上游要求）。
 *
 * 按**账号**稳定（由 accessKeyId 派生）：上游对并发会话数有限额（实测 3 个），
 * 不带 chat_id 时每次请求都新建会话，几个请求就打满。chat_id 只做亲和与缓存 ——
 * 多轮语义仍由完整 messages 承载（对齐参考实现）。
 */
export function chatId(): string {
  const c = load();
  return createHash("sha256").update(`codearts-chat:${c.accessKeyId}`).digest("hex").slice(0, 32);
}

/** 供 upstream 判断是否需要续期（过期前 5 分钟）。 */
export function expiresSoon(c: Credentials, leadMs = 5 * 60 * 1000): boolean {
  if (!c.expiration) return false;
  const ms = sharedLogin.parseExpireTime(c.expiration);
  if (ms === null) return false;
  return ms - Date.now() <= leadMs;
}
