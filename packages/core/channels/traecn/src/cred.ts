/**
 * TRAE 凭据：浏览器授权登录、设备指纹、续期与落盘。
 *
 * 关键约束（端点/字段/实测见 docs/channels/traecn/PROTOCOL.md）：
 *   - 登录只有 `login()` 一条路径（浏览器授权 + 本地回调），不提供第二种登录方式。
 *   - 设备指纹按账号确定性派生且每账号互不相同（`deriveCheckinDeviceId` / `deriveMarketUserId`），同日两账号共用会被「该设备已签到」拦截。
 *   - 续期（`refresh()`）同时轮换 access 与 refresh，成功后必须回写。
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  loginFlow,
  paths,
  prefsPath,
  writeSecretFile,
} from "@modelmux/gateway";

/**
 * agentHost（对话 + 模型列表）。
 *
 * 契约要求 `cred` 与 `upstream` **都**导出 `DEFAULT_BASE_URL`；
 * 两处同值不同源迟早漂移，故只在这里定义一次，`upstream.ts` 直接转出这一份。
 */
export const DEFAULT_BASE_URL = "https://trae-api-cn.mchost.guru";

/** OAuth host（ExchangeToken / GetUserInfo）。 */
const OAUTH_HOST = "https://api.trae.com.cn";

/**
 * OAuth 端点：`POST {oauthHost}/cloudide/api/v3/trae/oauth/ExchangeToken`。
 * 请求体字段见 PROTOCOL。
 *
 * 实现侧：host 可用凭据的 `api_host` 覆盖（见 `Credentials.apiHost`）。
 * 来源：参考实现 `reference/autumnsentiment_Trae2api-cn/src/auth.py`（`refresh_token`）、
 *   `reference/JeffHu0912_trae2api/internal/upstream/constants.go`（`EpExchange`）
 */
const OAUTH_EXCHANGE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";

/**
 * OAuth 端点：`POST {oauthHost}/cloudide/api/v3/trae/GetUserInfo`。请求体字段见 PROTOCOL。
 *
 * 实现侧：鉴权走 **`x-cloudide-token`**，**不能**用 `Authorization: Cloud-IDE-JWT`（会 401）。
 * 来源：参考实现 `reference/autumnsentiment_Trae2api-cn/src/trae_client.py`（`fetch_user_info`）、
 *   `reference/JeffHu0912_trae2api/login.sh`（`GetUserInfo` 段）
 */
const OAUTH_USER_INFO_PATH = "/cloudide/api/v3/trae/GetUserInfo";

/** 签到 / 积分 host（规格里是硬编码，未用 product.ugHost）。 */
const UG_HOST = "https://api.trae.cn";

/** 登录门户（consoleHost）。 */
const CONSOLE_HOST = "https://www.trae.cn";

/**
 * 网页授权门户的 client_id（tr 兆 web 端身份）。
 *
 * 与 IDE 客户端 ID（对话链路用）不同：授权页只认 web 端 ID，
 * 传 IDE ID 会直接 404（对齐 trae2api 实测）。
 */
const CLIENT_ID = "ono9krqynydwx5";
/**
 * SOLO 产品线的 client_id（dingminhua 四版本矩阵）：refresh token 与 client_id 的归属
 * 由 OAuth client 强制，**旧端点同样生效** —— 拿 SOLO 线 token 在桌面 ID 下换票回
 * `10101 not matched to the client`（与假令牌的 `20101 invalid` 形态不同），换对 ID 可解。
 */
const CLIENT_ID_SOLO = "en1oxy7wnw8j9n";
/**
 * SOLO/IDE 应用的 AppID（对话与 Solo 目录的 `X-App-Id`）。
 *
 * **上游按 AppID 查「app config」记录**：AppID 不对就直接
 * `2001 failed to get app config: record not found`（HTTP 200，流内 error 帧）。
 * 本值必须是 `…01c…` —— 旧的 `…01a…` 记录已被上游撤下。
 * 参考实现逐字一致：`autumnsentiment_Trae2api-cn/src/trae_client.py:47`、
 * `JeffHu0912_trae2api/internal/upstream/constants.go:10`、
 * `connectedGraph/trae2api-web/internal/upstream/constants.go:10`、
 * `A-23187_trae-api/auth.js:48`（`[参考]`）；`[实测]` 见
 * `docs/channels/traecn/PROTOCOL.md` §3.1.1。
 */
export const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/** ideVersion 是模型准入条件：版本过低时 glm-5.3 等新模型报 4001。 */
export const IDE_VERSION = "0.1.52";
export const IDE_VERSION_CODE = "20260811";
/** 登录 URL 用的 pluginVersion（≠ ideVersion）。 */
const PLUGIN_VERSION = "2.3.62834";
export const USER_AGENT = "Trae/0.1.52";

/**
 * 回调监听端口 / 绑定地址 / 对外地址（三个都能用环境变量覆盖）。
 *
 * 默认只绑 `127.0.0.1`：桌面形态下浏览器与网关同机，回环足够且不对外暴露。
 * 容器部署时浏览器打不到容器的回环（Docker 端口发布 DNAT 到 `eth0`，只监听
 * `lo` 收不到），必须改绑 `0.0.0.0` 并给出宿主机可达的对外地址。
 *
 * `TRAECN_PUBLIC_HOST` 单独存在是因为 `0.0.0.0` 不能出现在授权 URL 里 ——
 * 上游会把回调地址原样回填进浏览器跳转，写 `0.0.0.0` 就跳不过去。
 * 实测上游**不校验**回调地址（连 `not-a-url` 都原样回显），故非回环可用。
 */
const CALLBACK_PORT = Number(process.env["TRAECN_LOGIN_PORT"] ?? "18080");
const LISTEN_HOST = process.env["TRAECN_LOGIN_HOST"] ?? "127.0.0.1";
const PUBLIC_HOST = process.env["TRAECN_PUBLIC_HOST"] ?? LISTEN_HOST;
const CALLBACK_PATH = "/authorize";

/**
 * 绑非回环却没给对外地址时直接拒绝启动登录。
 *
 * 两者缺一都跑不通：只改 LISTEN_HOST 会让授权 URL 里出现 `0.0.0.0`（浏览器
 * 跳不过去），而只给 PUBLIC_HOST 又绑在回环上（外部请求打不进来）。配置错误
 * 在登录开始时报出来，比让用户等到十分钟超时好。
 */
function assertCallbackConfig(): void {
  const loopback = LISTEN_HOST === "127.0.0.1" || LISTEN_HOST === "localhost";
  if (loopback) return;
  const publicIsLoopback =
    PUBLIC_HOST === "127.0.0.1" || PUBLIC_HOST === "localhost" || PUBLIC_HOST === "0.0.0.0";
  if (publicIsLoopback) {
    throw new Error(
      `TRAECN_LOGIN_HOST=${LISTEN_HOST} 绑非回环地址时必须同时设 TRAECN_PUBLIC_HOST 为外部可达的主机名或 IP` +
        `（0.0.0.0 不能写进授权 URL，浏览器会跳不过去）`,
    );
  }
}
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30_000;

const NOT_LOGGED_IN_MSG = "no credentials found; run `traecn login` first";

/** 磁盘上不存在可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 登录/续期要求重新登录（终态）。 */
class ReloginRequiredError extends Error {
  override name = "ReloginRequiredError";
}

/**
 * 凭据（磁盘字段与渠道包一致：snake_case）。
 *
 * 同时保留契约要求的 `accessToken` / `uid` / `domain` 形态。
 */
export interface Credentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 毫秒字符串（兼容秒/ISO/JWT exp 兜底）。 */
  readonly expiresAt: string;
  readonly uid: string;
  readonly nickname: string;
  readonly phone: string;
  readonly email: string;
  /** 登录后绝不变，32 位 hex。 */
  readonly machineId: string;
  /** 每账号互不相同，32 位 hex。 */
  readonly deviceId: string;
  readonly enterpriseId: string;
  /** 绑定的域（agentHost）。 */
  readonly domain: string;
  /** 续期用的 OAuth host 覆盖（部分账号下发）。 */
  readonly apiHost?: string;
  /** 签到设备派生的代数（9074 时 +1）。 */
  readonly checkinGeneration?: number;
  readonly obtainedAt?: string;
}

/** 上游 OAuth host（可用 TRAE_OAUTH_HOST 覆盖，便于离线自检）。 */
function oauthHost(): string {
  return (process.env["TRAE_OAUTH_HOST"] || OAUTH_HOST).replace(/\/+$/, "");
}

/** 签到 host（可用 TRAE_UG_HOST 覆盖，便于离线自检）。 */
export function ugHost(): string {
  return (process.env["TRAE_UG_HOST"] || UG_HOST).replace(/\/+$/, "");
}

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

function intOrZero(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readPrefs(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 支持的域（源码中不存在国际版配置，只有这一份 CN 配置）。 */
const REALMS: Record<string, string> = {
  cn: DEFAULT_BASE_URL,
};

/**
 * 把 realm 参数解析为 agentHost。
 *
 * 查表用 `hasOwn` 而不是 `in`：`in` 会走原型链，`--realm constructor` / `toString`
 * 命中 `Object.prototype` 上的成员，于是「返回」一个函数、baseUrl 变成
 * `"function Object() { [native code] }"`，登录请求打向一个不存在的域，
 * 而错误信息完全看不出是 realm 写错了。非法 realm 必须落到下面的显式抛错。
 */
export function resolveBaseUrl(realm = "auto"): string {
  if (Object.hasOwn(REALMS, realm)) return REALMS[realm]!;
  if (realm === "intl") {
    // TRAE 源码中不存在国际版配置，明确报错比把用户导向一个不存在的域更好。
    throw new Error("TRAE only has a CN config (trae-api-cn.mchost.guru); intl is unsupported, use auto or cn");
  }
  if (realm !== "" && realm !== "auto") throw new Error(`Unknown realm: ${realm}`);
  try {
    const c = load();
    if (c.domain) return `https://${c.domain}`;
  } catch {
    /* 未登录/损坏都走默认 */
  }
  const saved = readPrefs()["realm"];
  if (typeof saved === "string" && Object.hasOwn(REALMS, saved)) return REALMS[saved]!;
  return DEFAULT_BASE_URL;
}

/** 从 URL 提取主机名（转发共享层原语）。 */
function hostOf(url: string): string {
  return sharedLogin.hostOf(url);
}

// ── 设备指纹 ─────────────────────────────────────────────────────────────────

/** SHA-256 的 hex 摘要（转发共享层原语）。 */
const sha256Hex = sharedLogin.sha256Hex;

function generateMachineId(): string {
  return randomBytes(16).toString("hex"); // 32 位 hex
}

/** device_id 必须每账号互不相同（同日共用会被「该设备已签到」拦截）。 */
function generateDeviceId(): string {
  return randomBytes(16).toString("hex"); // 32 位 hex
}

/**
 * 签到设备标识：`sha256("devid:" + uid + ⋯counterBE32) ` 的确定性派生。
 *
 * 取前 32 hex 十进制化后的前 15 位 ⇒ 15 位数字、每账号稳定唯一，
 * 从而规避「每设备每天一次」配额；9074（设备级限流）时换 `generation` 轮换。
 */
export function deriveCheckinDeviceId(uid: string, generation = 0): string {
  const hash = createHash("sha256");
  hash.update(`devid:${uid}`, "utf8");
  const counter = Buffer.alloc(4);
  for (let i = 0; i <= Math.max(0, generation); i += 1) {
    counter.writeUInt32BE(i, 0);
    hash.update(counter);
  }
  const hex = hash.digest("hex").slice(0, 32);
  const digits = BigInt(`0x${hex}`).toString(10);
  return digits.slice(0, 15).padEnd(15, "0");
}

/** 签到头里的市场用户标识：确定性派生 UUID v4。 */
export function deriveMarketUserId(uid: string): string {
  const hex = sha256Hex(`market:${uid}`).slice(0, 32).split("");
  hex[12] = "4"; // version 4
  const variant = (Number.parseInt(hex[16]!, 16) & 0x3) | 0x8; // RFC4122 variant
  hex[16] = variant.toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 签到头里的 VSCode 会话 id：确定性派生 64 hex。 */
export function deriveSessionId(uid: string): string {
  return sha256Hex(`sess:${uid}`);
}

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ASCII_RE = /^[\x20-\x7E]+$/;

/**
 * 修复昵称的 latin-1 双重编码乱码。
 *
 * 规则（实测）：先尝试 latin-1 → utf8；修得出来且更像正常文本就用修复值；
 * 否则保留原文（含 CJK 时）；再否则回退 `用户+uid末4位`。
 */
function fixNickname(raw: string, uid = ""): string {
  const fallback = uid.length >= 4 ? `用户${uid.slice(-4)}` : "用户";
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  if (ASCII_RE.test(trimmed)) return trimmed; // 纯 ASCII 本来就是正常昵称
  const repaired = Buffer.from(trimmed, "latin1").toString("utf8");
  const broken = repaired.includes("\uFFFD");
  if (!broken && repaired !== trimmed && (CJK_RE.test(repaired) || !CJK_RE.test(trimmed))) {
    return repaired;
  }
  if (CJK_RE.test(trimmed)) return trimmed;
  return fallback;
}

// ── 登录 URL 与回调 ──────────────────────────────────────────────────────────

/**
 * 构造登录 URL（网页授权门户形态，20 个参数；对齐 trae2api 实测）。
 *
 * 参数名必须是 `auth_callback_url`；没有 `callback_url`/`redirect_uri` ——
 * 写错登录页永远停在授权中。
 * client_id 必须是网页端 `ono9krqynydwx5`（IDE 客户端 ID 会被门户 404）；
 * ExchangeToken/GetUserInfo 也用同一 client_id，保证 token 与兑换域一致。
 */
function buildAuthorizeUrl(
  callbackUrl: string,
  machineId: string,
  deviceId: string,
  consoleHost?: string,
): string {
  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: PLUGIN_VERSION, // ≠ ideVersion
    auth_type: "local",
    client_id: CLIENT_ID,
    redirect: "0",
    login_trace_id: `${machineId}${deviceId}`.slice(-16),
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: "PC",
    x_device_type: "PC",
    x_os_version: "1.0",
    x_env: "",
    x_app_version: IDE_VERSION,
    x_app_type: "stable",
    // 网页授权门户要求：不带会 404（对齐 trae2api 实测）
    hide_saas_login: "true",
  });
  return `${(consoleHost || CONSOLE_HOST).replace(/\/+$/, "")}/authorization?${params.toString()}`;
}

interface CallbackFields {
  access_token: string;
  refresh_token: string;
  uid: string;
  nickname: string;
  phone: string;
  email: string;
  enterprise_id: string;
  api_host: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pick(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * 解析登录回调参数。
 *
 * 回调**直接回传 token**（query 里的 `refreshToken`、`userJwt.Token`），
 * 不是 OAuth `?code=`；PKCE 变体（`code`/`authCode`/`authCodeInfo`）明确报错。
 * TenantID 才是租户标识（不是 EnterpriseID）。
 */
function parseCallback(flat: Record<string, unknown>): CallbackFields {
  const userInfo = parseJsonObject(flat["userInfo"] ?? flat["user_info"]);
  const userJwt = parseJsonObject(flat["userJwt"] ?? flat["user_jwt"]);

  const accessToken =
    pick(userJwt["Token"]) ||
    pick(userJwt["token"]) ||
    pick(flat["token"]) ||
    pick(flat["accessToken"]) ||
    pick(flat["access_token"]);
  const refreshToken =
    pick(flat["refreshToken"]) ||
    pick(flat["refresh_token"]) ||
    pick(userJwt["RefreshToken"]) ||
    pick(userJwt["refresh_token"]);

  if (!accessToken && !refreshToken) {
    const pkce = pick(flat["code"]) || pick(flat["authCode"]) || pick(flat["authCodeInfo"]);
    if (pkce) {
      throw new Error(
        "Upstream used the PKCE flow (callback only carries code/authCode), which this implementation does not support; update the gateway or use another login method",
      );
    }
    throw new Error("Callback has no token: upstream may have changed the callback format");
  }

  const uid = pick(userInfo["UserID"]) || pick(userInfo["userId"]) || pick(flat["uid"]);
  const rawNickname = pick(userInfo["ScreenName"]);
  const phone =
    pick(userInfo["NonPlainTextMobile"]) ||
    pick(userInfo["Mobile"]) ||
    pick(flat["phone"]);
  const email =
    pick(userInfo["NonPlainTextEmail"]) || pick(userInfo["Email"]) || pick(flat["email"]);
  const apiHost = pick(flat["api_host"]) || pick(flat["apiHost"]) || pick(userInfo["ApiHost"]);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    uid,
    nickname: fixNickname(rawNickname, uid),
    phone,
    email,
    enterprise_id: pick(userInfo["TenantID"]) || pick(userInfo["tenantId"]),
    api_host: apiHost,
  };
}

/** 本地回调服务器：收到一次回调后即可 `wait()` 出参数。 */
interface CallbackServer {
  port: number;
  wait(timeoutMs: number): Promise<Record<string, string>>;
  close(): void;
}

/** 回调页：复用共享层（自动尝试自关 + 深色单页），不再各写一份。 */
const CALLBACK_HTML = loginFlow.callbackPageHtml("ok");

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, LISTEN_HOST, () => {
      server.removeListener("error", onError);
      const address = server.address() as { port: number } | null;
      resolve(address?.port ?? port);
    });
  });
}

/**
 * 启动本地回调服务器（默认 `127.0.0.1:18080`）。
 *
 * 端口被占用（EADDRINUSE/EACCES）时回退随机端口 —— 调用方必须用返回的
 * 实际端口重算登录 URL。
 *
 * **只认本次登录的 nonce 路径**：绑非回环时同网段任何人都能打到这个端口，
 * 若不校验就变成登录 CSRF —— 攻击者在自己登录期间抢先 GET
 * `/authorize?access_token=<他的 token>`，本机就用他的凭据入池，之后所有
 * 请求与数据都落到他账号上。路径里的 nonce 每次登录重新生成，猜不到。
 */
async function startCallbackServer(
  nonce: string,
  port = CALLBACK_PORT,
): Promise<CallbackServer> {
  let resolveParams: (value: Record<string, string>) => void = () => {};
  let rejectParams: (err: Error) => void = () => {};
  const params = new Promise<Record<string, string>>((resolve, reject) => {
    resolveParams = resolve;
    rejectParams = reject;
  });
  // close() 可能早于 wait()：先挂一个吞掉的 catch，避免 unhandled rejection 噪音
  void params.catch(() => {});
  let settled = false;
  const expectedPath = `${CALLBACK_PATH}/${nonce}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // 路径必须带本次登录的 nonce：浏览器预取、重复登录、探测、以及同网段的
    // 注入尝试都因路径不符被挡在 404。`flat` 里没有 token 的请求即使路径对，
    // 也会在 parseCallback 的「no token」上失败。
    if (url.pathname !== expectedPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in flat)) flat[key] = value; // 同名参数取第一个
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(CALLBACK_HTML);
    if (!settled) {
      settled = true;
      resolveParams(flat);
    }
  });

  let actualPort: number;
  try {
    actualPort = await listenOn(server, port);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    actualPort = await listenOn(server, 0);
  }

  return {
    port: actualPort,
    wait(timeoutMs: number): Promise<Record<string, string>> {
      return new Promise<Record<string, string>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Timed out waiting for the authorization callback (${Math.round(timeoutMs / 1000)}s)`));
          }
        }, timeoutMs);
        params.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    },
    close(): void {
      try {
        server.close();
        server.closeAllConnections?.();
      } catch {
        /* 已关闭 */
      }
      if (!settled) {
        settled = true;
        rejectParams(new Error("callback server closed"));
      }
    },
  };
}

/** 粘贴兜底的轮询周期：与回调服务器并存竞争，谁先到用谁。 */
const PASTE_POLL_MS = 400;

/**
 * 等回调：本地监听与粘贴兜底两条通道竞争，先到的胜出。
 *
 * 容器部署时浏览器打不到容器回环，本地监听永远等不到 —— 粘贴通道是那时
 * 唯一能走通的路。桌面形态下两条都在，正常走本地监听，粘贴框空着不影响。
 */
async function waitForCallback(
  callback: CallbackServer,
  pasteCode: (() => string | undefined) | undefined,
  nonce: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  if (typeof pasteCode !== "function") return callback.wait(timeoutMs);

  const deadline = Date.now() + timeoutMs;
  // 轮询用 unref 定时器：输掉竞争后不必等它自然超时，进程可以直接退出
  const sleepUnref = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  const polling = (async (): Promise<Record<string, string>> => {
    for (;;) {
      if (Date.now() >= deadline) throw new Error("waiting for pasted callback timed out");
      const pasted = pasteCode();
      const parsed = typeof pasted === "string" ? parsePastedCallback(pasted, nonce, PUBLIC_HOST) : null;
      if (parsed !== null) return parsed;
      await sleepUnref(PASTE_POLL_MS);
    }
  })();

  // 输掉的一方留着会拖住事件循环（回调服务器已 close / 轮询仍在跑）——
  // 用 finally 收尾，胜出后立刻停掉另一条。
  // 输掉的 polling 在超时时会 reject：先挂一个吞掉的 catch，避免 unhandled rejection。
  void polling.catch(() => {});
  try {
    return await Promise.race([callback.wait(timeoutMs), polling]);
  } finally {
    callback.close();
  }
}

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /**
   * 取走用户粘回的回调链接（共享层在控制台 / CLI 里注入）。
   *
   * 回调监听器绑在容器回环上时浏览器打不到，这条是唯一的兜底通道：
   * 用户把地址栏里那整条 URL 粘回来，同样能解析出 token。
   */
  pasteCode?: () => string | undefined;
}

/**
 * 从粘贴文本里捞回调参数。
 *
 * 三关全过才认，少一关就是登录 CSRF（攻击者诱导用户粘一条他自己的回调，
 * 本机就以他的身份入池）：
 *   1. 能解析成 URL；
 *   2. host 必须是本次登录的对外地址（或回环）；
 *   3. path 必须是 `CALLBACK_PATH/<本次 nonce>`。
 */
function parsePastedCallback(
  text: string,
  nonce: string,
  expectedHost: string,
): Record<string, string> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const allowed = new Set([expectedHost.toLowerCase(), "127.0.0.1", "localhost", "[::1]", "::1"]);
  if (!allowed.has(host)) return null;
  if (url.pathname !== `${CALLBACK_PATH}/${nonce}`) return null;
  const flat: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!(key in flat)) flat[key] = value;
  }
  return flat;
}

/**
 * 运行一次浏览器授权登录并持久化结果。
 *
 * **本模块唯一的登录路径**（判据见文件头「唯一登录路径」）。流程：
 * 浏览器授权 → 本地回调 → 解析回调 →（老流程时）`ExchangeToken` 兑换 →
 * `GetUserInfo` 补全账号信息 → 落盘。
 *
 * @param baseUrl 仅作为对话域落盘（realm 解析用），不参与授权 URL。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  assertCallbackConfig();
  const machineId = generateMachineId();
  const deviceId = generateDeviceId();
  // 每次登录一条独立 nonce：回调路径猜不到，挡同网段的登录注入
  const nonce = randomBytes(16).toString("hex");
  const callback = await startCallbackServer(nonce);
  try {
    const callbackUrl = `http://${PUBLIC_HOST}:${callback.port}${CALLBACK_PATH}/${nonce}`;
    // 授权页固定在 consoleHost（www.trae.cn）；共享层传入的 baseUrl 是 agentHost，误传会导致登录域名错误
    const authorizeUrl = buildAuthorizeUrl(callbackUrl, machineId, deviceId);
    onUrl?.(authorizeUrl); // 拿到 URL 立刻回调（命令行展示，用户自行打开）
    // 绑非回环时把风险说清楚：回调带 token，同网段可嗅探
    onStatus?.(
      LISTEN_HOST === "127.0.0.1" || LISTEN_HOST === "localhost"
        ? `等待授权回调（本地端口 ${callback.port}）…`
        : `等待授权回调（${LISTEN_HOST}:${callback.port}）… 回调地址对本网段可见，只在可信网络使用`,
    );

    const flat = await waitForCallback(callback, options.pasteCode, nonce, LOGIN_TIMEOUT_MS);
    const fields = parseCallback(flat);

    // 老流程：回调只带 refreshToken（不带 userJwt.Token）→ 先兑换出 access token。
    // 不兑换的话落盘的 access_token 为空，`load()` 会直接判定「未登录」。
    let accessToken = fields.access_token;
    let refreshToken = fields.refresh_token;
    let expiresAt = normalizeExpiresAt(undefined, accessToken);
    if (!accessToken && refreshToken) {
      onStatus?.("回调里没有 access token，改用 refresh token 换取…");
      let pair: TokenPair;
      try {
        pair = await exchangeToken(refreshToken);
      } catch (err) {
        throw new Error(`ExchangeToken failed during login: ${String(err)}`);
      }
      accessToken = pair.accessToken;
      refreshToken = pair.refreshToken;
      expiresAt = pair.expiresAt;
    }
    if (!accessToken) {
      throw new Error("Callback carries no usable access token; please log in again");
    }

    // GetUserInfo 补全账号信息（uid / 昵称 / 脱敏手机号 / 脱敏邮箱 / 企业 id）。
    // 失败不阻塞登录：沿用回调里的 userInfo（与参考实现同口径）。
    const info = await fetchUserInfo(accessToken);
    if (info) {
      onStatus?.("已通过 GetUserInfo 刷新账号信息。");
    } else {
      onStatus?.("GetUserInfo 不可用，沿用回调里的账号信息。");
    }

    const c: Credentials = {
      accessToken,
      refreshToken,
      expiresAt,
      uid: info?.uid || fields.uid,
      nickname: info?.nickname || fields.nickname,
      phone: info?.phone || fields.phone,
      email: info?.email || fields.email,
      machineId,
      deviceId,
      enterpriseId: info?.enterpriseId || fields.enterprise_id,
      domain: hostOf(DEFAULT_BASE_URL),
      apiHost: fields.api_host || undefined,
      checkinGeneration: 0,
      obtainedAt: new Date().toISOString(),
    };
    await save(c);
    onStatus?.("授权成功，凭据已落盘。");
    return c;
  } finally {
    callback.close();
  }
}

// ── 凭据读写 ─────────────────────────────────────────────────────────────────

function toDisk(c: Credentials): string {
  const disk: Record<string, unknown> = {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    expires_at: c.expiresAt,
    uid: c.uid,
    nickname: c.nickname,
    phone: c.phone,
    email: c.email,
    machine_id: c.machineId,
    device_id: c.deviceId,
    enterprise_id: c.enterpriseId,
    domain: c.domain,
    checkin_generation: c.checkinGeneration ?? 0,
  };
  if (c.apiHost) disk["api_host"] = c.apiHost;
  if (c.obtainedAt) disk["obtained_at"] = c.obtainedAt;
  return `${JSON.stringify(disk, null, 2)}\n`;
}

/**
 * 同步回写凭据（tmp → 同目录 rename → 0600）。
 *
 * 写法统一走共享层 `writeSecretFile`（tmp → rename → 0600），不再各写一遍。
 */
function persistSync(c: Credentials): void {
  ensureDir();
  writeSecretFile(credentialsPath(), toDisk(c));
}

/**
 * 从磁盘读取凭据。
 *
 * 文件缺失 / JSON 损坏 / access_token 为空时抛 NotLoggedInError。
 * 读盘故障（EACCES / EBUSY 等）保持原始错误上抛 —— 折叠成「未登录」会误导用户白跑
 * 重新登录，而重新登录修不了权限问题。
 * 老凭据缺设备指纹时就地补齐并同步回写（设备指纹是请求硬需求），
 * 而不是拒绝整条凭据。
 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotLoggedInError();
    throw err;
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
    accessToken: str(rec["access_token"]) || str(rec["accessToken"]),
    refreshToken: str(rec["refresh_token"]) || str(rec["refreshToken"]),
    expiresAt: str(rec["expires_at"]) || str(rec["expiresAt"]),
    uid: str(rec["uid"]),
    nickname: str(rec["nickname"]),
    phone: str(rec["phone"]),
    email: str(rec["email"]),
    machineId: str(rec["machine_id"]) || str(rec["machineId"]),
    deviceId: str(rec["device_id"]) || str(rec["deviceId"]),
    enterpriseId: str(rec["enterprise_id"]) || str(rec["enterpriseId"]),
    domain: str(rec["domain"]),
    apiHost: str(rec["api_host"]) || str(rec["apiHost"]),
    checkinGeneration: intOrZero(rec["checkin_generation"] ?? rec["checkinGeneration"]),
    obtainedAt: str(rec["obtained_at"]) || str(rec["obtainedAt"]),
  };
  if (!c.accessToken) throw new NotLoggedInError();

  if (!c.machineId || !c.deviceId) {
    // 设备指纹缺失时补齐并持久化：machine_id 登录后不应再变，device_id 每账号不同
    const filled: Credentials = {
      ...c,
      machineId: c.machineId || generateMachineId(),
      deviceId: c.deviceId || generateDeviceId(),
    };
    try {
      persistSync(filled);
    } catch {
      /* 回写失败不阻塞：本次进程内仍可用 */
    }
    return filled;
  }
  return c;
}

/**
 * 以 0600 权限原子写入凭据。
 *
 * 写法统一走共享层 `writeSecretFile`（tmp → rename → 0600），不再各写一遍。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  writeSecretFile(credentialsPath(), toDisk(c));
}

/** 仅改签到设备代数并回写（9074 设备级限流时轮换）。 */
export async function rotateCheckinGeneration(c: Credentials): Promise<Credentials> {
  const next: Credentials = { ...c, checkinGeneration: (c.checkinGeneration ?? 0) + 1 };
  await save(next);
  return next;
}

// ── 续期 ─────────────────────────────────────────────────────────────────────

/** JWT 的 `exp`（秒）；无 exp 时返回 null（转发共享层原语，毫秒→秒）。 */
function jwtExp(token: string): number | null {
  const ms = sharedLogin.jwtExpMs(token);
  return ms > 0 ? Math.trunc(ms / 1000) : null;
}

/**
 * 归一化过期时间为**毫秒字符串**。
 *
 * 兼容：毫秒数字/数字串、秒级数字（<1e12）、ISO 8601、以及 JWT 的 `exp` 兜底。
 */
function normalizeExpiresAt(value: unknown, token = ""): string {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (Number.isFinite(numeric) && numeric > 0) {
    return String(numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric));
  }
  if (typeof value === "string" && value.trim() && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return String(parsed);
  }
  const exp = jwtExp(token);
  if (exp !== null) return String(exp * 1000);
  return "";
}

/** 终态判据之一：HTTP 401/403。 */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** 一次兑换的结果（access 与 refresh **都**是新的）。 */
interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** 毫秒字符串。 */
  expiresAt: string;
}

/** refresh token 与 client_id 不属于同一产品线（10101）；换另一条线的 client_id 可解。 */
class ClientMismatchError extends Error {
  override name = "ClientMismatchError";
}

/**
 * 旧兑换端点可能已下线的信号。
 *
 * 上游已迁 `/trae/api/v3/oauth/ExchangeToken`（新契约带 PKCE + 设备密钥对），
 * 本仓仍走 `/cloudide/api/v3/...`。旧端点被关掉时，症状与「凭据失效」不同：
 *
 * - **404 / 405**：路径没了 —— 凭据可能完全正常，是端点消失；
 * - **非 JSON 响应**（HTML 错误页 / 网关 502 页）：同理，不是鉴权失败；
 * - **10101「无效参数」**：新端点用这个码表示缺 DeviceInfo。旧端点用它表示
 *   client 归属不符（本仓已换线重试）。两者共用码值，故只在换线重试也失败后
 *   才把「无效参数」形态归到端点变更 —— 归属不符的 10101 已被前一步消化。
 *
 * 判据宁可漏报不可误报：这里只做提示，不改变错误类型与重试行为。
 */
function looksLikeEndpointGone(status: number, text: string): boolean {
  if (status === 404 || status === 405) return true;
  // 非 JSON（HTML 错误页）且状态非 2xx：网关层拒绝，不是业务鉴权
  const trimmed = text.trim();
  if (status !== 200 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) return true;
  return false;
}

/** 端点疑似下线时打一次提示（同进程只打一次，避免每次续期都刷屏）。 */
function noteEndpointMaybeGone(status: number): void {
  paths.noteOnce(
    "traecn-exchange-endpoint",
    `traecn ExchangeToken returned HTTP ${status} on the legacy endpoint ` +
      `(${OAUTH_EXCHANGE_PATH}). The upstream has migrated to /trae/api/v3/oauth/ExchangeToken ` +
      `with PKCE + device key pair; the old endpoint may be retired. ` +
      `See docs/channels/traecn/PROTOCOL.md §9.1 before assuming the credential is invalid.`,
  );
}

/**
 * 调 `ExchangeToken` 用 refresh token 换新 token（**不落盘**）。
 *
 * **access 与 refresh 都轮换**，调用方必须把两个都写回。
 * 终态（需重新登录）三条任一：HTTP 401/403、响应非 JSON（HTML 错误页）、
 * **2xx 且响应是 JSON 却没有 accessToken**。`10101`（token 与 client_id 不属同一条
 * 产品线）不算终态 —— 换另一条线的 client_id 重试一次。
 */
async function exchangeToken(refreshToken: string, host?: string): Promise<TokenPair> {
  if (!refreshToken) throw new ReloginRequiredError("No refresh token, please log in again");
  const base = (host || oauthHost()).replace(/\/+$/, "");
  try {
    return await exchangeWithClient(refreshToken, base, CLIENT_ID);
  } catch (err) {
    if (!(err instanceof ClientMismatchError)) throw err;
    return await exchangeWithClient(refreshToken, base, CLIENT_ID_SOLO);
  }
}

async function exchangeWithClient(
  refreshToken: string,
  base: string,
  clientId: string,
): Promise<TokenPair> {
  const url = `${base}${OAUTH_EXCHANGE_PATH}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        ClientID: clientId,
        RefreshToken: refreshToken,
        ClientSecret: "-",
        UserID: "",
      }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`ExchangeToken request failed: ${String(err)}`);
  }
  if (isAuthStatus(resp.status)) {
    // 401/403 也可能是 10101（归属错误走鉴权状态码返回）：读 body 再定，能换线就换线
    const text = await resp.text().catch(() => "");
    if (/10101|not matched to the client/i.test(text)) throw new ClientMismatchError("client mismatch");
    throw new ReloginRequiredError(`ExchangeToken returned HTTP ${resp.status}, credential is invalid, please log in again`);
  }
  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    if (/10101|not matched to the client/i.test(text)) throw new ClientMismatchError("client mismatch");
    // 端点消失（404/405）或网关返回 HTML 错误页：先提示，别让人误判成凭据失效
    if (looksLikeEndpointGone(resp.status, text)) noteEndpointMaybeGone(resp.status);
    throw new Error(`ExchangeToken returned HTTP ${resp.status}`);
  }

  // 凭据失效时上游回 HTML 错误页：必须先 text() 再试 JSON.parse（不能直接 .json()）
  const text = await resp.text();
  let env: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    env = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    env = null;
  }
  if (!env) {
    // 200 却给了 HTML：多半是网关/边缘层拦下的错误页，不是凭据问题
    noteEndpointMaybeGone(resp.status);
    throw new ReloginRequiredError("ExchangeToken returned non-JSON (possibly an HTML error page), credential is invalid, please log in again");
  }

  const result = env["Result"] ?? env["result"] ?? env["data"] ?? env;
  const payload = parseJsonObject(result);
  const accessToken =
    pick(payload["Token"]) || pick(payload["token"]) || pick(payload["AccessToken"]) ||
    pick(payload["accessToken"]);
  if (!accessToken) {
    // 2xx 无 accessToken：先看是不是 10101（可换线解），不是才判终态
    const flat = JSON.stringify(env);
    if (/10101|not matched to the client/i.test(flat)) throw new ClientMismatchError("client mismatch");
    throw new ReloginRequiredError("ExchangeToken response has no accessToken, credential is invalid, please log in again");
  }
  return {
    accessToken,
    refreshToken: pick(payload["RefreshToken"]) || pick(payload["refresh_token"]) || refreshToken,
    expiresAt: normalizeExpiresAt(
      payload["TokenExpireAt"] ?? payload["tokenExpireAt"] ?? payload["ExpireAt"],
      accessToken,
    ),
  };
}

/** 账号信息（GetUserInfo 的可识别部分）。 */
interface UserInfo {
  uid: string;
  nickname: string;
  phone: string;
  email: string;
  enterpriseId: string;
}

/**
 * 取账号信息（uid / 昵称 / 脱敏手机号 / 脱敏邮箱 / 企业 id）。
 *
 * 鉴权头**必须**是 `x-cloudide-token`：用 `Authorization: Cloud-IDE-JWT` 会被 401
 * （参考实现实测，见 `docs/channels/traecn/PROTOCOL.md`）。
 * 失败**不阻塞登录**（返回 null，调用方沿用回调里的 `userInfo`）。
 */
async function fetchUserInfo(accessToken: string, host?: string): Promise<UserInfo | null> {
  if (!accessToken) return null;
  const base = (host || oauthHost()).replace(/\/+$/, "");
  let resp: Response;
  try {
    resp = await fetch(`${base}${OAUTH_USER_INFO_PATH}`, {
      method: "POST",
      body: JSON.stringify({ ReqSource: "IDE", IDEVersion: IDE_VERSION }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "x-cloudide-token": accessToken,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (resp.status !== 200) return null;
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }
  const env = parseJsonObject(text);
  const payload = parseJsonObject(env["Result"] ?? env["result"] ?? env);
  const uid = pick(payload["UserID"]) || pick(payload["userId"]);
  if (!uid) return null;
  return {
    uid,
    nickname: fixNickname(pick(payload["ScreenName"]), uid),
    phone: pick(payload["NonPlainTextMobile"]) || pick(payload["Mobile"]),
    email: pick(payload["NonPlainTextEmail"]) || pick(payload["Email"]),
    enterpriseId: pick(payload["EnterpriseID"]) || pick(payload["TenantID"]),
  };
}

/**
 * 用 refresh token 换新 token 并落盘。
 *
 * **access 与 refresh 都轮换**，续期后必须回写；
 * 设备指纹字段完全不动。设备指纹之外只有 token/过期时间被更新。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new ReloginRequiredError("No refresh token, please log in again");
  const host = (c.apiHost || oauthHost()).replace(/\/+$/, "");
  const pair = await exchangeToken(c.refreshToken, host);

  const next: Credentials = {
    ...c, // 设备指纹与账号标识完全不动
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt,
  };
  await save(next);
  return next;
}
