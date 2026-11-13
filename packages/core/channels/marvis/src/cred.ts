/**
 * Marvis 凭证：登录态 + accessKey 签名 + 本地 gateway 连接信息。
 *
 * 关键约束（端点/字段/实测见 docs/marvis/PROTOCOL.md）：
 *   - REST 域是 `yybadaccess.3g.qq.com`，签名 `MD5(body+timestamp+accessKey+nonce)`。
 *   - 首次登录走 native bridge（`window.CallBridge` 的 cloginManager），需客户端；
 *     登录后的 accessToken 可纯 HTTP 复用。
 *   - 本地 gateway 端口与 token 由 `AiStarter.GetGatewayToken` 动态下发，不写死。
 *
 * 铁律：accessToken / refreshToken 不进日志，只给指纹与长度。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  writeJsonSecret,
  type Credential,
} from "@modelmux/gateway";

const { str, fetchWithTimeout } = shared;

/** REST 基址（生产）。 */
export const DEFAULT_BASE_URL = "https://yybadaccess.3g.qq.com";

/** 站点（页面域，用于取 cookie）。 */
export const SITE_URL = "https://marvis-client.yyb.qq.com";

/** 前端硬编码的 accessKey（签名用）。 */
export const ACCESS_KEY = "fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi";

/** 业务标识。 */
export const BUSINESS_ID = "marvis_client";

const HTTP_TIMEOUT_MS = 30_000;

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message = "no usable credentials found; log in with the Marvis client first") {
    super(message);
  }
}

/** 凭据：`Credential` 是共享层三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  /** 页面 cookie 串（含 openid / logintype / accesstoken）。 */
  readonly cookie: string;
  /**
   * 微信/QQ OAuth 下发的 accessToken（REST 接口用）。
   *
   * 注意与 `gatewayToken` 区分：这个用于 `yybadaccess.3g.qq.com` 的 REST 调用，
   * **不能**当本地 gateway 的 token 用（两者是不同体系）。
   */
  readonly token: string;
  /** refreshToken。 */
  readonly refreshToken: string;
  readonly openId: string;
  readonly nickname: string;
  /** 登录方式（`WX` / `QQ`）。 */
  readonly loginType: string;
  /** 设备标识。 */
  readonly guid: string;
  readonly qimei36: string;
  /** 令牌到期时刻（epoch 秒）。 */
  readonly expireAt: number;
  readonly obtainedAt: string;
  /**
   * 本地 gateway token（`AiStarter.GetGatewayToken` 下发）。
   *
   * 与 OAuth token 是**两套**：gateway 只认这里这个，且它随客户端进程变化。
   * 未配置时 gateway 相关接口不可用，但 REST 接口照常。
   */
  readonly gatewayToken: string;
  /** 本地 gateway 地址（`127.0.0.1:<port>`），随 gatewayToken 一起下发。 */
  readonly gatewayAddr: string;
}

const EMPTY: Credentials = {
  accessToken: "",
  uid: "",
  domain: "yybadaccess.3g.qq.com",
  cookie: "",
  token: "",
  refreshToken: "",
  openId: "",
  nickname: "",
  loginType: "",
  guid: "",
  qimei36: "",
  expireAt: 0,
  obtainedAt: "",
  gatewayToken: "",
  gatewayAddr: "",
};

/** 日志用指纹：只给前 8 位 + 长度。 */
function fingerprint(value: string): string {
  if (!value) return "-";
  return `${createHash("sha256").update(value).digest("hex").slice(0, 12)}(${value.length})`;
}

/** 从 cookie 串里取某个键。 */
export function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(";")) {
    const t = part.trim();
    const i = t.indexOf("=");
    if (i > 0 && t.slice(0, i) === name) return t.slice(i + 1);
  }
  return "";
}

export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run the Marvis client once, then import its cookie");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, log in again");
  }
  const cookie = str(parsed["cookie"]);
  const token = str(parsed["token"]) || cookieValue(cookie, "accesstoken");
  const openId = str(parsed["openId"]) || cookieValue(cookie, "openid");
  if (!token || !openId) {
    throw new NotLoggedInError("Credential has no access token / openid, log in again");
  }
  return {
    accessToken: token,
    uid: str(parsed["uid"]) || openId,
    domain: str(parsed["domain"]) || "yybadaccess.3g.qq.com",
    cookie,
    token,
    refreshToken: str(parsed["refreshToken"]) || cookieValue(cookie, "refreshtoken"),
    openId,
    nickname: str(parsed["nickname"]) || cookieValue(cookie, "nickname"),
    loginType: str(parsed["loginType"]) || cookieValue(cookie, "logintype"),
    guid: str(parsed["guid"]) || cookieValue(cookie, "guid"),
    qimei36: str(parsed["qimei36"]) || cookieValue(cookie, "qimei36"),
    expireAt: Number(parsed["expireAt"] ?? 0) || 0,
    obtainedAt: str(parsed["obtainedAt"]),
    gatewayToken: str(parsed["gatewayToken"]),
    gatewayAddr: str(parsed["gatewayAddr"]),
  };
}

export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), credential);
}

export function resolveBaseUrl(): string {
  return DEFAULT_BASE_URL;
}

// ── REST 请求 ───────────────────────────────────────────────────────────────

/** MD5 签名：`MD5(body + timestamp + accessKey + nonce)`。 */
export function sign(body: string, timestamp: string, nonce: string): string {
  return createHash("md5").update(`${body}${timestamp}${ACCESS_KEY}${nonce}`).digest("hex");
}

/** 业务错误码（上游返回的 `code` / `ret`）。 */
export interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * 调一次 REST 接口。
 *
 * `payload` 会序列化后计入签名；返回原始 JSON（业务错误由调用方判断）。
 */
export async function apiCall(
  credential: Credentials,
  path: string,
  payload: Record<string, unknown> = {},
  options: { method?: "POST" | "GET"; needLogin?: boolean } = {},
): Promise<ApiResult> {
  const method = options.method ?? "POST";
  const body = method === "GET" ? "" : JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = String(Math.floor(Math.random() * 10_000));
  const signBody = method === "GET" ? (path.split("?")[1] ?? "") : body;

  const headers: Record<string, string> = {
    "Ual-Access-Businessid": BUSINESS_ID,
    "Ual-Access-Timestamp": timestamp,
    "Ual-Access-Nonce": nonce,
    "Ual-Access-Signature": sign(signBody, timestamp, nonce),
    "Ual-Access-Requestid": String(Math.floor(Math.random() * 10_000)),
    "Ual-Access-Guid": credential.guid,
    "marvis-req-plat-id": "0",
    "marvis-req-is-intel-cpu": "0",
  };
  if (credential.cookie) headers["Cookie"] = credential.cookie;
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (options.needLogin !== false) {
    headers["Ual-Access-Access-Token"] = credential.token;
    headers["Ual-Access-Login-Type"] = credential.loginType;
    headers["Ual-Access-Openid"] = credential.openId;
  }

  const resp = await fetchWithTimeout(
    `${DEFAULT_BASE_URL}${path}`,
    { method, headers, ...(method === "GET" ? {} : { body }) },
    HTTP_TIMEOUT_MS,
  );
  const text = await resp.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Marvis 返回的不是 JSON（HTTP ${resp.status}）：${text.slice(0, 160)}`);
  }
  return { status: resp.status, body: parsed };
}

/** 登录态是否仍然有效（`marvis_check_login`）。 */
export async function probeSession(credential?: Credentials): Promise<boolean> {
  const c = credential ?? load();
  try {
    const r = await apiCall(c, "/marvis_client/marvis_check_login", {
      userInfo: {
        openId: c.openId,
        accessToken: c.token,
        refreshToken: c.refreshToken,
        loginType: c.loginType,
      },
    });
    return Number(r.body["code"] ?? -1) === 0;
  } catch {
    return false;
  }
}

/** 刷新：Marvis 有 refresh_token，但失败时如实抛错，不伪造成功。 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  try {
    const r = await apiCall(credential, "/marvis_client/marvis_refresh_token", {
      userInfo: {
        openId: credential.openId,
        accessToken: credential.token,
        refreshToken: credential.refreshToken,
        loginType: credential.loginType,
        guid: credential.guid,
      },
    });
    if (Number(r.body["code"] ?? -1) !== 0) {
      throw new NotLoggedInError(`Marvis 刷新被拒：${String(r.body["msg"] ?? "")}`);
    }
    return credential;
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    throw new Error(`Marvis 刷新失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 登录：首次必须经客户端（native bridge），此处只做引导。
 *
 * 为什么不实现纯 HTTP 登录：授权在 iframe 里完成，结果由 `postMessage`
 * 回传后经 `window.CallBridge` 写入客户端，没有可直连的登录端点。
 */
export async function login(
  _baseUrl: string,
  options?: { onStatus?: (msg: string) => void },
): Promise<Credentials> {
  options?.onStatus?.(
    "Marvis 登录需在客户端内完成（OAuth 走 native bridge）。" +
      "登录后可从 https://marvis-client.yyb.qq.com/ 读取 document.cookie 并导入。",
  );
  throw new Error(
    "Marvis 首次登录需要客户端：请在 Marvis 客户端登录后，" +
      "用 CDP 读取 https://marvis-client.yyb.qq.com/ 的 document.cookie，写入渠道凭证文件",
  );
}

/** 登出：只清除本地凭据。 */
export async function logout(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(credentialsPath(), { force: true });
}

/** 日志用摘要（不打印令牌原文）。 */
export function describe(credential: Credentials): string {
  return `token=${fingerprint(credential.token)} openid=${credential.openId || "-"} user=${credential.nickname || "-"}`;
}

/** 空凭据。 */
export function empty(): Credentials {
  return { ...EMPTY };
}

/** 便携式凭证文件路径（供导入脚本使用）。 */
export function credentialFilePath(): string {
  return join(credentialsPath());
}
