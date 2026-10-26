/**
 * AStudio 凭据：读桌面应用落盘的会话、换模型网关 Bearer、持久化到本渠道自己的存储。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md）：
 *   - AStudio **没有可独立调用的登录**：本地服务是 `desktop-managed-local` 策略，
 *     只认应用自己的活会话（`synara_session_<port>` cookie，不落盘）。
 *     故 `login()` 只能引导用户在桌面应用里登录，再读它落盘的会话文件。
 *   - 会话文件里有两个凭据：`token`（云端账号 API，Cookie 形态）与
 *     `modelBearerToken`（模型网关，Bearer 形态）。源码里后者优先。
 *   - `refresh()` 是**真刷新**：带 Cookie 打 `/bot/models/configs` 取 `api_key`
 *     （实测与磁盘 `modelBearerToken` 同一个）；Cookie 失效时上游回 `code=80000`。
 *
 * 铁律：token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  writeJsonSecret,
} from "@modelmux/gateway";

import * as upstream from "./upstream.js";

/**
 * AStudio 桌面应用的数据根。
 *
 * 源码常量：`BASE_DIR = windowsDataLocation.dataRoot`，生产实测为
 * `%LOCALAPPDATA%\Programs\AStudio Data`；会话文件在其下的 `userdata\astron-session.json`。
 * 开发版落在 `dev\astron-session.json`，本渠道只认生产版（那是用户实际登录的那份）。
 */
function appDataRoot(): string {
  const base = process.env["ASTUDIO_DATA_DIR"] ?? process.env["LOCALAPPDATA"];
  if (!base) throw new NotLoggedInError(
    "cannot locate the AStudio data directory (set ASTUDIO_DATA_DIR)",
  );
  return join(base, "Programs", "AStudio Data");
}

/** 会话文件路径（`ASTUDIO_DATA_DIR` 可覆盖，便于测试与多装机）。 */
export function sessionFilePath(): string {
  return join(appDataRoot(), "userdata", "astron-session.json");
}

/** 上游账号 API 基址（云端，非本地服务）。 */
export const DEFAULT_BASE_URL = "https://agent.xfyun.cn/xingchen-studio";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

const NOT_LOGGED_IN_MSG =
  "no usable AStudio credentials found; sign in once in the AStudio desktop app, then run `astudio login`";

const HTTP_TIMEOUT_MS = 30_000;

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/**
 * 本渠道自己的凭据（磁盘字段 camelCase）。
 *
 * `modelBearerToken` 是对话用的 Bearer；`sessionToken` / `ssoSessionId` 只用于刷新
 * （拼 Cookie 打账号 API）。两者都来自 AStudio 的会话文件。
 */
export interface Credentials {
  /** 模型网关 Bearer（对话用）。 */
  modelBearerToken: string;
  /** 云端会话票（拼 Cookie 用）。 */
  sessionToken: string;
  /** SSO 会话 id（拼 Cookie 用）。 */
  ssoSessionId: string;
  /** 账号 id（= `uid`）。 */
  uid: string;
  /** 登录手机号；`nickname` 实测为 null，故用它做展示名。 */
  mobile: string;
  /** 账号昵称（上游多为 null → 展示时回落 `mobile`）。 */
  nickname: string;
  loginMethod: string;
  banned: boolean;
  /** 会话文件里的 `loggedInAt`（ISO 字串；取不到为空串）。 */
  loggedInAt: string;
  /** 本渠道落盘时刻（ISO）。 */
  obtainedAt: string;
  /** 凭据来源标记。 */
  source: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  modelBearerToken: "",
  sessionToken: "",
  ssoSessionId: "",
  uid: "",
  mobile: "",
  nickname: "",
  loginMethod: "",
  banned: false,
  loggedInAt: "",
  obtainedAt: "",
  source: "",
};

/** AStudio 会话文件里我们关心的字段。 */
interface AstronSessionFile {
  accountId?: unknown;
  uid?: unknown;
  token?: unknown;
  ssoSessionId?: unknown;
  modelBearerToken?: unknown;
  mobile?: unknown;
  nickname?: unknown;
  loginMethod?: unknown;
  banned?: unknown;
  loggedInAt?: unknown;
}

/** 读 AStudio 会话文件；不存在 / 损坏时抛 `NotLoggedInError`。 */
function readSessionFile(): AstronSessionFile {
  const path = sessionFilePath();
  if (!existsSync(path)) {
    throw new NotLoggedInError(
      `AStudio session file not found at ${path}; sign in once in the AStudio desktop app first`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NotLoggedInError("AStudio session file is malformed");
    }
    return parsed as AstronSessionFile;
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    throw new NotLoggedInError(`failed to read the AStudio session file: ${String(err)}`);
  }
}

/**
 * 从会话文件组装凭据。
 *
 * `modelBearerToken` 优先、`token` 兜底 —— 与 AStudio 源码 `readAstronUpdateCredentials`
 * 的取值顺序一致（见 PROTOCOL §2.1）。
 */
function fromSessionFile(raw: AstronSessionFile): Credentials {
  const modelBearerToken = str(raw["modelBearerToken"]).trim() || str(raw["token"]).trim();
  if (!modelBearerToken) throw new NotLoggedInError("AStudio session file has no usable token");
  const uid = str(raw["uid"]).trim() || str(raw["accountId"]).trim();
  const mobile = str(raw["mobile"]).trim();
  const nickname = str(raw["nickname"]).trim();
  return {
    ...EMPTY_CREDENTIALS,
    modelBearerToken,
    sessionToken: str(raw["token"]).trim(),
    ssoSessionId: str(raw["ssoSessionId"]).trim(),
    uid,
    mobile,
    nickname,
    loginMethod: str(raw["loginMethod"]).trim(),
    banned: raw["banned"] === true,
    loggedInAt: str(raw["loggedInAt"]).trim(),
    obtainedAt: nowIso(),
    source: "astudio-session-file",
  };
}

/**
 * 从磁盘读本渠道凭据。
 *
 * 文件缺失 / 损坏 / 无 Bearer 时抛 `NotLoggedInError`。
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
    modelBearerToken: str(rec["modelBearerToken"]),
    sessionToken: str(rec["sessionToken"]),
    ssoSessionId: str(rec["ssoSessionId"]),
    uid: str(rec["uid"]),
    mobile: str(rec["mobile"]),
    nickname: str(rec["nickname"]),
    loginMethod: str(rec["loginMethod"]),
    banned: rec["banned"] === true,
    loggedInAt: str(rec["loggedInAt"]),
    obtainedAt: str(rec["obtainedAt"]),
    source: str(rec["source"]),
  };
  if (!c.modelBearerToken) throw new NotLoggedInError();
  return c;
}

/**
 * 写入本渠道凭据（临时文件 + 原子替换 + 0600）。
 *
 * 走共享层 `writeJsonSecret`，不自己拼路径（落点由共享层按 `cid` 推导）。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), c);
}

/** 会话 Cookie（源码 `buildAstronCookieHeader` 的形态）。 */
function cookieHeader(c: Credentials): string {
  return [
    c.ssoSessionId ? `ssoSessionId=${c.ssoSessionId}` : null,
    c.ssoSessionId ? `sso_sessionid=${c.ssoSessionId}` : null,
    c.uid ? `account_id=${c.uid}` : null,
    c.sessionToken ? `token=${c.sessionToken}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join("; ");
}

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

/**
 * 登录：**引导用户在桌面应用里完成登录**，然后读它落盘的会话文件。
 *
 * 为什么只能这样：AStudio 的登录端点（`chat/gee-captcha` → `login/mobile/send-verify-code`
 * → `login/phone-quick-login`）由**本地服务代理**，而本地服务是 `desktop-managed-local`
 * 策略 —— 只认应用自己的活会话，外部拿不到（实测全 401，见 PROTOCOL §3.2）。
 *
 * 流程：
 * 1. 提示用户在 AStudio 桌面应用里登录（若未运行则给出启动命令）；
 * 2. 轮询会话文件直到出现 `modelBearerToken`（用户可能还没登完，故等待）；
 * 3. 落盘到本渠道的 `credentials.json`。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus } = options;
  const base = baseUrl || DEFAULT_BASE_URL;

  // 已经登录过就直接复用（用户重跑 login 时不该被迫再登一次）。
  try {
    const existing = load();
    onStatus?.("reusing the existing AStudio credentials");
    return existing;
  } catch {
    /* 没有可复用的凭据 → 走下面的引导 */
  }

  const path = sessionFilePath();
  onStatus?.(
    "AStudio cannot be driven to log in from here: its local service only trusts the " +
      "desktop app's own live session.",
  );
  onStatus?.(
    `Please sign in inside the AStudio desktop app, then re-run this command ` +
      `(the session file is read from ${path}).`,
  );
  options.onUrl?.(base);

  // 等用户在桌面应用里完成登录（最多 5 分钟；每 3 秒看一次会话文件）。
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const c = fromSessionFile(readSessionFile());
      await save(c);
      onStatus?.(`signed in as ${c.mobile || c.uid} (method=${c.loginMethod || "unknown"})`);
      return c;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new NotLoggedInError(
    `timed out waiting for the AStudio session file (${path}): ${String(lastErr)}`,
  );
}

/**
 * `refresh()`：**真刷新** —— 带 Cookie 打 `/bot/models/configs` 取新的 `api_key`。
 *
 * 实测（2026-10-26）：刷新拿到的 `api_key` 与磁盘 `modelBearerToken` **完全一致**，
 * 且该账号 9 个模型共用同一个 Bearer。故刷新是「确认凭据仍有效 + 取回最新值」，
 * 不是「换发新 token」。
 *
 * Cookie 失效（上游 `code=80000` / HTTP 401）时抛 `NotLoggedInError` ——
 * 绝不假装刷新成功。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.sessionToken) {
    throw new NotLoggedInError(
      "no session token available; sign in again in the AStudio desktop app",
    );
  }
  let fresh: string;
  try {
    fresh = await upstream.fetchModelBearerToken(c);
  } catch (err) {
    if (err instanceof upstream.UpstreamUnauthorized) {
      throw new NotLoggedInError(
        `AStudio session is no longer valid (${String(err)}); sign in again in the desktop app`,
      );
    }
    throw new Error(`model credential refresh failed: ${String(err)}`);
  }
  const next: Credentials = {
    ...c,
    modelBearerToken: fresh,
    obtainedAt: nowIso(),
    source: "astudio-model-configs-refresh",
  };
  await save(next);
  return next;
}

/**
 * 登录基址。
 *
 * AStudio 是**单账号域**（只有一个云端基址），`realm` 参数仅为满足契约保留 ——
 * 与 loomy 同理：域不是本渠道的分流维度。
 */
export function resolveBaseUrl(_realm = "auto"): string {
  return DEFAULT_BASE_URL;
}

/** 指纹（供日志用；**不含原文**）。 */
export function fingerprint(c: Credentials): string {
  const t = c.modelBearerToken;
  if (!t) return "(empty)";
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `${t.slice(0, 6)}…(len ${t.length}, fp ${h.toString(16)})`;
}

/** 供诊断：会话文件当前状态（不抛错，返回可读结论）。 */
export function sessionFileStatus(): { path: string; present: boolean; detail: string } {
  const path = sessionFilePath();
  if (!existsSync(path)) return { path, present: false, detail: "not found" };
  try {
    const c = fromSessionFile(readSessionFile());
    return {
      path,
      present: true,
      detail: `uid=${c.uid || "-"} mobile=${c.mobile || "-"} bearer=${fingerprint(c)}`,
    };
  } catch (err) {
    return { path, present: true, detail: String(err) };
  }
}

export const HTTP_TIMEOUT = HTTP_TIMEOUT_MS;
