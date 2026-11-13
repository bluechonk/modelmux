/**
 * AutoClaw 凭据：短信验证码两步登录 + 海外 OAuth 回调 + token 续期 + 沙箱落点缓存。
 *
 * 关键约束（端点/字段/实测见 docs/channels/autoclaw/PROTOCOL.md）：
 *   - userapi 全部请求带 MD5 签名头族（appid + 时间戳 + 固定密钥），签名不覆盖请求体。
 *   - 登录响应无 expires_in：按 28 天保守缓存提前刷新（参考实现同口径）。
 *   - device_id 必须稳定复用（同一账号每次登录换设备号会触发风控）。
 *
 * 铁律：登录走真实短信 / OAuth 链路，不读其它应用的本地登录态。
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  writeJsonSecret,
  type Credential,
} from "@modelmux/gateway";

/** 国内区 userapi 基址（海外区端点族相同，本渠道固定绑国内区）。 */
export const USERAPI_BASE = "https://autoglm-acceleration-api.zhipuai.cn";

/** 契约要求：渠道的默认基址。 */
export const DEFAULT_BASE_URL = USERAPI_BASE;

/** Web 客户端版本（签名头族里的 X-Version；对齐参考实现逆向值）。 */
const CLIENT_VER = "1.18.5";

/** 签名三要素：appid + 固定密钥（公开逆向值，服务端只校验 MD5 一致性）。 */
const APP_ID = "100003";
const APP_SECRET = "38d2391985e2369a5fb8227d8e6cd5e5";

/** 上游不给 expires_in，按 28 天保守缓存、提前刷新（bridge.py 同口径）。 */
const EXPIRE_MS = 28 * 86_400_000;
/** 距过期不足该毫秒数就先续期（bridge.py 的 refresh_skew=600s）。 */
const REFRESH_LEAD_MS = 600_000;

/** 登录输入的环境变量兜底（CLI 无界面时用；界面通道见 requestInput）。 */
export const PHONE_ENV = "MODELMUX_AUTOCLAW_PHONE";
export const CODE_ENV = "MODELMUX_AUTOCLAW_CODE";

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
  /** 有它才可静默续期。 */
  readonly refreshToken: string;
  readonly nickname: string;
  readonly phone: string;
  /** 参与服务端设备绑定，**必须持久化复用**。 */
  readonly deviceId: string;
  /** 沙箱落点缓存（对话 relay 的必经前置，见 upstream.ensureSandbox）。 */
  readonly sandboxId: string;
  readonly sandboxEndpoint: string;
  /** 沙箱租期截止（epoch 秒，上游给 0 = 不限）。 */
  readonly endTimestamp: number;
  /** 毫秒时间戳；`null` = 未知（保守起见允许续期判定走 fetch 失败路径）。 */
  readonly expireAt: number | null;
}

// ── 签名与请求 ────────────────────────────────────────────────────────────────

/** `MD5("{appid}&{unix秒}&{密钥}")`——签名只看时间戳，不覆盖请求体。 */
function authSign(ts: string): string {
  return createHash("md5").update(`${APP_ID}&${ts}&${APP_SECRET}`, "utf8").digest("hex");
}

/** token 归一成 `Bearer <jwt>`（上游对自带前缀幂等，这里统一补齐）。 */
function bearer(token: string): string {
  const t = token.trim();
  return /^bearer /i.test(t) ? t : `Bearer ${t}`;
}

/**
 * 去掉 `Bearer ` 前缀，只留裸 JWT —— **凭据里统一存裸 token**。
 *
 * 为什么必须归一（2026-11-07 实测）：上游登录/续期回的是 `access_token`，而
 * `userapiHeaders` 用 `bearer()` 会拼成 `Authorization: Bearer <token>`；若 token 自己
 * 已带前缀，`upstream.buildHeaders` 再拼一次就成 `Bearer Bearer eyJ…` —— 上游一律回
 * `code=11003 invalid authorization token`（wake / agent/send 都是）。症状是「账号有
 * 10191 分、刷新也成功，但每个 glm 请求都先撞它一次再换渠道」。
 *
 * 归一放在**读与写两处**（`load` / `credentialFrom` / `refresh`）：老凭据文件里已经
 * 存了带前缀的 token，读时剥掉即可自愈，不需要用户重新登录。
 */
export function bareToken(token: string): string {
  return token.trim().replace(/^bearer\s+/i, "");
}

/** userapi 统一头族（Web 身份；登录前的请求不携带 Authorization）。 */
function userapiHeaders(token: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Version": CLIENT_VER,
    "X-Tm": "web",
    "X-Product": "autoclaw",
    "X-Client-Type": "web",
    "X-Channel": "official",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": authSign(ts),
    "X-Trace-Id": randomUUID().replace(/-/g, ""),
    "X-Lang": "zh-CN",
  };
  if (token) headers["Authorization"] = bearer(token);
  return headers;
}

interface Envelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

/**
 * userapi 统一调用：发请求 → 解 `{code,msg,data}` 信封 → 业务码归类。
 *
 * `code=0` 成功；`410000` 未登录（终态，提示重登）；其余业务码按可重试错误抛出。
 * billing / upstream 的目录与签到端点同走这条（userapi 域 + 同一套签名头族）。
 */
export async function userapiData<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<T> {
  const payload = await userapiRaw<Envelope>(path, init);
  const code = typeof payload.code === "number" ? payload.code : Number(payload.code ?? 0);
  if (code === 410_000) throw new NotLoggedInError("session expired (code 410000), please log in again");
  if (code !== 0) {
    throw new Error(`userapi business error code=${code}: ${String(payload.msg ?? "")}`);
  }
  return (payload.data ?? {}) as T;
}

/**
 * userapi 原始调用：与本模块 userapiData 同一套签名头族与网络错误归类，
 * 但不剥 data 信封 —— 裸响应的解包交给调用方。
 *
 * 为什么要它：目录端点 /autoclaw-proxy/proxy/autoclaw-model-config 实测（2026-11-13）
 * 回的是裸 {models:[…]}（无 {code,msg,data} 信封）；经 userapiData 取 payload.data
 * 会得到空对象，目录恒空、mx model autoclaw --refresh 恒报 upstream model config is
 * empty，只能靠 seed / 缓存兜底。
 */
export async function userapiRaw<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<T> {
  let resp: Response;
  try {
    resp = await shared.fetchWithTimeout(
      `${USERAPI_BASE}${path}`,
      {
        method: init.method ?? "GET",
        headers: userapiHeaders(init.token ?? ""),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      init.timeoutMs ?? 20_000,
    );
  } catch (err) {
    throw new Error(`userapi request failed (retryable): ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new NotLoggedInError(`credential rejected (HTTP ${resp.status}), please log in again`);
  }
  try {
    return (await resp.json()) as T;
  } catch {
    throw new Error(`userapi response is not JSON (HTTP ${resp.status})`);
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ── 沙箱落点记忆（upstream 的 chatUrl / prepareChat 消费） ────────────────────

/**
 * 最近一次读到的沙箱落点。
 *
 * 为什么由 cred 记：`chatUrl()` 的签名拿不到凭据（契约固定），而主请求（wake）的
 * 落点取决于沙箱 endpoint —— 由 `load()` / `rememberSandbox()` 在有凭据上下文时记下，
 * upstream 读这里。网关每轮 `/health` 都会 `cred.load()`，进程起来后总是对应当前账号。
 */
let lastSandbox: { sandboxId: string; sandboxEndpoint: string; endTimestamp: number } = {
  sandboxId: "",
  sandboxEndpoint: "",
  endTimestamp: 0,
};

/** 当前账号的沙箱 id（可能为空 = 尚未确保过）。 */
export function currentSandboxId(): string {
  return lastSandbox.sandboxId;
}

/** 当前账号的沙箱 endpoint 原文（上游下发形态，未归一化）。 */
export function currentSandboxEndpoint(): string {
  return lastSandbox.sandboxEndpoint;
}

/** 记下并持久化沙箱落点（由 upstream 在 ensureSandbox 后调用）。 */
export function rememberSandbox(credential: Credentials, sandbox: { sandboxId: string; sandboxEndpoint: string; endTimestamp: number }): Credentials {
  lastSandbox = { ...sandbox };
  const next: Credentials = { ...credential, ...sandbox };
  try {
    writeJsonSecret(credentialsPath(), next);
  } catch {
    /* 写不进去不阻塞本次对话：内存里那份已经生效，下次请求再试 */
  }
  return next;
}

// ── 凭据读写 ──────────────────────────────────────────────────────────────────

/** 读凭据；未登录 / 文件损坏都抛 `NotLoggedInError`（共享层靠它判断"没东西"）。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `mx login autoclaw` first");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const accessToken = bareToken(str(parsed["accessToken"]));
  if (!accessToken) throw new NotLoggedInError("Credential has no access_token, please log in again");
  lastSandbox = {
    sandboxId: str(parsed["sandboxId"]),
    sandboxEndpoint: str(parsed["sandboxEndpoint"]),
    endTimestamp: num(parsed["endTimestamp"]),
  };
  return {
    accessToken,
    uid: str(parsed["uid"]),
    domain: str(parsed["domain"]) || "autoclaw.z.ai",
    refreshToken: str(parsed["refreshToken"]),
    nickname: str(parsed["nickname"]),
    phone: str(parsed["phone"]),
    deviceId: str(parsed["deviceId"]),
    sandboxId: lastSandbox.sandboxId,
    sandboxEndpoint: lastSandbox.sandboxEndpoint,
    endTimestamp: lastSandbox.endTimestamp,
    expireAt: shared.parseExpireTime(parsed["expireAt"]),
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断"已登录"）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), credential);
}

// ── 登录 ──────────────────────────────────────────────────────────────────────

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /** 取走用户粘回的 OAuth 回调链接（一次性消费；可能为 undefined）。 */
  pasteCode?: () => string | undefined;
  /** 两步短信登录的输入通道（控制台界面；拿不到回落环境变量）。 */
  requestInput?: (req: { kind: "phone" | "code" | "captcha"; prompt: string }) => Promise<string | undefined>;
  /** `mx relogin` 传 true：跳过复用短路重新走一轮。 */
  force?: boolean;
}

/** 从粘贴内容里解析 OAuth 回调参数（`code` + `state` 都在才算）。 */
function parseOAuthCallback(text: string | undefined): { code: string; state: string } | null {
  if (!text) return null;
  const at = text.indexOf("code=");
  if (at === -1 || text.indexOf("state=") === -1) return null;
  try {
    const query = new URL(text.trim()).searchParams;
    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    return code && state ? { code, state } : null;
  } catch {
    /* 不是合法 URL：按非回调内容处理 */
    return null;
  }
}

/** 契约的 `resolveBaseUrl(realm)`：本渠道固定国内区。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return USERAPI_BASE;
}

/** 登录响应的 token 载荷（access/refresh/user 三件套；字段名 snake_case）。 */
interface LoginPayload {
  access_token: string;
  refresh_token: string;
  user_id: string | number;
  user_name: string;
}

/** 把登录/续期载荷装成凭据（device_id 沿用本轮登录用的那个）。 */
function credentialFrom(payload: LoginPayload, deviceId: string, phone: string): Credentials {
  // 存**裸 token**：`upstream.buildHeaders` 会自己拼 `Bearer `（见 `bareToken`）
  const accessToken = bareToken(str(payload.access_token));
  if (!accessToken) throw new Error("login response has no access_token");
  const uid = String(payload.user_id ?? "");
  if (!uid) throw new Error("login response has no user_id");
  return {
    accessToken,
    uid,
    domain: "autoclaw.z.ai",
    refreshToken: bareToken(str(payload.refresh_token)),
    nickname: str(payload.user_name),
    phone,
    deviceId,
    sandboxId: "",
    sandboxEndpoint: "",
    endTimestamp: 0,
    // 上游不给过期时刻：按 28 天保守缓存，配合提前刷新（bridge.py 同口径）
    expireAt: Date.now() + EXPIRE_MS,
  };
}

/**
 * 设备号：按手机号稳定派生（同一手机号每次登录同号）。
 *
 * 为什么不随机：上游按 device_id 绑定设备，随机新号会触发风控（bridge.py 为每个
 * 手机号持久化一个 uuid；这里用 md5 派生达到同等的「稳定复用」，且不落额外文件）。
 */
function deviceIdFor(phone: string): string {
  const hex = createHash("md5").update(`autoclaw-device:${phone}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 发短信验证码。 */
async function sendCode(phone: string, deviceId: string): Promise<void> {
  await userapiData("/userapi/v1/agent-send-code", {
    method: "POST",
    body: { source_id: "autoclaw", device_id: deviceId, phone },
  });
}

/** 短信验证码换 token（`code` 必须是数字形态，字符串会被 400001 拒绝）。 */
async function loginBySms(phone: string, code: string, deviceId: string): Promise<Credentials> {
  const data = await userapiData<LoginPayload>("/userapi/v1/agent-login/", {
    method: "POST",
    body: { source_id: "autoclaw", device_id: deviceId, phone, code: Number(code), platform: "web" },
  });
  return credentialFrom(data, deviceId, phone);
}

/**
 * 海外 OAuth 回调换 token（Google 通道，bridge.py 实测路径）。
 *
 * 授权入口在 AutoClaw Web 端发起，本渠道只消费用户粘回的回调链接 —— 海外 OAuth
 * 的授权页 URL 响应形态未逆向到位，不伪造入口链接。
 */
async function loginByOAuth(callback: { code: string; state: string }, deviceId: string): Promise<Credentials> {
  const data = await userapiData<LoginPayload>("/userapi/overseasv1/google-oauth-login", {
    method: "POST",
    body: { source_id: "autoclaw", device_id: deviceId, code: callback.code, state: callback.state, platform: "web" },
  });
  return credentialFrom(data, deviceId, "");
}

/**
 * 完整登录：短信两步为主，OAuth 回调兜底。
 *
 * - 界面通道（`requestInput`）优先，拿不到回落环境变量（CLI 老用法）；
 * - 粘贴内容若带 OAuth 回调（code+state）则改走 OAuth 换 token；
 * - `force` 只影响调用方（ensureLogin 已在凭据存在时才带它），这里恒走新登录。
 */
export async function login(_baseUrl: string | undefined, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus, requestInput } = options;
  const ask = (req: { kind: "phone" | "code" | "captcha"; prompt: string }): Promise<string | undefined> =>
    requestInput ? requestInput(req) : Promise.resolve(undefined);

  // OAuth 兜底入口：用户先在 Web 端走完授权、把回调链接粘回来。
  const callback = parseOAuthCallback(options.pasteCode?.());
  if (callback) {
    onStatus?.("识别到 OAuth 回调链接，正在换取令牌...");
    const credential = await loginByOAuth(callback, deviceIdFor("oauth"));
    await save(credential);
    onStatus?.(`已登录 AutoClaw${credential.nickname ? `（${credential.nickname}）` : ""}`);
    return credential;
  }

  // 第一步：手机号。界面优先，其次环境变量。
  const phone =
    (await ask({ kind: "phone", prompt: "AutoClaw 登录手机号（+86）" }))?.trim() ||
    (process.env[PHONE_ENV] ?? "").trim();
  if (!phone) {
    throw new Error(
      requestInput
        ? "已取消短信登录：没有拿到手机号，请重新发起登录。"
        : `SMS login needs a phone number: set ${PHONE_ENV}=<phone> and re-run (then ${CODE_ENV}=<code>)`,
    );
  }
  const deviceId = deviceIdFor(phone);

  // 环境变量一次给齐手机号 + 验证码：直接换 token，不再发新短信。
  const envCode = (process.env[CODE_ENV] ?? "").trim();
  if (envCode) {
    onStatus?.("正在使用环境变量中的验证码登录...");
    const credential = await loginBySms(phone, envCode, deviceId);
    await save(credential);
    onStatus?.(`已登录 AutoClaw${credential.nickname ? `（${credential.nickname}）` : ""}`);
    return credential;
  }

  onStatus?.(`正在向 ${phone} 发送验证码...`);
  await sendCode(phone, deviceId);

  // 第二步：验证码。有界面就地问完；没界面报错并带上环境变量用法。
  const code = (await ask({ kind: "code", prompt: `验证码已发送至 ${phone}` }))?.trim() ?? "";
  if (!code) {
    throw new Error(
      requestInput
        ? "已取消短信登录：验证码未提交，请重新发起登录。"
        : `SMS code sent to ${phone}. Re-run with ${CODE_ENV}=<code> to finish login.`,
    );
  }
  onStatus?.("正在校验验证码...");
  const credential = await loginBySms(phone, code, deviceId);
  await save(credential);
  onStatus?.(`已登录 AutoClaw${credential.nickname ? `（${credential.nickname}）` : ""}`);
  return credential;
}

/**
 * 续期：`POST /userapi/v1/refresh`，body `{source_id, device_id, refresh_token}`。
 *
 * - 401/403 / 410000 → 终态（`NotLoggedInError`，提示重新登录）
 * - 其余（5xx/网络）→ 普通 Error，共享层当作可重试
 *
 * 响应可能同时轮换 refresh_token，必须回写；`device_id` 沿用旧凭据（服务端按它绑定）。
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  if (!credential.refreshToken) throw new NotLoggedInError("Credential has no refresh_token, please log in again");
  const data = await userapiData<LoginPayload>("/userapi/v1/refresh", {
    method: "POST",
    body: {
      source_id: "autoclaw",
      device_id: credential.deviceId,
      refresh_token: credential.refreshToken,
    },
    token: credential.accessToken,
  });
  const accessToken = bareToken(str(data.access_token));
  if (!accessToken) throw new NotLoggedInError("Refresh response has no token, please log in again");
  const next: Credentials = {
    ...credential,
    accessToken,
    refreshToken: bareToken(str(data.refresh_token)) || credential.refreshToken,
    expireAt: Date.now() + EXPIRE_MS,
  };
  await save(next);
  return next;
}

/** 是否该续期（提前量见 REFRESH_LEAD_MS；无过期记录视为该查一次）。 */
export function needsRefresh(credential: Credentials): boolean {
  return credential.expireAt === null || Date.now() + REFRESH_LEAD_MS >= credential.expireAt;
}
