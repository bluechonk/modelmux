/**
 * CodeBuddy 国内版凭据：OAuth 授权页登录（state → 授权页 → 轮询令牌）+ 续期。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codebuddycn/PROTOCOL.md）：
 *   - 授权走「state 换授权页」：`POST /v2/plugin/auth/state` 拿 `authUrl`，用户在浏览器里完成，
 *     客户端轮询 `GET /v2/plugin/auth/token?state=` 取令牌；无本机回环，粘回内容只作
 *     「浏览器那一步已完成」的信号（转交同一轮询处理器再取一次）。
 *   - 续期 `POST /v2/plugin/auth/token/refresh`：refresh token 只在 `X-Refresh-Token` 头里，
 *     body 为空对象，且**不带 Authorization**。
 *   - 渠道固定国内版（`copilot.tencent.com`）；国际版是另一个域，不在本渠道内。
 */

import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  loginFlow,
  pasteDetect,
  writeJsonSecret,
  type Credential,
} from "@modelmux/gateway";

/** 国内版 CLI 端点（与 WorkBuddy 国际站分开，凭据不通用）。 */
export const DEFAULT_BASE_URL = "https://copilot.tencent.com";

/** 插件前缀（登录 / 续期都挂在它下面）。 */
const PLUGIN_PREFIX = "/v2/plugin";

/** 凭据域（上游用它区分产品，头 `X-Domain` 回显）。 */
const DOMAIN = "www.codebuddy.cn";

/** 登录轮询：间隔 1s、上限 600s（官方授权页时效）。 */
const POLL_INTERVAL_MS = 1000;
const POLL_EXPIRES_SEC = 600;

/** 请求头（授权态统一走 `upstream.buildHeaders`，这里只给无令牌的两处用）。 */
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  readonly accessToken: string;
  /** 有它才可静默续期。 */
  readonly refreshToken: string;
  readonly uid: string;
  readonly nickname: string;
  readonly domain: string;
  /** 企业账号 id；个人账号空串。 */
  readonly enterpriseId: string;
  /** 毫秒时间戳；`null` = 上游没给。 */
  readonly expireAt: number | null;
}

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /** 测试注入的 sleep（不起真实定时器）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 取走用户粘回的浏览器内容（一次性消费，可能返回 undefined）。 */
  pasteCode?: () => string | undefined;
}

interface TokenPayload {
  accessToken: string;
  refreshToken: string;
  expireAt: number | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读凭据；未登录 / 文件损坏都抛 `NotLoggedInError`（共享层靠它判断「没东西」）。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `codebuddycn login` to authorize in the browser");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const accessToken = str(parsed["accessToken"]);
  if (!accessToken) throw new NotLoggedInError("Credential has no accessToken, please log in again");
  return {
    accessToken,
    refreshToken: str(parsed["refreshToken"]),
    uid: str(parsed["uid"]),
    nickname: str(parsed["nickname"]),
    domain: str(parsed["domain"]) || DOMAIN,
    enterpriseId: str(parsed["enterpriseId"]),
    expireAt: shared.parseExpireTime(parsed["expireAt"]),
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断「已登录」）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), credential);
}

/**
 * 渠道基址（共享层契约要求）。国内版端点固定，`realm` 入参保留以对齐签名。
 */
export function resolveBaseUrl(_realm?: string): string {
  return DEFAULT_BASE_URL;
}

// ── 登录 ─────────────────────────────────────────────────────────────────────

/**
 * 授权页登录：要 state → 给用户授权页 → 轮询令牌 → 取账号档案 → 落盘。
 *
 * 轮询的「码 0/200 但无 accessToken」是**正常中间态**（用户还没点同意），继续等。
 */
export async function login(_baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const stateResp = await shared.fetchWithTimeout(
    `${DEFAULT_BASE_URL}${PLUGIN_PREFIX}/auth/state?platform=workbuddy`,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) },
    20_000,
  );
  if (!stateResp.ok) throw new Error(`auth/state failed: HTTP ${stateResp.status}`);
  const stateData = (await stateResp.json()) as Record<string, unknown>;
  const state = str((stateData["data"] as Record<string, unknown> | undefined)?.["state"]);
  if (!state) throw new Error("auth/state response has no state");
  const authUrl = str((stateData["data"] as Record<string, unknown> | undefined)?.["authUrl"]);
  if (!authUrl) throw new Error("auth/state response has no authUrl");

  options.onUrl?.(authUrl);
  options.onStatus?.("CodeBuddy 国内版: open the URL above in your browser to authorize");

  let pasteReported = false;
  const token = await loginFlow.pollDeviceCode<TokenPayload>({
    intervalMs: POLL_INTERVAL_MS,
    expiresInSec: POLL_EXPIRES_SEC,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    attempt: async () => {
      // 粘贴兜底：内容只作「浏览器已完成」的信号；认出「授权被拒」立刻收尾。
      const pasted = options.pasteCode?.();
      if (typeof pasted === "string" && pasted.trim()) {
        const reason = pasteDetect.pastedAuthFailureReason(pasted);
        if (reason) {
          return { kind: "fatal", error: new Error(`browser authorization failed: ${reason}`) };
        }
        if (!pasteReported) {
          options.onStatus?.("已收到粘回的回调，正在换取令牌...");
          pasteReported = true;
        }
      }
      const resp = await shared.fetchWithTimeout(
        `${DEFAULT_BASE_URL}${PLUGIN_PREFIX}/auth/token?state=${encodeURIComponent(state)}`,
        { headers: { Accept: "application/json" } },
        20_000,
      );
      const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      const data = (payload["data"] ?? {}) as Record<string, unknown>;
      const accessToken = str(data["accessToken"]);
      if (!accessToken) return { kind: "pending" };
      return {
        kind: "done",
        value: {
          accessToken,
          refreshToken: str(data["refreshToken"]),
          expireAt: shared.parseExpireTime(data["expireAt"] ?? data["expires_at"]),
        },
      };
    },
  });

  // 账号档案（uid / 昵称）：轮询响应不带，必须单独取一次（失败不阻塞登录）。
  const account = await fetchAccount(token.accessToken, state);

  const credential: Credentials = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    uid: account.uid,
    nickname: account.nickname,
    domain: account.domain || DOMAIN,
    enterpriseId: account.enterpriseId,
    expireAt: token.expireAt,
  };
  await save(credential);
  options.onStatus?.(`已登录 CodeBuddy 国内版${credential.nickname ? `（${credential.nickname}）` : ""}`);
  return credential;
}

/** 账号档案：`GET /v2/plugin/login/account?state=`（带 Bearer）。 */
async function fetchAccount(
  accessToken: string,
  state: string,
): Promise<{ uid: string; nickname: string; domain: string; enterpriseId: string }> {
  try {
    const resp = await shared.fetchWithTimeout(
      `${DEFAULT_BASE_URL}${PLUGIN_PREFIX}/login/account?state=${encodeURIComponent(state)}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } },
      20_000,
    );
    if (!resp.ok) return { uid: "", nickname: "", domain: "", enterpriseId: "" };
    const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const data = (payload["data"] ?? {}) as Record<string, unknown>;
    return {
      uid: str(data["uid"]),
      nickname: str(data["nickname"] ?? data["name"]),
      domain: str(data["domain"]),
      enterpriseId: str(data["enterpriseId"] ?? data["tenantId"]),
    };
  } catch {
    return { uid: "", nickname: "", domain: "", enterpriseId: "" };
  }
}

/**
 * 续期：`POST /v2/plugin/auth/token/refresh`。
 *
 * - 401/403 → 终态（`NotLoggedInError`，提示重新登录）
 * - 200 但无 accessToken → 同样终态
 * - 其余（5xx/429/网络）→ 普通 Error，共享层会当作可重试
 *
 * 续期响应不含 uid / 昵称 / domain，必须从旧凭据保留。
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  if (!credential.refreshToken) {
    throw new Error("Credential has no refreshToken, cannot refresh silently");
  }
  const headers: Record<string, string> = {
    ...JSON_HEADERS,
    "X-Domain": credential.domain || DOMAIN,
    "X-User-Id": credential.uid,
    "X-Refresh-Token": credential.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
  };
  if (credential.enterpriseId) {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
  }

  let resp: Response;
  try {
    resp = await shared.fetchWithTimeout(
      `${DEFAULT_BASE_URL}${PLUGIN_PREFIX}/auth/token/refresh`,
      { method: "POST", headers, body: JSON.stringify({}) },
      20_000,
    );
  } catch (err) {
    throw new Error(`Refresh request failed (retryable): ${String(err)}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new NotLoggedInError("refresh token expired, please run `codebuddycn login` again");
  }
  if (!resp.ok) throw new Error(`Refresh failed: HTTP ${resp.status} (retryable)`);

  const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const data = (payload["data"] ?? {}) as Record<string, unknown>;
  const accessToken = str(data["accessToken"]);
  if (!accessToken) throw new NotLoggedInError("Refresh response has no accessToken, please log in again");

  const next: Credentials = {
    ...credential,
    accessToken,
    refreshToken: str(data["refreshToken"]) || credential.refreshToken,
    expireAt: shared.parseExpireTime(data["expireAt"] ?? data["expires_at"]) ?? credential.expireAt,
  };
  await save(next);
  return next;
}
