/**
 * 认证状态：浏览器设备登录流程、凭证持久化与访问令牌刷新。
 *
 * ## 登录协议（唯一一条路径）
 *
 *   1. `POST {base}/v2/plugin/auth/state?platform=workbuddy`（匿名头）→ {state, authUrl}
 *   2. 浏览器打开 authUrl，人工授权（唯一人工步骤）
 *   3. `GET {base}/v2/plugin/auth/token?state=...` 每 5s 轮询，≤5 分钟 → 令牌
 *   4. 落盘为 credentials.json（Go 风格字段名）
 *   刷新：`POST /v2/plugin/auth/token/refresh`（纯 HTTP，X-Refresh-Token 头）
 *
 * ⚠ 本渠道**只有一个域**（国际版 workbuddy.ai）。国内版（codebuddy.ai）是**独立渠道**
 * `workbuddy` —— 账号属于哪个域就用哪个渠道登录，不再有 `--realm` 二选一。
 *
 * ## 为什么只保留这一条登录路径
 *
 * [代码] 设备授权是 hub（`wb_accounts.py:3402-3486`）与 ckldy
 *   （`cmd/login/main.go:104-175`）**逐字同协议**的唯一共识路径（同样三个端点、
 *   同样由服务端签发 state、同样无 PKCE），且不依赖任何本机特权。
 * [推断] 参考实现的另两条**不实现**：
 *   - 桌面端加密凭据导入（hub `wb_accounts.py:3491-3534` + `wb_atrest.py`）要
 *     AES-256-GCM at-rest 解密 + Windows `ReadProcessMemory` 回收主密钥 ——
 *     违反渠道包 7 文件 / 零第三方依赖的契约；
 *   - 手工 JSON 导入（ckldy `internal/auth/auth.go:142-161`）属**凭据搬运**，
 *     不是登录；真要「不打开浏览器入池」，也应做成凭据导入而不是第二套登录。
 */

import { readFileSync } from "node:fs";
import { writeFile, rename, chmod } from "node:fs/promises";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
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
  expiresIn: string;
  /** 访问令牌到期时刻（epoch 毫秒；null = 取不到）。 */
  expiresAt: unknown;
  refreshExpiresIn: string;
  /** 刷新令牌到期时刻（epoch 毫秒；null = 取不到）。 */
  refreshExpiresAt: unknown;
  obtainedAt: string;
  source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  tokenType: "",
  scope: "",
  sessionState: "",
  domain: "",
  uid: "",
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
export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/** 从 JWT 载荷提取 sub 声明（转发共享层原语）。 */
function jwtSub(token: string): string {
  return sharedLogin.jwtSubject(token);
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
    expiresIn: str(rec["expiresIn"]),
    expiresAt: rec["expiresAt"] ?? null,
    refreshExpiresIn: str(rec["refreshExpiresIn"]),
    refreshExpiresAt: rec["refreshExpiresAt"] ?? null,
    obtainedAt: str(rec["obtainedAt"]),
    source: str(rec["source"]),
  };
  if (!c.accessToken) throw new NotLoggedInError();
  if (!c.uid) c.uid = jwtSub(c.accessToken);
  return c;
}

/**
 * 以 0600 权限写入凭证文件（Windows 上 chmod 意义有限，仍保持一致）。
 *
 * 先写临时文件再原子替换：写入过程崩溃不会留下半截 JSON 导致凭证损坏。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

function fromToken(
  access: string,
  refresh: string,
  tokenType: string,
  scope: string,
  session: string,
  domain: string,
): Credentials {
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: access,
    refreshToken: refresh,
    tokenType,
    scope,
    sessionState: session,
    domain,
    uid: jwtSub(access),
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

async function pollToken(baseUrl: string, state: string): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
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

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
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
        `(open the URL above in a browser; up to ${LOGIN_WINDOW_MS / 60000} min)…`,
    );
    const token = await pollToken(base, str(state["state"]));
    if (!token) {
      onStatus?.(`Round ${round} timed out, retrying…`);
      continue;
    }
    const c = fromToken(
      str(token["accessToken"]),
      str(token["refreshToken"]),
      str(token["tokenType"]),
      str(token["scope"]),
      str(token["sessionState"]),
      str(token["domain"]),
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

/**
 * 兼容别名：现规范名等同 `paths.credentialsPath()` 的文件名部分
 * （凭证落点由共享层按 cid 推导，见 docs/STORAGE-CONVENTION.md）。
 */
export const CREDENTIALS_FILE = "credentials.json";
