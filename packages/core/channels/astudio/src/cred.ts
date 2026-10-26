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

import { existsSync, readFileSync, rmSync } from "node:fs";
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
 *
 * ⚠ **契约字段必须齐**（共享层 `Credential`：`accessToken` / `uid` / `domain`）：
 * 缺 `domain` 会让 `accountKey` 退化成 `sha256(""\0uid)`，与其它渠道的 key 口径不一致
 * （2026-10-26 补，见 docs/channels/astudio/ROADMAP.md 第 3 项）。
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
  /** 登录手机号。 */
  mobile: string;
  /** 账号昵称（上游实测恒为 null → 显式回落 `mobile`，见 `displayName()`）。 */
  nickname: string;
  loginMethod: string;
  banned: boolean;
  /** 会话文件里的 `loggedInAt`（ISO 字串；取不到为空串）。 */
  loggedInAt: string;
  /** 本渠道落盘时刻（ISO）。 */
  obtainedAt: string;
  /** 凭据来源标记。 */
  source: string;
  // ── 共享层 `Credential` 契约字段 ──
  /** 契约字段：对话 Bearer（= `modelBearerToken`）。 */
  accessToken: string;
  /** 契约字段：账号域（AStudio 单域，取上游基址的 host）。 */
  domain: string;
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
  accessToken: "",
  domain: "",
};

/**
 * 展示名：**显式回落**，不靠池层字段表巧合命中。
 *
 * 上游 `nickname` 实测恒为 `null`（PROTOCOL §4.2），会话文件里也**根本没有这个键**。
 * 此前代码读出来是空串，再靠共享层 `NAME_FIELDS` 的顺序**碰巧**命中 `mobile` ——
 * 池层哪天调顺序，astudio 的显示名就变了（2026-10-26 修，见 ROADMAP 第 3 项缺陷 A）。
 *
 * ⚠ 按主人 2026-10-26 的决定：**不做脱敏**，渠道给什么就显示什么
 * （`mobile` 是明文手机号，与 `packages/ui` 的 `displayName()` 口径一致）。
 */
function displayName(raw: AstronSessionFile): string {
  return str(raw["nickname"]).trim() || str(raw["mobile"]).trim();
}

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
 *
 * `banned: true` 直接抛错：账号已被上游封禁，继续用只会在每次请求上撞 401/403，
 * 且「封禁」这个事实必须在界面上看得见（2026-10-26，见 ROADMAP 第 3 项）。
 */
function fromSessionFile(raw: AstronSessionFile): Credentials {
  const modelBearerToken = str(raw["modelBearerToken"]).trim() || str(raw["token"]).trim();
  if (!modelBearerToken) throw new NotLoggedInError("AStudio session file has no usable token");
  if (raw["banned"] === true) {
    throw new NotLoggedInError(
      "this AStudio account is banned upstream; contact iFlytek support before retrying",
    );
  }
  const uid = str(raw["uid"]).trim() || str(raw["accountId"]).trim();
  const mobile = str(raw["mobile"]).trim();
  return {
    ...EMPTY_CREDENTIALS,
    modelBearerToken,
    sessionToken: str(raw["token"]).trim(),
    ssoSessionId: str(raw["ssoSessionId"]).trim(),
    uid,
    mobile,
    nickname: str(raw["nickname"]).trim(),
    loginMethod: str(raw["loginMethod"]).trim(),
    banned: false,
    loggedInAt: str(raw["loggedInAt"]).trim(),
    obtainedAt: nowIso(),
    source: "astudio-session-file",
    // 契约字段：对话 Bearer 与账号域（单域，取上游基址的 host）
    accessToken: modelBearerToken,
    domain: sharedLogin.hostOf(DEFAULT_BASE_URL),
  };
}

/**
 * 用账号 API 补全账号信息（`GET /xingchen-studio/userInfo`）。
 *
 * 会话文件里没有 `nickname` 键、`mobile` 也可能是旧的 —— 上游 `/userInfo` 是权威来源
 * （PROTOCOL §4.2 实测 `code=0`，含 `uid` / `mobile` / `nickname`）。
 * **尽力而为**：失败只保留会话文件的值，不让登录因此失败。
 */
async function enrichFromUserInfo(c: Credentials): Promise<Credentials> {
  const info = await upstream.fetchUserInfo(c);
  const mobile = str(info["mobile"]).trim() || c.mobile;
  const nickname = str(info["nickname"]).trim();
  const uid = str(info["uid"]).trim() || c.uid;
  return {
    ...c,
    mobile,
    nickname,
    uid,
    // 契约字段随 uid 一起更新（key 由 uid+domain 派生）
    accessToken: c.modelBearerToken,
    domain: sharedLogin.hostOf(DEFAULT_BASE_URL),
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
    accessToken: str(rec["accessToken"]),
    domain: str(rec["domain"]),
  };
  if (!c.modelBearerToken) throw new NotLoggedInError();
  if (c.banned) {
    throw new NotLoggedInError(
      "this AStudio account is banned upstream; contact iFlytek support before retrying",
    );
  }
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
  /**
   * 取走用户粘回的内容（CLI 的 stdin 一行 / Web 的粘贴框）。
   *
   * astudio 没有 OAuth 回调，粘贴的用处是**让用户直接贴会话文件路径或 JSON**
   * （比如在桌面应用里不好找文件时）。见 `login()` 里的消费点。
   */
  pasteCode?: () => string | undefined;
  /**
   * 强制重读（`mx relogin astudio`）。
   *
   * ⚠ 默认行为是「已有凭据就复用」—— 那是 `login()` 的语义（幂等），
   * 但 `relogin` 要的是**重新读一次会话文件**。此前两者没区分，
   * 导致 `relogin` 在凭据还在时是**空操作**（2026-10-26 修死结，见 ROADMAP 第 4 项）。
   */
  force?: boolean;
}

/**
 * 桌面应用是否在跑（本地服务的端口记录在 `server-runtime.json`）。
 *
 * 只用来给用户**精确的指引**（「请先打开 AStudio」 vs 「应用在跑，请在里面登录」），
 * 不做硬性拦截 —— 应用可能刚启动、文件还没写出来。
 */
function appRuntime(): { running: boolean; port: number | null; path: string } {
  const path = join(appDataRoot(), "userdata", "server-runtime.json");
  if (!existsSync(path)) return { running: false, port: null, path };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return { running: false, port: null, path };
    const rec = raw as Record<string, unknown>;
    const pid = Number(rec["pid"]);
    const port = Number(rec["port"]);
    // pid 还活着才算「在跑」（server-runtime.json 是应用退出时不会清理的残留）
    const alive = Number.isFinite(pid) && pid > 0 && isProcessAlive(pid);
    return { running: alive, port: Number.isFinite(port) && port > 0 ? port : null, path };
  } catch {
    return { running: false, port: null, path };
  }
}

/** pid 是否还活着（Windows：`tasklist` 查 PID；其它平台用信号 0 探测）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但没权限；ESRCH = 不存在
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * 登录：**引导用户在桌面应用里完成登录**，然后读它落盘的会话文件。
 *
 * ## 为什么不能自己发短信验证码
 *
 * 登录端点（`chat/gee-captcha` → `login/mobile/send-verify-code` →
 * `login/phone-quick-login`）只存在于**本地服务的代理层**，而本地服务是
 * `desktop-managed-local` 策略 —— 只认应用自己持有的活会话（不落盘、外部拿不到）。
 * 实测（2026-10-26，应用正在运行且已登录）：
 *
 * | 尝试 | 结果 |
 * | --- | --- |
 * | `127.0.0.1:<port>/api/astron-auth/login/sms` | `401 Authentication required.` |
 * | 带 `X-Sso-Session-Id` / `ssoSessionId` / `Cookie` / `Bearer` | 全部 401 |
 * | 云端 `agent.xfyun.cn/xingchen-studio/api/astron-auth/*` | `404` |
 * | 云端 `astronstudio-api-volces-prod.xf-yun.com/api/astron-auth/*` | `401 HMAC signature cannot be verified` |
 *
 * 所以**手机号 + 验证码这条链路在本渠道无法独立闭环**（见 PROTOCOL §5）。
 * 能做的、也是现在做的：读应用落盘的会话文件 —— 用户只需在桌面应用里登一次。
 *
 * ## 为什么不传 `onUrl`
 *
 * 此前传的是 `DEFAULT_BASE_URL`（账号 API 基址），Web 端会把它当「授权链接」渲染 ——
 * 用户点开是个 API 地址，不是登录页（2026-10-26 修，见 ROADMAP 第 1 项）。
 * 现在**不给链接**，只给文字指引。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus, pasteCode, force = false } = options;

  // 非强制且已有凭据：复用（`login` 的语义是幂等的）
  if (!force) {
    try {
      const existing = load();
      onStatus?.("复用已有的 AStudio 凭据");
      return existing;
    } catch {
      /* 没有可复用的凭据 → 走下面的引导 */
    }
  } else {
    onStatus?.("强制重读 AStudio 会话文件（relogin）");
  }

  const sessionPath = sessionFilePath();
  const runtime = appRuntime();
  if (!runtime.running) {
    onStatus?.(
      `AStudio 桌面应用没在运行（端口记录 ${runtime.path} 指向的进程已退出）。` +
        "请先启动 AStudio 并在里面登录，再重跑本命令。",
    );
  } else {
    onStatus?.(
      `AStudio 正在运行（本地服务端口 ${runtime.port ?? "未知"}）。` +
        "请确认已在应用里登录；本渠道会读它落盘的会话文件。",
    );
  }
  onStatus?.(
    "AStudio 的登录端点只存在于它自己的本地服务代理层，且该服务只认应用自己的活会话 —— " +
      "外部进程拿不到（实测 401），所以这里无法代你发短信验证码。",
  );
  onStatus?.(`会话文件：${sessionPath}`);

  // 用户在桌面应用里完成登录（最多 5 分钟；每 3 秒看一次会话文件）。
  // 期间若用户粘回内容（CLI stdin / Web 粘贴框），优先用粘回来的。
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const pasted = pasteCode?.();
    if (pasted && pasted.trim()) {
      try {
        const c = await fromPasted(pasted.trim());
        await save(c);
        onStatus?.(`已登录为 ${c.mobile || c.uid}（方式 ${c.loginMethod || "未知"}，来自粘贴内容）`);
        return c;
      } catch (err) {
        onStatus?.(`粘贴的内容用不上（${String(err)}），继续等会话文件…`);
      }
    }
    try {
      const base = fromSessionFile(readSessionFile());
      // ⚠ 账号信息补全是**尽力而为**：`/userInfo` 拉失败（网络/上游抖动）时必须回落到
      // 会话文件的值，不能让整个登录失败 —— 否则会话文件明明是好的，却每 3 秒重试
      // 一次直到 5 分钟超时（2026-10-26 实测）。
      let c = base;
      try {
        c = await enrichFromUserInfo(base);
      } catch {
        /* 保留会话文件的值 */
      }
      await save(c);
      onStatus?.(`已登录为 ${c.mobile || c.uid}（方式 ${c.loginMethod || "未知"}）`);
      return c;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new NotLoggedInError(
    `timed out waiting for the AStudio session file (${sessionPath}): ${String(lastErr)}`,
  );
}

/**
 * 用用户粘回的内容组装凭据：**会话文件路径** 或 **会话文件 JSON**。
 *
 * 为什么支持粘贴：会话文件藏在 `%LOCALAPPDATA%\Programs\AStudio Data\userdata\` 下，
 * 普通用户不一定找得到；让他贴路径（或直接贴 JSON）比让他去翻目录省事。
 */
async function fromPasted(text: string): Promise<Credentials> {
  // 形态一：文件路径（含盘符 / 反斜杠 / .json 结尾）
  const looksLikePath = /[\\/]/.test(text) || /\.json$/i.test(text);
  if (looksLikePath) {
    const raw = JSON.parse(readFileSync(text, "utf8")) as AstronSessionFile;
    return enrichFromUserInfo(fromSessionFile(raw));
  }
  // 形态二：直接是会话 JSON
  const raw = JSON.parse(text) as AstronSessionFile;
  return enrichFromUserInfo(fromSessionFile(raw));
}

/**
 * 登出：**销毁本渠道的本地凭据**。
 *
 * ⚠ 语义必须说清（2026-10-26，见 ROADMAP 第 5 项）：
 * - 本函数只做**本地销毁** —— 删掉 `credentials.json`；
 * - **不吊销上游会话**：AStudio 的登出端点（`POST /api/astron-auth/logout`）同样只存在于
 *   本地服务代理层，外部拿不到（实测 401）。云端 `token` / `ssoSessionId` 会继续有效，
 *   AStudio 桌面应用里也仍是登录态；
 * - 池里的账号由共享层清理（Web「删除生效账号」已会连带删 `credentials.json`）。
 *
 * 上游吊销需要 AStudio 桌面应用配合，属另一个量级的改动，本渠道不做。
 */
export async function logout(): Promise<void> {
  const path = credentialsPath();
  if (!existsSync(path)) return;
  rmSync(path);
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
    // 契约字段与对话 Bearer 同源，刷新后一起更新
    accessToken: fresh,
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
