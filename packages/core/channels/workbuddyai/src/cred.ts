/**
 * WorkBuddyAI 凭据：浏览器设备登录、持久化与令牌刷新。
 *
 * 关键约束（端点/字段/实测见 docs/channels/workbuddyai/PROTOCOL.md）：
 *   - 登录只有 `login()` 一条路径（网页设备授权，无 PKCE），不提供第二种登录方式（桌面端加密导入 / 手工 JSON 导入均不采纳）。
 *   - 设备授权无本机回环：`pasteCode` 只作「浏览器已完成」信号，转交同一轮询处理器再取一次令牌。
 *   - 本渠道只有一个域（国际版 `workbuddy.ai`），账号属于哪个域就用哪个渠道登录。
 */

import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  pasteDetect,
  writeJsonSecret,
} from "@modelmux/gateway";

import { isCnDomain, normalizeBaseUrl } from "./upstream.js";

/** 登录基址（国际版 workbuddy.ai）。 */
export const DEFAULT_BASE_URL = "https://www.workbuddy.ai";

/** 向 WorkBuddyAI 插件端点标识本客户端。 */
const PLATFORM_QS = "platform=workbuddy";

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const MAX_LOGIN_ROUNDS = 2;
const HTTP_TIMEOUT_MS = 30_000;

const NOT_LOGGED_IN_MSG = "no credentials found; start the gateway to log in";

/**
 * epoch 毫秒阈值（秒/毫秒判据）。
 *
 * [代码] 与共享层账号池一致（`runtime/account-pool.ts:120-137` 的 `parseExpiry`）：
 * 数值 `> 1e12` 视为**毫秒**（2001-09 之后的 epoch 毫秒），否则视为**秒**。
 */
const EPOCH_MS_THRESHOLD = 1e12;

/**
 * 相对时长的秒数上限（超过就不太可能是「秒」，按毫秒解释）。
 *
 * [推断] 相对量不是 epoch，套不了上面的 epoch 阈值；令牌有效期不会超过
 * 1e6 秒（≈11.6 天），超过就按毫秒解释。**只作兜底** —— 有绝对锚点时
 * 用锚点反推单位（见 `durationUnitMs`）。
 */
const DURATION_SEC_LIMIT = 1e6;

/** 磁盘上不存在可用凭证。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/**
 * credentials.json 的磁盘布局。JSON 字段名与 Go 版一致（camelCase）。
 *
 * `expiresAt` / `refreshExpiresAt` 统一存 **epoch 毫秒**（取不到为 null）。
 * 共享层账号池的 `parseExpiry` 认得这两种形态（毫秒会换算成秒），
 * 见 `runtime/account-pool.ts:120-137`。
 */
export interface Credentials {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  sessionState: string;
  domain: string;
  uid: string;
  /** 账号昵称（`/v2/plugin/login/account` 取；取不到留空，uid 回落 JWT `sub`）。 */
  nickname: string;
  expiresIn: string;
  /** 访问令牌到期时刻（epoch 毫秒；null = 取不到）。 */
  expiresAt: unknown;
  refreshExpiresIn: string;
  /** 刷新令牌到期时刻（epoch 毫秒；null = 取不到）。 */
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
 * 国际版**只有一个域**（workbuddy.ai），`realm` 参数仅作兼容保留（共享层 CLI 会传进来）。
 * 国内版是**独立渠道** `workbuddy`（codebuddy.ai）—— 域是渠道身份的一部分，
 * 不在这里按参数分流（那会让登录链路与凭证落点随 `--realm` 漂移）。
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
 * 缺名字时从声明里取，避免 Web 只能显示脱敏 uid。国际版声明给的是
 * `name` / `given_name` / `email`，国内版给 `nickname`，故一并兜住。
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
    // 档案端点的 nickname 可能为空 → 回落 JWT 声明（见 jwtNickname）
    nickname: profile?.nickname?.trim() || jwtNickname(access),
    obtainedAt: nowRfc3339(),
    source: "workbuddy-login-poll",
  };
}

/** 把请求标记为匿名（未鉴权）的插件端点头。 */
function anonHeaders(): Record<string, string> {
  return {
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

/** 数字取值（字符串数字也认）；取不到返回 null。 */
function numOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * **绝对时刻** → epoch 毫秒（秒/毫秒都认）。
 *
 * [代码] 判据与共享层账号池一致（`runtime/account-pool.ts:125`）：
 * 数值 `> 1e12` 视为毫秒，否则视为秒。
 */
function epochToMs(value: unknown): number | null {
  const n = numOf(value);
  if (n === null || n <= 0) return null;
  return Math.trunc(n > EPOCH_MS_THRESHOLD ? n : n * 1000);
}

/**
 * 相对时长（`expiresIn` / `refreshExpiresIn`）的单位判定。
 *
 * [代码] 三家参考实现口径不一：hub **不用**这两个字段（改用 `expiresAt` /
 *   JWT `exp`，`wb_accounts.py:540`、`:1375`）、ckldy 当**秒**
 *   （`internal/upstream/client.go:213-215`）、tom 当**毫秒**
 *   （`Tom6814/codebuddy_direct_api.py:368-373`）。
 * [推断] 故这里不猜：有绝对锚点时按「哪一种解释更贴近锚点」判定；
 *   没有锚点时才按量级兜底。
 *
 * @param anchorMs 绝对到期时刻（毫秒）；没有就传 null
 * @returns 换算乘数：相对量按**秒**解释时是 1000，按**毫秒**解释时是 1
 */
function durationUnitMs(
  relative: unknown,
  nowMs: number,
  anchorMs: number | null,
): number {
  const n = numOf(relative);
  if (n === null || n <= 0) return 1000;
  if (anchorMs !== null) {
    const remain = anchorMs - nowMs;
    const asSec = Math.abs(remain - n * 1000);
    const asMs = Math.abs(remain - n);
    return asSec <= asMs ? 1000 : 1;
  }
  return n > DURATION_SEC_LIMIT ? 1 : 1000;
}

/**
 * 相对时长 → 到期时刻（epoch 毫秒）。
 *
 * @param perUnitMs 换算乘数（`durationUnitMs` 的返回值）
 */
function durationToMs(value: unknown, nowMs: number, perUnitMs: number): number | null {
  const n = numOf(value);
  if (n === null || n <= 0) return null;
  return Math.trunc(nowMs + n * perUnitMs);
}

/**
 * 令牌束的到期时刻（epoch 毫秒）。
 *
 * [代码] 口径对齐 hub `wb_accounts.py:540`：**绝对时刻优先 → JWT `exp` → 相对时长**。
 * - `expiresAt`（上游给的绝对时刻）：秒/毫秒都认；
 * - 访问令牌 JWT 的 `exp`：标准秒级 epoch（共享层 `login.ts` 的 `jwtExpMs`）；
 * - `expiresIn` / `refreshExpiresIn`（相对量）：单位由上面的绝对锚点反推。
 *
 * 刷新令牌没有 JWT，只能靠访问令牌的锚点反推单位 —— 故两者共用同一个换算乘数。
 */
function resolveExpiries(
  bundle: Record<string, unknown>,
  nowMs: number,
): { expiresAt: number | null; refreshExpiresAt: number | null } {
  const absolute = epochToMs(bundle["expiresAt"]);
  const jwtExp = sharedLogin.jwtExpMs(str(bundle["accessToken"]));
  const anchorMs = absolute ?? (jwtExp > 0 ? jwtExp : null);
  const perUnitMs = durationUnitMs(bundle["expiresIn"], nowMs, anchorMs);
  return {
    expiresAt: anchorMs ?? durationToMs(bundle["expiresIn"], nowMs, perUnitMs),
    refreshExpiresAt: durationToMs(bundle["refreshExpiresIn"], nowMs, perUnitMs),
  };
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
 * 取账号档案：`GET {base}/v2/plugin/login/account?state=<state>`（带 Bearer）。
 *
 * 这是**登录链路内的最后一步**，不是第二条登录路径：拿的是同一次授权对应的
 * 账号身份（uid / enterpriseId / nickname），拿不到也不影响登录成功 ——
 * uid 仍可从 JWT `sub` 提取。
 *
 * 参考实现：hub `wb_accounts.py:3458-3468`、ckldy `cmd/login/main.go:151-163`。
 * ⚠ 国际版该端点**确实存在**（无有效令牌回 401，随手编的路径回 404 —— 实测）。
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
      // ⚠ 这里**不能**带 `anonHeaders()`（X-No-Authorization 等「未鉴权」标记）——
      // 与 `Authorization` 自相矛盾，会被上游判成未鉴权。参考实现同样只带
      // 公共头 + `Authorization`（hub `wb_accounts.py:3462`、ckldy `cmd/login/main.go:157-160`）。
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${accessToken}`,
      },
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
        options.onStatus?.("已收到粘回的回调，正在换取令牌...");
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
      `第 ${round}/${MAX_LOGIN_ROUNDS} 轮：等待授权中（请在上面的浏览器里完成登录，本轮最长 ${LOGIN_WINDOW_MS / 60000} 分钟）…` +
        (options.pasteCode
          ? " 登录后也可以把地址栏链接粘回来，立刻换取令牌。"
          : ""),
    );
    const stateId = str(state["state"]);
    const token = await pollToken(base, stateId, options);
    if (!token) {
      onStatus?.(`第 ${round} 轮超时，正在重试…`);
      continue;
    }
    // 账号档案：登录链路内的最后一步（拿 uid / enterpriseId / nickname）。
    const profile = await fetchAccountProfile(base, stateId, str(token["accessToken"]));
    const c = fromToken(
      str(token["accessToken"]),
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
    const { expiresAt, refreshExpiresAt } = resolveExpiries(token, Date.now());
    c.expiresAt = expiresAt;
    c.refreshExpiresAt = refreshExpiresAt;
    await save(c);
    return c;
  }
  throw new Error(`no login detected after ${MAX_LOGIN_ROUNDS} attempt(s)`);
}

/** 用存储的刷新令牌换取新的访问令牌。失败由调用方回退到交互登录。
 *
 * 端点与鉴权形态按 hub 实测（`wb_accounts.py` 的 `_refresh_locked`）：路径带
 * `/token/` 段，令牌走 `X-Refresh-Token` 头、请求体为空对象；上游会轮换
 * refresh token，新值必须回写（拿不到就保留旧值）。
 *
 * [代码] 区域判定复用 `upstream.isCnDomain()`（含国内版三代域名
 * `copilot.tencent.com` / `codebuddy.cn` / `workbuddy.cn`，
 * 见 `wb_accounts.py:260-266`）；续期 base 一律过 `normalizeBaseUrl()`
 * （`www.codebuddy.ai` 已 DNS 沉洞）。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("no refresh token available");
  const realmCn = isCnDomain(c.domain);
  const base = normalizeBaseUrl(realmCn ? "https://copilot.tencent.com" : DEFAULT_BASE_URL);
  const resp = await fetchWithTimeout(`${base}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    body: "{}",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "X-Refresh-Token": c.refreshToken,
      "X-Auth-Refresh-Source": realmCn ? "workbuddy" : "plugin",
      "X-User-Id": c.uid,
      "X-Domain": c.domain || hostOf(base),
      "X-CodeBuddy-Request": "1",
    },
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
    // 刷新响应不带账号档案：沿用旧值，别把 uid 与昵称丢掉。
    { uid: c.uid, enterpriseId: "", nickname: c.nickname },
  );
  const now = Date.now();
  next.expiresIn = anyToStr(token["expiresIn"]);
  next.refreshExpiresIn = anyToStr(token["refreshExpiresIn"]);
  const { expiresAt, refreshExpiresAt } = resolveExpiries(token, now);
  next.expiresAt = expiresAt ?? c.expiresAt;
  next.refreshExpiresAt = refreshExpiresAt ?? c.refreshExpiresAt;
  if (!next.uid) next.uid = c.uid;
  await save(next);
  return next;
}
