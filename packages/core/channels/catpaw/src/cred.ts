/**
 * CatPaw 认证：真实 URL 登录流程、凭证持久化与有效性探测。
 *
 * 关键约束（端点/字段/实测见 docs/channels/catpaw/PROTOCOL.md）：
 *   - token 只从 passport poll-token?sid= 取，无本地回调服务器；登录返回不透明 SSO token（非 JWT）。
 *   - 两个域别混：网关域（GATEWAY_HOST，X-Auth-Token）与直连域（upstream.DIRECT_HOST，X-Passport-Token + Cookie）
 *     共用同一 access_token 但头语义不同；DEFAULT_BASE_URL 固定为网关域。
 *   - 凭据只来自真实 URL 登录落盘，不得读桌面端本地文件；refresh() 只做 ping 有效性探测。
 *
 * 铁律：token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { readFileSync } from "node:fs";

import { credentialsPath, ensureDir, login as sharedLogin, writeJsonSecret } from "@modelmux/gateway";

const {
  fetchWithTimeout,
  randomHex,
  str,
  nowIso,
} = sharedLogin;

// ── 常量 ────────────────────────────────────────────────────────────────────

/**
 * 个人版网关域（登录 / 额度）。
 *
 * ⚠ 与 `upstream.ts` 的 `DIRECT_HOST`（直连域）**不是同一侧**：
 * 网关域鉴权用 `X-Auth-Token`，直连域鉴权用 `X-Passport-Token` + Cookie。
 * 两侧共用同一个 access_token（都出自 passport poll-token），但**头语义不同**。
 */
export const GATEWAY_HOST = "https://catx.nocode.cn";

/**
 * 登录配置端点（`GET`）。
 *
 * - query：无；body：无
 * - 响应：取 `data.loginEntryUrl`（见 `fetchLoginEntryUrl`）
 */
const LOGIN_CONFIG_URL = `${GATEWAY_HOST}/api/gateway/passport/login-config`;

/**
 * 令牌轮询端点（`GET`；**取 token 的唯一通道**）。
 *
 * - query：`sid` —— 本地生成的会话 id（`randomHex(16)`，见 `login`）；上游按它认本次登录会话
 * - body：无；响应：取 `data`（不透明 SSO token，非 JWT；见 `pollToken`）
 */
const POLL_TOKEN_URL = `${GATEWAY_HOST}/api/gateway/passport/poll-token`;

/**
 * 当前用户端点（`GET`；登录后取 uid，见 `fetchCurrentUserId`）。
 *
 * - query：无；body：无
 * - 鉴权：`X-Auth-Token: <accessToken>`（网关域头，与直连域的 `X-Passport-Token` 不是同一套）
 */
const CURRENT_USER_URL = `${GATEWAY_HOST}/api/gateway/passport/current-user`;

/**
 * 令牌有效性探测端点（`GET`；`refresh()` 用；401/403 = 确定失效）。
 *
 * - query：无；body：无
 * - 鉴权：`X-Auth-Token: <accessToken>`
 * - 判据：只有 401/403 算失效；5xx 与网络错误算临时故障（`[参考]` 参考实现的 `Ping()`）
 */
const AUTH_PING_URL = `${GATEWAY_HOST}/api/gateway/auth/ping`;

/**
 * `refresh()` 实际请求的 ping 地址。
 *
 * 测试/便携场景可用 `CATPAW_AUTH_PING_URL` 覆盖（照 `CLINE_API_BASE_URL`
 * 的惯例）—— 否则「离线自检」会因为一次有效性探测而变成出网测试。
 */
function authPingUrl(): string {
  return process.env["CATPAW_AUTH_PING_URL"] || AUTH_PING_URL;
}

/**
 * `redirect` 参数里用的回调路径。
 *
 * ⚠ 我们**不再监听**这个端口：它只是网关的必填参数（实测缺了 400），
 * token 一律从 `poll-token` 取。留着常量是为了 URL 形态与桌面端一致。
 */
const CALLBACK_PATH = "/callback";

/**
 * `redirect` 参数的 origin（同样**不监听**，见 `CALLBACK_PATH`）。
 *
 * 端口 37890 与参考实现一致（`[参考]` `reference/HITZY2002_catpaw2api/cmd/login/main.go:49`、
 * `internal/server/oauth.go:109`）—— 上游不校验可达性，保持形态一致更保险。
 */
const CALLBACK_ORIGIN = "http://127.0.0.1:37890";

/** 登录轮询周期（毫秒）。 */
const POLL_INTERVAL_MS = 1_000;
/** 登录轮询总超时（毫秒）。 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** HTTP 请求超时（毫秒）。 */
const HTTP_TIMEOUT_MS = 15_000;

const NOT_LOGGED_IN_MSG =
  "no credentials found; run `catpaw login` to complete browser authorization";

// ── 错误类型 ────────────────────────────────────────────────────────────────

/** 磁盘上不存在可用凭证。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

// ── 类型 ────────────────────────────────────────────────────────────────────

/**
 * 凭据对象。catpaw 的无头登录 token 是不透明 SSO token（非 JWT），
 * 所以没有 uid/domain 可从 token 里解出来 —— 这两字段通常为空。
 */
export interface Credentials {
  /** 不透明 SSO token（上游请求里放在 Cookie: X-Passport-Token）。 */
  accessToken: string;
  /** 用户 uid（`/api/gateway/passport/current-user` 的 `userId`）。 */
  uid: string;
  /**
   * 账号名（同一端点的 `userName`，取不到回落 `mobile`）。
   *
   * 只取 userId 的话，Web 账号池只能显示脱敏 uid；`userName` 才是
   * 可读的账号标识。
   */
  nickname: string;
  /** 登录域（无头登录不涉及多域，通常为空）。 */
  domain: string;
  /** 凭证来源，如 "catpaw-login-poll"。 */
  source: string;
  /** 获得时刻（ISO 8601）。 */
  obtainedAt: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  uid: "",
  nickname: "",
  domain: "",
  source: "",
  obtainedAt: "",
};

// ── 登录基址 ────────────────────────────────────────────────────────────────

/**
 * 默认登录基址（catpaw 无独立登录域，登录走 passport 网关）。
 *
 * ⚠ 契约要求 `cred` 模块导出 `DEFAULT_BASE_URL`（共享层 `auth/auth-flow.ts` 读它做登录），
 * 语义固定为**网关域**。直连域在 `upstream.ts` 的 `DIRECT_HOST` —— 两者**同名不同值**，
 * 引用时务必写清是哪一侧。
 */
export const DEFAULT_BASE_URL = GATEWAY_HOST;

/** 解析登录基址。catpaw 只有一个域，realm 参数仅作兼容保留。 */
export function resolveBaseUrl(realm = "auto"): string {
  return GATEWAY_HOST;
}

// ── 读取 ────────────────────────────────────────────────────────────────────

/** 从磁盘读取凭据。缺失 / 损坏 / 空 token 一律抛 NotLoggedInError。 */
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
  const accessToken = str(rec["access_token"]) || str(rec["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();
  return {
    accessToken,
    uid: str(rec["uid"]),
    nickname: str(rec["nickname"]),
    domain: str(rec["domain"]),
    source: str(rec["source"]) || "catpaw-login-poll",
    obtainedAt: str(rec["obtained_at"]) || str(rec["obtainedAt"]) || nowIso(),
  };
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 以 0600 权限写入凭据文件。先写临时文件再原子替换：
 * 写入过程崩溃不会留下半截 JSON 导致凭证损坏。
 * 写法统一走共享层 `writeJsonSecret`（tmp → rename → 0600），不再各写一遍。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), c);
}

// ── 登录 ────────────────────────────────────────────────────────────────────

/** 解析 login-config 响应，取出 loginEntryUrl。 */
async function fetchLoginEntryUrl(): Promise<string> {
  const resp = await fetchWithTimeout(LOGIN_CONFIG_URL, {
    headers: { Accept: "application/json" },
  }, HTTP_TIMEOUT_MS);
  if (resp.status !== 200) throw new Error(`login-config request failed: HTTP ${resp.status}`);
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(`login-config request failed: invalid JSON: ${String(err)}`);
  }
  const data =
    body && typeof body === "object" && !Array.isArray(body)
      ? ((body as Record<string, unknown>)["data"] as Record<string, unknown> | undefined)
      : undefined;
  const entry = str(data?.["loginEntryUrl"]);
  if (!entry) throw new Error("login-config did not return loginEntryUrl");
  return entry;
}

/**
 * 拼出完整 auth_url（三参数缺一不可）—— **auth_url 的唯一构造点**。
 *
 * `redirect` 只是网关的必填形式参数（缺了直接 400），我们并不监听它 ——
 * token 一律从 `poll-token?sid=` 取（见 `login()`）。
 *
 * @param loginEntryUrl `login-config` 返回的入口地址
 * @param redirect 回调地址（形式参数，不要求可达）
 * @param sid   会话 id；缺省时本地生成（轮询要用同一个值，故由调用方传入）
 * @param state 防 CSRF 随机串；缺省时本地生成
 */
function buildAuthUrl(loginEntryUrl: string, redirect: string, sid?: string, state?: string): string {
  const s = sid ?? randomHex(16);
  const st = state ?? randomHex(16);
  const encRedirect = encodeURIComponent(redirect);
  return `${loginEntryUrl}?sid=${s}&state=${st}&redirect=${encRedirect}`;
}

/**
 * 轮询 poll-token，成功返回 token 字符串，超时返回 null。
 *
 * 这是**唯一**的取 token 通道（本地回调那条路已删除，理由见 `login()`）。
 * `signal` 用于外部取消；返回 `null` 表示超时或被取消 —— 调用方按「没拿到」处理。
 */
async function pollToken(sid: string, signal?: AbortSignal): Promise<string | null> {
  const url = `${POLL_TOKEN_URL}?sid=${encodeURIComponent(sid)}`;
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    try {
      const resp = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      }, HTTP_TIMEOUT_MS);
      if (resp.status === 200) {
        const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        const token = str(body?.["data"]);
        if (token.length > 20) return token;
      }
    } catch {
      if (signal?.aborted) return null;
      /* 轮询失败下一轮再试 */
    }
    // 可被 signal 唤醒的等待：取消时立刻结束，不必等满 1 秒
    await new Promise<void>((r) => {
      if (signal?.aborted) return r();
      const timer = setTimeout(r, POLL_INTERVAL_MS);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
  return null;
}

/**
 * 拉取当前登录用户（uid + 账号名）。
 *
 * 参考实现（HITZY2002 / icebears111 catpaw2api）登录后都有这一步：`poll-token`
 * 只给不透明 token，**uid 与账号名都要另取**。`uid` 不是可有可无的展示字段 ——
 * 账号池靠它认「同一个账号」（`accountKey` 在 uid 为空时退化成按 token 建键，
 * 而 token 每次登录都变，于是同一账号会被重复记成多条）。
 *
 * 失败不阻塞登录：拿不到就留空，由账号池按 token 退化处理。
 */
async function fetchCurrentUser(token: string): Promise<{ uid: string; nickname: string }> {
  try {
    const resp = await fetchWithTimeout(CURRENT_USER_URL, {
      headers: { "X-Auth-Token": token, Accept: "application/json" },
    }, HTTP_TIMEOUT_MS);
    if (resp.status !== 200) return { uid: "", nickname: "" };
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    const data = body?.["data"];
    if (!data || typeof data !== "object" || Array.isArray(data)) return { uid: "", nickname: "" };
    const rec = data as Record<string, unknown>;
    let uid = "";
    // 字段名以参考实现为准（userId）；其余为历史/变体写法。
    //
    // ⚠ 不能直接用共享的 `str()`：它只认字符串，而上游实测返回的是**数字**
    //   （`"userId": 1234567890`，数字形态）—— 用 `str()` 会把 uid 静默丢成空串，
    //   账号池随即退化成按 token 建键（同一账号登录两次记成两条）。
    for (const key of ["userId", "uid", "user_id", "id"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) {
        uid = value.trim();
        break;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        uid = String(value);
        break;
      }
    }
    // 账号名：`userName` 优先，`mobile` 兜底（都是同一个端点返回的展示字段）
    let nickname = "";
    for (const key of ["userName", "nickname", "name", "mobile"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) {
        nickname = value.trim();
        break;
      }
    }
    return { uid, nickname };
  } catch {
    return { uid: "", nickname: "" };
  }
}

/** 从登录响应构建凭据对象。 */
function fromToken(token: string, source: string, uid = "", nickname = ""): Credentials {
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: token,
    uid,
    nickname,
    domain: "",
    source: source || "catpaw-login",
    obtainedAt: nowIso(),
  };
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

/**
 * 运行交互式浏览器登录并持久化结果。
 *
 * 只有一条取 token 通道：`poll-token?sid=`。早期还起过本地 loopback 回调服务器与
 * 轮询并行 race，但三次真机登录回调一次都没赢（`source` 恒为 `catpaw-login-poll`），
 * 故删除 —— 多一条通道只增维护面。
 *
 * `redirect` 仍必须传（实测不带它网关直接 400），但只是协议要求的形式参数，
 * 不要求真实可达。
 *
 * 流程：拼 auth_url（sid/state/redirect）→ 交给用户打开 → 每 1s 轮询 → 取 uid → 落盘。
 */
export async function login(baseUrl: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  void baseUrl; // catpaw 只有一个登录域，参数仅作兼容保留

  onStatus?.("正在获取登录入口...");
  const loginEntryUrl = await fetchLoginEntryUrl();

  // redirect 是网关的**必填**参数（实测缺它直接 400），但只是形式要求：
  // 我们不监听该端口，token 一律从 poll-token 取。
  const sid = randomHex(16);
  const state = randomHex(16);
  const redirect = `${CALLBACK_ORIGIN}${CALLBACK_PATH}`;
  const finalAuthUrl = buildAuthUrl(loginEntryUrl, redirect, sid, state);

  onUrl?.(finalAuthUrl);
  onStatus?.('Open the URL above in your browser and complete the login (the page shows "登录成功" when done)');

  onStatus?.("等待授权中（最长 10 分钟）...");

  const token = await pollToken(sid);
  if (!token) throw new Error("poll timeout: no login detected within 10 minutes");

  // 取 uid 与账号名：账号池靠 uid 认「同一个账号」（见 fetchCurrentUser）
  onStatus?.("登录成功，正在拉取账号信息...");
  const { uid, nickname } = await fetchCurrentUser(token);

  const c = fromToken(token, "catpaw-login-poll", uid, nickname);
  await save(c);
  return c;
}

// ── 刷新 ────────────────────────────────────────────────────────────────────

/**
 * catpaw 没有独立的 token 刷新端点（登录链路只在首次登录时给出 token）。
 *
 * 因此 `refresh()` 做**有效性探测**（`/api/gateway/auth/ping`）：
 *
 * - `401/403` → 令牌**确定失效**，抛错让调用方引导重新登录
 * - `2xx/3xx` → 仍有效，原样返回
 * - 其它（5xx / 网络错误）→ **临时故障**，也返回原凭据
 *
 * ⚠ 早期实现无条件抛错，等于把「上游抖了一下」也判成「需要重新登录」，
 * 网关的 401 失败转移（failover）会因此把好账号踢出轮换。区分依据来自参考实现
 * （`catpaw2api` 的 `Ping()`：只有 401/403 才算失效）。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  // 顺带回填缺失的 uid（老凭据修复；幂等，uid 已有值时不发请求）
  const withUid = await ensureUid(c);
  let resp: Response;
  try {
    resp = await fetchWithTimeout(authPingUrl(), {
      headers: { "X-Auth-Token": withUid.accessToken, Accept: "application/json" },
    }, HTTP_TIMEOUT_MS);
  } catch (err) {
    // 网络不通：无法判定失效，按「暂时故障」处理，不惊动用户重登
    throw new Error(`catpaw token validation failed (network error, retry later): ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("catpaw token is invalid (upstream 401/403); re-run `catpaw login`");
  }
  // 其余状态（含 5xx）都按「暂时无法判定失效」处理：返回原凭据，不逼用户重登。
  return withUid;
}

/**
 * 回填缺失的 uid（老凭据修复）。
 *
 * 早期版本的登录链路不取 uid，磁盘上会留下 `uid: ""` 的凭据；账号池因此退化成
 * 按 token 建键（同一账号重复记多条）。这里在**读凭据时顺带补一次**：
 * 拿到 uid / 账号名就落盘，拿不到就原样返回 —— 不回填失败不阻塞任何调用方。
 *
 * 幂等：uid 与账号名都已有值时直接返回，不产生网络请求。
 */
async function ensureUid(c: Credentials): Promise<Credentials> {
  if (c.uid && c.nickname) return c;
  const { uid, nickname } = await fetchCurrentUser(c.accessToken);
  if (!uid && !nickname) return c;
  const next: Credentials = {
    ...c,
    uid: c.uid || uid,
    nickname: c.nickname || nickname,
  };
  await save(next);
  return next;
}