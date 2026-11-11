/**
 * Today（国内版 todayai.cn）认证：手机号 + 短信验证码登录 → 会话票换 JWT → 凭据落盘与续期。
 *
 * 关键约束（端点/字段/实测见 docs/channels/todayai/PROTOCOL.md）：
 *   - 手机号**必须带国家码**（`+86…`），裸 11 位被判 `INVALID_PHONE_NUMBER`；两跳登录，
 *     会话票取 verify 响应的 **`Set-Cookie` 签名形态**（裸 `token` 换票会 401）。
 *   - 换票 `POST {app}/api/token` 要带 Cookie 与 `X-App-Version`/`X-Client-Platform`。
 *
 * 铁律：token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  writeJsonSecret,
  type Credential,
} from "@modelmux/gateway";

const { str } = shared;
const { fetchWithTimeout } = shared;

/** 站点（登录 / 换票）与 API 域：同源站承载 better-auth 与换票，API 域承载对话。 */
export const APP_HOST = "https://todayai.cn";
export const API_HOST = "https://api.todayai.cn";

/** 契约要求 `cred` 模块导出 `DEFAULT_BASE_URL`（登录与上游共用的默认基址）。 */
export const DEFAULT_BASE_URL = APP_HOST;

/** 换票 audience 必须是 API 域（跟着 API 域名走，写死会让 JWT 被拒）。 */
const TOKEN_AUDIENCE = API_HOST;

/** 身份头（客户端无条件注入，缺了会掉 legacy 分支）。 */
export const APP_VERSION = "1.24.0";
export const CLIENT_PLATFORM = "windows-client";

const SEND_OTP_PATH = "/api/auth/phone-number/send-otp";
const VERIFY_PATH = "/api/auth/phone-number/verify";
const TOKEN_PATH = "/api/token";
const CONFIG_PATH = "/v1/config";
const ME_PATH = "/v1/users/me";

const HTTP_TIMEOUT_MS = 60_000;

/** 会话票声明有效期 60 天（上游 Set-Cookie `Max-Age=5184000`，响应不带到期时间）。 */
const SESSION_TTL_MS = 5_184_000_000;

const NOT_LOGGED_IN_MSG = "no usable credentials found; run `todayai login` first";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  /** 会话票（`__Secure-better-auth.session_token` 的值，60 天）。 */
  readonly sessionToken: string;
  /** 换出来的 JWT（1 小时），发上游请求用。 */
  readonly accessToken: string;
  readonly phone: string;
  readonly nickname: string;
  /** 主对话 id（`/v1/config`），发消息用 `isMainChat:true` 时不需要它，续期时会刷新。 */
  readonly mainConversationId: string;
  /** JWT 到期时刻（毫秒时间戳字符串）；会话票到期由 `obtainedAt` + 60 天本地推算。 */
  readonly expireAt: string;
  readonly obtainedAt: string;
}

const EMPTY: Credentials = {
  accessToken: "",
  uid: "",
  domain: "",
  sessionToken: "",
  phone: "",
  nickname: "",
  mainConversationId: "",
  expireAt: "",
  obtainedAt: "",
};

/** 指纹（日志用）：只给前 4 后 4，中间打码。 */
function fingerprint(token: string): string {
  if (!token) return "-";
  if (token.length <= 10) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}(${token.length})`;
}

/** 取值收窄（转发共享层原语）。 */
function num(value: unknown): number | null {
  return shared.parseExpireTime(value);
}

/**
 * 会话票是否已过期。
 *
 * 上游不给会话票到期时间，按**登录时刻 + 60 天**本地推算（实测有效期）。
 * JWT 到期走 `expireAt`（换票响应里带）。
 */
function sessionExpired(c: Credentials): boolean {
  const obtained = Number.parseInt(c.obtainedAt || "0", 10);
  if (!obtained) return false;
  return Date.now() > obtained + SESSION_TTL_MS;
}

export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `todayai login` to authorize with your phone");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const sessionToken = str(parsed["sessionToken"]);
  if (!sessionToken) throw new NotLoggedInError("Credential has no session token, please log in again");
  const uid = str(parsed["uid"]);
  return {
    accessToken: str(parsed["accessToken"]),
    uid,
    domain: str(parsed["domain"]) || "todayai.cn",
    sessionToken,
    phone: str(parsed["phone"]),
    nickname: str(parsed["nickname"]),
    mainConversationId: str(parsed["mainConversationId"]),
    expireAt: str(parsed["expireAt"]),
    obtainedAt: str(parsed["obtainedAt"]),
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断「已登录」）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), credential);
}

export function resolveBaseUrl(_realm?: string): string {
  return APP_HOST;
}

// ── 上游请求 ────────────────────────────────────────────────────────────────

interface HttpResult {
  status: number;
  body: string;
  setCookies: string[];
}

/** JSON POST（带 Cookie 与身份头）；返回原文 + Set-Cookie（登录要拿会话票）。 */
async function postJson(url: string, body: unknown, cookie?: string): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: APP_HOST,
    "X-App-Version": APP_VERSION,
    "X-Client-Platform": CLIENT_PLATFORM,
  };
  if (cookie) headers["Cookie"] = cookie;
  const resp = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) }, HTTP_TIMEOUT_MS);
  return {
    status: resp.status,
    body: await resp.text(),
    setCookies: resp.headers.getSetCookie ? resp.headers.getSetCookie() : [],
  };
}

/** GET（带 bearer 与身份头）。 */
async function getJson(url: string, token: string): Promise<HttpResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-App-Version": APP_VERSION,
    "X-Client-Platform": CLIENT_PLATFORM,
  };
  const resp = await fetchWithTimeout(url, { method: "GET", headers }, HTTP_TIMEOUT_MS);
  return { status: resp.status, body: await resp.text(), setCookies: [] };
}

/** 从 Set-Cookie 里取某个 cookie 的值（拿不到返回空串）。 */
function cookieValue(setCookies: string[], name: string): string {
  for (const sc of setCookies) {
    const first = sc.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq > 0 && first.slice(0, eq).trim() === name) return first.slice(eq + 1).trim();
  }
  return "";
}

// ── 登录 ────────────────────────────────────────────────────────────────────

interface LoginOptions {
  onStatus?: (msg: string) => void;
  /** 两步登录的输入来源（控制台提供；CLI 不传则回落环境变量）。 */
  requestInput?: (req: { kind: "phone" | "code"; prompt: string }) => Promise<string | undefined>;
  force?: boolean;
}

const PHONE_ENV = "TODAYAI_PHONE";
const SMS_CODE_ENV = "TODAYAI_SMS_CODE";

/** 手机号归一：裸 11 位补 `+86`，已带国家码原样保留。 */
function normalizePhone(raw: string): string {
  const phone = raw.trim();
  if (phone.startsWith("+")) return phone;
  if (/^86\d{11}$/.test(phone)) return `+${phone}`;
  if (/^\d{11}$/.test(phone)) return `+86${phone}`;
  return phone;
}

/** 发码（第一步）。 */
export async function sendOtp(phone: string): Promise<void> {
  const res = await postJson(`${APP_HOST}${SEND_OTP_PATH}`, { phoneNumber: phone });
  if (res.status !== 200) {
    let detail = res.body.slice(0, 160);
    try {
      const j = JSON.parse(res.body) as { code?: string; message?: string };
      if (j.code) detail = `${j.code}: ${j.message ?? ""}`;
    } catch {
      /* 非 JSON 就用原文 */
    }
    throw new Error(`发送验证码失败（HTTP ${res.status}）${detail}`);
  }
}

/** 校验（第二步）：换会话票 + 用户信息。 */
export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ sessionToken: string; uid: string; nickname: string }> {
  const res = await postJson(`${APP_HOST}${VERIFY_PATH}`, { phoneNumber: phone, code });
  if (res.status !== 200) {
    let detail = res.body.slice(0, 160);
    try {
      const j = JSON.parse(res.body) as { code?: string; message?: string };
      if (j.code) detail = `${j.code}: ${j.message ?? ""}`;
    } catch {
      /* 非 JSON 就用原文 */
    }
    throw new Error(`验证码校验失败（HTTP ${res.status}）${detail}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new Error("验证码校验响应不是 JSON");
  }
  // 会话票取 **Set-Cookie 的值**（签名形态 `<raw>.<sig>`）：换票端点只认它，
  // 响应体 `token` 是**裸值**，单独当 Cookie 用会 401（实测 2026-11-11）。
  // 只有 Set-Cookie 缺失时才回落裸值（部分环境可能不回 Set-Cookie）。
  const sessionToken = cookieValue(res.setCookies, "__Secure-better-auth.session_token") || str(parsed["token"]);
  if (!sessionToken) throw new Error("登录成功但没拿到会话票（Set-Cookie / token 均空）");
  const user =
    parsed["user"] && typeof parsed["user"] === "object"
      ? (parsed["user"] as Record<string, unknown>)
      : {};
  return {
    sessionToken,
    uid: str(user["id"]),
    nickname: str(user["name"]) || str(user["nickname"]),
  };
}

/** 换 JWT（`POST {app}/api/token`，Cookie 鉴权）。 */
export async function fetchToken(sessionToken: string): Promise<{ token: string; expireAt: number | null }> {
  const res = await postJson(
    `${APP_HOST}${TOKEN_PATH}`,
    { audience: TOKEN_AUDIENCE, expiresIn: 3600 },
    `__Secure-better-auth.session_token=${sessionToken}`,
  );
  if (res.status !== 200) {
    throw new Error(`换票失败（HTTP ${res.status}）：${res.body.slice(0, 160)}`);
  }
  const parsed = JSON.parse(res.body) as Record<string, unknown>;
  const token = str(parsed["token"]);
  if (!token) throw new Error("换票响应里没有 token");
  return { token, expireAt: num(parsed["expiresAt"]) };
}

/**
 * 主对话 id（`GET /v1/config`）。
 *
 * config 是一个**大而平**的对象（mcpSetupGuide / 各能力开关…），mainConversationId
 * 不一定在顶层 —— 递归找第一个该字段；找不到返回空串（发消息响应里会带回真实
 * conversationId，轮询不依赖它）。
 */
export async function fetchMainConversation(token: string): Promise<string> {
  const res = await getJson(`${API_HOST}${CONFIG_PATH}`, token);
  if (res.status !== 200) throw new Error(`取主对话失败（HTTP ${res.status}）：${res.body.slice(0, 160)}`);
  const parsed = JSON.parse(res.body) as Record<string, unknown>;
  const found = findStringField(parsed, "mainConversationId");
  return found ?? "";
}

/** 深度优先找某个字符串字段（只走对象/数组，避免循环）。 */
function findStringField(node: unknown, key: string, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findStringField(item, key, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "string") return value;
  for (const child of Object.values(record)) {
    const hit = findStringField(child, key, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/** 账号信息（昵称、套餐）。字段为平铺的 `preferredName`（实测，无 data 包裹）。 */
export async function fetchProfile(token: string): Promise<{ nickname: string; uid: string }> {
  const res = await getJson(`${API_HOST}${ME_PATH}`, token);
  if (res.status !== 200) return { nickname: "", uid: "" };
  const parsed = JSON.parse(res.body) as Record<string, unknown>;
  const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
  return {
    nickname: str(data["preferredName"]) || str(data["name"]) || str(data["nickname"]),
    uid: str(data["id"]),
  };
}

/**
 * 登录：**手机号 + 短信验证码，唯一路径**。
 *
 * - 有界面（控制台）：弹窗要手机号 → 发码 → 弹窗要验证码 → 一次走完；
 * - 无界面（CLI）：回落环境变量 `TODAYAI_PHONE` / `TODAYAI_SMS_CODE`。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus, requestInput } = options;
  const hasUi = typeof requestInput === "function";
  const ask = (req: { kind: "phone" | "code"; prompt: string }): Promise<string | undefined> =>
    requestInput ? requestInput(req) : Promise.resolve(undefined);

  const phoneRaw =
    (await ask({ kind: "phone", prompt: "手机号（+86）" }))?.trim() ||
    (process.env[PHONE_ENV] ?? "").trim();
  if (!phoneRaw) {
    throw new Error(
      hasUi
        ? "已取消登录：没有拿到手机号，请重新发起登录。"
        : `登录需要手机号：设 ${PHONE_ENV}=+86<手机号> 后重跑（随后 ${SMS_CODE_ENV}=<验证码>）`,
    );
  }
  const phone = normalizePhone(phoneRaw);

  onStatus?.("正在发送验证码...");
  await sendOtp(phone);

  const code =
    (await ask({ kind: "code", prompt: "短信验证码" }))?.trim() ||
    (process.env[SMS_CODE_ENV] ?? "").trim();
  if (!code) {
    throw new Error(
      hasUi
        ? "已取消登录：没有拿到验证码，请重新发起登录。"
        : `登录需要验证码：设 ${SMS_CODE_ENV}=<验证码> 后重跑`,
    );
  }

  onStatus?.("正在校验验证码...");
  const { sessionToken, uid, nickname } = await verifyOtp(phone, code);
  onStatus?.("正在换取访问令牌...");
  const { token, expireAt } = await fetchToken(sessionToken);
  const mainConversationId = await fetchMainConversation(token);
  const profile = await fetchProfile(token);

  const now = Date.now();
  const credential: Credentials = {
    accessToken: token,
    uid: uid || profile.uid,
    domain: "todayai.cn",
    sessionToken,
    phone,
    nickname: nickname || profile.nickname,
    mainConversationId,
    expireAt: String(expireAt ?? now + 3_600_000),
    obtainedAt: new Date(now).toISOString(),
  };
  await save(credential);
  onStatus?.(`登录成功（会话票 ${fingerprint(sessionToken)}）`);
  return credential;
}

/**
 * 续期：会话票换一张新 JWT。
 *
 * 会话票 60 天有效、**不轮换** —— 每次都用同一张票换票，`obtainedAt` 不更新
 * （它是会话票的起算时刻，刷新它会凭空延长本地有效期）。
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  if (sessionExpired(credential)) {
    throw new NotLoggedInError("会话票已过期（60 天），请重新登录");
  }
  const { token, expireAt } = await fetchToken(credential.sessionToken);
  return { ...credential, accessToken: token, expireAt: String(expireAt ?? Date.now() + 3_600_000) };
}

/** 当前 JWT 是否过期（提前 60s 续期，避免请求打到死票上）。 */
export function accessTokenExpired(credential: Credentials): boolean {
  const expireAt = Number.parseInt(credential.expireAt || "0", 10);
  if (!expireAt) return false;
  return Date.now() > expireAt - 60_000;
}

/** 会话票指纹（日志用）。 */
export function sessionFingerprint(credential: Credentials): string {
  return fingerprint(credential.sessionToken);
}

/** 供 upstream 复用同一摘要逻辑（避免两处实现漂移）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export { EMPTY as EMPTY_CREDENTIALS };
