/**
 * AStudio 凭据：登录（云端短信直连 / 读桌面会话文件两条路）、刷新与持久化。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md §5-§7）：
 *   - 登录**双轨**：路 A 云端短信直连（Web 控制台解滑块；本地服务代理层不提供
 *     可独立调用的登录）；路 B 读桌面应用落盘的会话文件兜底。
 *   - 两个凭据分工：`token` 打账号 API（Cookie 形态）、`modelBearerToken` 打
 *     模型网关（Bearer 形态）；`refresh()` 真刷新，Cookie 失效上游回 `80000`。
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
  type LoginInputRequest,
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
 * 缺 `domain` 会让 `accountKey` 退化成 `sha256(""\0uid)`，与其它渠道的 key 口径不一致。
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
 * 依赖共享层 `NAME_FIELDS` 的顺序「碰巧」命中 `mobile` 不可靠 —— 池层一调顺序，
 * astudio 的显示名就变。所以这里显式回落，不靠池层巧合。
 *
 * ⚠ **不做脱敏**，渠道给什么就显示什么
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
 * 且「封禁」这个事实必须在界面上看得见。
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
 * 用账号 API 补全账号信息（`/userInfo`）。
 *
 * 会话文件里没有 `nickname` 键、`mobile` 也可能是旧的 —— 上游 `/userInfo` 是权威来源
 * （字段见 PROTOCOL §4.2）。**尽力而为**：失败只保留会话文件的值，不让登录因此失败。
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
   * 但 `relogin` 要的是**重新读一次会话文件**。两者不区分的话，
   * `relogin` 在凭据还在时是**空操作**。
   */
  force?: boolean;
  /**
   * 向用户要一段输入（Web 控制台实现；CLI 不实现 → 渠道回落会话文件那条路）。
   *
   * `kind: "captcha"` 时界面会在**浏览器里**解滑块（GeeTest v3），解完把
   * `{geetest_challenge, geetest_validate, geetest_seccode}` 作为 JSON 串回传。
   */
  requestInput?: (req: LoginInputRequest) => Promise<string | undefined>;
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
 * 登录：**两条路**，都通。
 *
 * ## 路 A：手机号 + 短信验证码（云端直连）
 *
 * 云端账号 API 的路径**没有** `/api/astron-auth/` 前缀 —— 那是桌面应用本地服务
 * 代理层的前缀，云端路径就是 `{studioBaseUrl}/<path>`（PROTOCOL §5）。
 * 带上代理层前缀直连必然 404，会让人误以为云端没有登录端点。
 * 各端点的鉴权要求与实测见 docs/channels/astudio/PROTOCOL.md §5。
 *
 * 唯一拦路虎是 **GeeTest v3 滑块** —— 它本来就该由**浏览器**解，
 * 而 Web 控制台正是浏览器（`packages/ui` 的 Geetest 组件加载官方同款 `gt.js`）。
 *
 * 请求形态来自参考实现
 * `packages/core/channels/astudio/reference/2951461586_AStudio2API/internal/astron/login.go`。
 *
 * ## 路 B：读桌面应用落盘的会话文件（**兜底，不需要网络**）
 *
 * 用户在 AStudio 桌面应用里登过一次 → 读 `astron-session.json` → 转存本渠道凭据。
 * 桌面应用没开、或用户不想走短信时走这条。
 *
 * 两条路都失败时，错误信息要说清**用户下一步该做什么**。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus, pasteCode, requestInput, force = false } = options;

  // 非强制且已有凭据：复用（`login` 的语义是幂等的）
  if (!force) {
    try {
      const existing = load();
      onStatus?.("复用已有的 AStudio 凭据");
      return existing;
    } catch {
      /* 没有可复用的凭据 → 走下面的登录 */
    }
  } else {
    onStatus?.("强制重读 AStudio 凭据（relogin）");
  }

  // 有界面（Web 控制台）→ 优先走短信登录；CLI 没有界面 → 走会话文件
  if (requestInput) {
    try {
      return await loginBySms(options);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      onStatus?.(`短信登录未完成（${String(err)}），改用桌面应用的会话文件…`);
    }
  }
  return loginFromSessionFile(options);
}

/** 用户主动取消（不是失败）。 */
class CancelledError extends Error {
  override name = "CancelledError";
}

/**
 * 路 A：手机号 + 短信验证码。
 *
 * 流程（与参考实现同）：
 * 1. 问用户手机号；
 * 2. 取 GeeTest 配置 → **浏览器解滑块** → 拿到三字段；
 * 3. 发短信验证码；
 * 4. 问用户验证码；
 * 5. 换 session → 补 `modelBearerToken` → 落盘。
 *
 * 步骤 2 的滑块由界面完成（`requestInput` 的 `kind: "captcha"` 会把 GeeTest 配置
 * 交给前端，前端解完把三字段回传）。CLI 没有界面 → 直接抛「需要浏览器」。
 */
async function loginBySms(options: LoginOptions): Promise<Credentials> {
  const { onStatus, requestInput } = options;
  const ask = requestInput!;

  const mobile = (await ask({ kind: "phone", prompt: "手机号（+86）" }))?.trim() ?? "";
  if (!mobile) throw new CancelledError("已取消短信登录：没有填写手机号");
  if (!/^1[3-9]\d{9}$/.test(mobile)) {
    throw new Error(`手机号格式不正确（${mobile}）：需为 11 位中国大陆号码`);
  }

  // 步骤 2：GeeTest 配置 → 浏览器解滑块
  onStatus?.("正在获取安全验证配置…");
  const cfg = await upstream.fetchGeetestConfig();
  const solution = await ask({
    kind: "captcha",
    prompt: "请完成安全验证（滑块）",
    captcha: { gt: cfg.gt, challenge: cfg.challenge, success: cfg.success },
  });
  if (!solution) throw new CancelledError("已取消短信登录：安全验证未完成");
  const parsed = parseCaptchaSolution(solution);
  if (!parsed) throw new Error("安全验证结果无效（缺少 challenge / validate / seccode）");

  // 步骤 3：发短信
  onStatus?.(`正在向 ${mobile} 发送验证码…`);
  await upstream.sendSmsCode(mobile, parsed);

  // 步骤 4：问验证码
  const code = (await ask({ kind: "code", prompt: `验证码已发送至 ${mobile}` }))?.trim() ?? "";
  if (!code) throw new CancelledError("已取消短信登录：验证码未提交");

  // 步骤 5：换 session
  onStatus?.("正在校验验证码…");
  const result = await upstream.loginWithSms(mobile, code);
  const token = result.token || result.ssoSessionId;
  if (!result.account_id || !token) {
    throw new Error("登录响应不完整（缺少 account_id / token）");
  }

  const creds: Credentials = {
    ...EMPTY_CREDENTIALS,
    modelBearerToken: "",
    sessionToken: result.token,
    ssoSessionId: result.ssoSessionId || token,
    uid: normalizeUid(result.uid) || result.account_id,
    mobile: result.mobile || mobile,
    nickname: result.nickname,
    loginMethod: "sms",
    banned: false,
    loggedInAt: nowIso(),
    obtainedAt: nowIso(),
    source: "astudio-sms-login",
    accessToken: "",
    domain: sharedLogin.hostOf(DEFAULT_BASE_URL),
  };

  // 换模型网关 Bearer（`/bot/models/configs` 的 api_key）
  let enriched = creds;
  try {
    enriched = await enrichFromUserInfo(creds);
  } catch {
    /* 账号信息补全失败不阻塞登录 */
  }
  try {
    const bearer = await upstream.fetchModelBearerToken(enriched);
    enriched = { ...enriched, modelBearerToken: bearer, accessToken: bearer };
  } catch (err) {
    onStatus?.(`取模型网关凭据失败（${String(err)}）；账号已登录，稍后重试刷新即可。`);
  }
  if (!enriched.modelBearerToken) {
    throw new Error("登录成功但拿不到模型网关凭据（/bot/models/configs）");
  }
  await save(enriched);
  onStatus?.(`已登录为 ${enriched.mobile || enriched.uid}（短信验证码）`);
  return enriched;
}

/** 解析界面回传的 GeeTest 结果（可能是 JSON 串或对象）。 */
function parseCaptchaSolution(raw: string): upstream.GeetestSolution | null {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    obj = null;
  }
  if (!obj) return null;
  const challenge = str(obj["geetest_challenge"]).trim();
  const validate = str(obj["geetest_validate"]).trim();
  const seccode = str(obj["geetest_seccode"]).trim();
  if (!challenge || !validate || !seccode) return null;
  return { geetest_challenge: challenge, geetest_validate: validate, geetest_seccode: seccode };
}

/**
 * uid 归一化：上游对「身份只能从 userInfo 取」的账号会回 `uid: 0`（占位）。
 *
 * 照抄会把它当成真 uid 泄漏成上游头，故按官方客户端的规则过滤
 * （`^[A-Za-z0-9._@-]+$`、长度上限 256、空/`0` 一律丢弃）。
 */
function normalizeUid(value: string): string {
  const v = value.trim();
  if (!v || v === "0" || v.length > 256) return "";
  return /^[A-Za-z0-9._@-]+$/.test(v) ? v : "";
}

/**
 * 路 B：读桌面应用落盘的会话文件（不需要网络）。
 *
 * 流程：
 * 1. 提示用户在 AStudio 桌面应用里登录（若未运行则给出精确指引）；
 * 2. 轮询会话文件直到出现 `modelBearerToken`（用户可能还没登完）；
 * 3. 落盘到本渠道的 `credentials.json`。
 *
 * 期间若用户粘回内容（CLI stdin / Web 粘贴框），优先用粘回来的。
 */
async function loginFromSessionFile(options: LoginOptions): Promise<Credentials> {
  const { onStatus, pasteCode } = options;
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
  onStatus?.(`会话文件：${sessionPath}`);

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
      // 一次直到 5 分钟超时。
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
 * ⚠ 语义必须说清：
 * - 本函数只做**本地销毁** —— 删掉 `credentials.json`；
 * - **不吊销上游会话**：AStudio 的登出端点（`/api/astron-auth/logout`）同样只存在于
 *   本地服务代理层，外部拿不到。云端 `token` / `ssoSessionId` 会继续有效，
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
 * 刷新拿到的 `api_key` 与磁盘 `modelBearerToken` 一致，且该账号全部模型共用
 * 同一个 Bearer —— 故刷新是「确认凭据仍有效 + 取回最新值」，不是「换发新 token」。
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
