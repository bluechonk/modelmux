/**
 * Loomy（讯飞）认证：HMAC-SHA1 账号签名、手机验证码登录、凭据持久化与「续期=探测」。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/channels/loomy/PROTOCOL.md）
 *
 * 1. **签名是 9 段 `\n` 连接**，后两段（SignedHeaders / CanonicalizedHeaders）
 *    恒为空串 ⇒ 最终字符串**以两个换行结尾**。这是 `join("\n")` 在 9 个元素上的
 *    自然结果，**不要「顺手」去掉尾随换行** —— 去掉即签名不匹配。
 * 2. **空 body 的 Content-MD5 段是空串**（而不是「空串的 md5」）。
 * 3. **认证头前缀是 `account {ak}:{sig}`**，不是 `Bearer`。
 * 4. **签名与发送必须共用同一个序列化后的 body 字符串**：二次序列化会改变字节
 *    （键序/空格），签名随即失效。故 `accountPost()` 只 `JSON.stringify` 一次。
 * 5. **没有 refresh 端点**（session 是登录时声明 14 天得来的）：`refresh()` 只做
 *    **有效性探测**，失效时抛错 —— **不假装续期成功**（那会让 UI 显示「已续期」而请求仍 401）。
 * 6. **登录只有手机验证码一条路**（主人决定，2026-10-22）：两步协议 ——
 *    `POST /login/phone/sendMsgCode` 拿 `msgid`，再 `POST /login/phone/checkCode`
 *    用 `msgid` + 验证码换 `session`（`expire` 直接声明 14 天）。
 * 7. **`msgid` 是两步之间的强绑定**：`checkCode` 不带第一步的 `msgid` 必失败，
 *    故发码结果必须回传给用户（打进错误信息里），不能吞掉。
 * 8. ⚠ 历史上的微信扫码与账号密码登录都已移除：前者在无浏览器环境下注定别扭
 *    （授权页每次加载都是新 uuid，回调页线上还是 404），后者要求用户先在讯飞账号
 *    中心设密码。逆向结论保留在 docs/channels/loomy/FINDINGS.md，别照着重写。
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  writeJsonSecret,
} from "@modelmux/gateway";
import * as upstream from "./upstream.js";

/** 账号端点基址（登录的发码/校验走这里）。 */
export const DEFAULT_BASE_URL = "https://account.xfinfr.com";

/** 讯飞 AccessKey（随客户端分发 + AES 混淆，只用于账号端点的请求签名）。 */
const ACCESS_KEY_ID = "2thryby66wxi53sk";
const ACCESS_KEY_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r";
const APP_ID = "GM3LOOMY";

/** session 声明有效期 14 天（响应不带到期时间，故本地推算）。 */
const SESSION_TTL_SECONDS = 1_209_600;

/** 手机验证码登录（两步：发码拿 `msgid` → 用 `msgid` + 验证码换 session）。 */
const PHONE_SEND_MSG_PATH = "/login/phone/sendMsgCode";
const PHONE_CHECK_CODE_PATH = "/login/phone/checkCode";

/**
 * 手机号 / 验证码的输入来源（无窗口工程没有输入框，用环境变量）。
 *
 * - `LOOMY_PHONE` 单独给 → 发码（第一步），报出 `msgid`；
 * - `LOOMY_PHONE` + `LOOMY_SMS_CODE` + `LOOMY_SMS_MSGID` → 校验换 session（第二步）。
 */
const PHONE_ENV = "LOOMY_PHONE";
const SMS_CODE_ENV = "LOOMY_SMS_CODE";
const SMS_MSGID_ENV = "LOOMY_SMS_MSGID";

const HTTP_TIMEOUT_MS = 60_000;

const NOT_LOGGED_IN_MSG = "no usable credentials found; run `loomy login` first";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 凭据（磁盘字段为 snake_case，见 `load`）。 */
export interface Credentials {
  /** 讯飞 `session`，**32 位小写 hex**。 */
  readonly accessToken: string;
  /** 讯飞用户 id，**18 位数字串**。 */
  readonly userid: string;
  /** 账号标识（= `userid`）。 */
  readonly uid: string;
  /** Loomy 无域概念 → 恒空串。 */
  readonly domain: string;
  readonly phone: string;
  readonly nickname: string;
  /** **毫秒时间戳字符串**，由登录时刻 + 14 天本地推算。 */
  readonly expiresAt: string;
  readonly obtainedAt: string;
  readonly source: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  userid: "",
  uid: "",
  domain: "",
  phone: "",
  nickname: "",
  expiresAt: "",
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/** 从登录时刻推算 `expires_at`（毫秒时间戳字符串）。 */
function computeExpiresAt(fromMs = Date.now()): string {
  return String(Math.trunc(fromMs + SESSION_TTL_SECONDS * 1000));
}

/** 凭据是否已过期（无法解析时间戳时保守返回 false）。 */
function isExpired(c: Credentials): boolean {
  return sharedLogin.isExpiredAt(Number.parseInt(c.expiresAt || "0", 10));
}

// ── 签名（loomy-sign.ts 的逐字节复刻）─────────────────────────────────────────

/** RFC3986 转义：`encodeURIComponent` + 补转 `! ' ( ) *`。 */
function escape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 转义路径：补前导 `/`、剥末尾 `/`、**逐段**转义（空段保留）。 */
function escapedPath(path: string): string {
  let text = path || "/";
  if (!text.startsWith("/")) text = `/${text}`;
  if (text.length > 1) text = text.replace(/\/+$/, "") || "/";
  return text
    .split("/")
    .map((segment) => escape(segment))
    .join("/");
}

/** 转义查询串：key/value **都**转义、**不排序**、null/undefined → 空串。 */
function escapedQuery(query?: Record<string, unknown> | Array<[string, unknown]> | null): string {
  if (!query) return "";
  const entries: Array<[string, unknown]> = Array.isArray(query) ? query : Object.entries(query);
  return entries
    .map(([key, value]) => `${escape(key)}=${escape(value === null || value === undefined ? "" : String(value))}`)
    .join("&");
}

/** `base64(md5(body_utf8_bytes))`；**空 body 返回空串**（不是空串的 md5）。 */
function contentMd5(bodyStr: string): string {
  if (!bodyStr) return "";
  return createHash("md5").update(bodyStr, "utf8").digest("base64");
}

interface SignInput {
  bodyStr?: string;
  contentType?: string;
  date: string;
  nonce: string;
  query?: Record<string, unknown> | Array<[string, unknown]> | null;
}

/**
 * 9 段签名字符串（`\n` 连接）。
 *
 * ⚠ 后两段恒为空串 ⇒ 结果**以两个换行结尾**，这是协议要求，不是笔误。
 */
function buildStringToSign(method: string, path: string, input: SignInput): string {
  return [
    method.toUpperCase(),
    escapedPath(path),
    escapedQuery(input.query),
    contentMd5(input.bodyStr ?? ""),
    input.contentType ?? "application/json",
    input.date,
    input.nonce,
    "", // SignedHeaders
    "", // CanonicalizedHeaders
  ].join("\n");
}

/** HMAC-SHA1 签名（base64）。 */
function sign(stringToSign: string): string {
  return createHmac("sha1", ACCESS_KEY_SECRET).update(stringToSign, "utf8").digest("base64");
}

interface SignHeaderInput {
  bodyStr?: string;
  query?: Record<string, unknown> | Array<[string, unknown]> | null;
  contentType?: string;
  /** 仅供测试：固定 Date/Nonce 以锁定 golden 签名。 */
  date?: string;
  nonce?: string;
}

/** 账号端点的签名请求头（前缀是 `account`，不是 `Bearer`）。 */
function signHeaders(method: string, path: string, input: SignHeaderInput = {}): Record<string, string> {
  // UTC 字符串（等价 email.utils.formatdate(usegmt=True)）
  const date = input.date ?? new Date().toUTCString();
  const nonce = input.nonce ?? randomUUID();
  const stringToSign = buildStringToSign(method, path, {
    ...(input.bodyStr !== undefined ? { bodyStr: input.bodyStr } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    contentType: input.contentType ?? "application/json",
    date,
    nonce,
  });
  const headers: Record<string, string> = {
    Authorization: `account ${ACCESS_KEY_ID}:${sign(stringToSign)}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": input.contentType ?? "application/json",
  };
  if (input.bodyStr) headers["Content-MD5"] = contentMd5(input.bodyStr);
  return headers;
}

/**
 * 通用请求体信封：`{base: {…客户端身份…}, param: {...}}`。
 *
 * ⚠ `ua` 硬编码 `Loomy|Desktop|Electron|macOS` —— 客户端在 Windows 上发的也是这个值，
 * **照抄不要改**；`traceid` 每次调用重新生成（32 位 hex）。
 */
function accountBody(param: Record<string, unknown>): Record<string, unknown> {
  return {
    base: {
      appid: APP_ID,
      modelid: "Web",
      version: "1.0.0",
      devid: "web",
      ua: "Loomy|Desktop|Electron|macOS",
      traceid: randomUUID().replace(/-/g, ""),
    },
    param,
  };
}

function accountBase(override?: string): string {
  return override || process.env["LOOMY_ACCOUNT_BASE_URL"] || DEFAULT_BASE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 业务响应信封（`desc` 优先于 `message`；code 归一成字符串）。 */
function parseEnvelope(payload: unknown): { code: string; desc: string; data: Record<string, unknown> } {
  if (!isRecord(payload)) return { code: "", desc: "", data: {} };
  const code = payload["code"] === undefined || payload["code"] === null ? "" : String(payload["code"]);
  const desc = str(payload["desc"]) || str(payload["message"]);
  const data = isRecord(payload["data"]) ? payload["data"] : {};
  return { code, desc, data };
}

/**
 * 账号端点 POST：**只序列化一次 body**，签名与发送共用同一字符串。
 *
 * 业务失败恒 HTTP 200 也适用于账号端点（实测账号端点回 `{code:"100001",desc}`），
 * 故成败只读 `code`。
 */
async function accountPost(
  path: string,
  param: Record<string, unknown>,
  baseOverride?: string,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(accountBody(param));
  const headers = signHeaders("POST", path, { bodyStr: body });
  let resp: Response;
  try {
    resp = await fetch(`${accountBase(baseOverride)}${path}`, {
      method: "POST",
      headers,
      // ⚠ 发送的就是签名时的字符串：不要让 fetch 重新序列化
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`account endpoint ${path} request failed: ${String(err)}`);
  }
  if (!resp.ok) throw new Error(`account endpoint ${path} returned HTTP ${resp.status}`);
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`account endpoint ${path} response is not valid JSON: ${String(err)}`);
  }
  const env = parseEnvelope(payload);
  if (env.code !== upstream.OK_CODE) {
    throw new Error(`account endpoint ${path} failed: code=${env.code} ${env.desc}`);
  }
  return env.data;
}

// ── 凭据落盘 ──────────────────────────────────────────────────────────────────

/** 从磁盘读凭据；缺 `expires_at` 时按 `obtained_at + 14 天` 补算（不拒绝整条凭据）。 */
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
    throw new NotLoggedInError(`credentials file is corrupt (${credentialsPath()}); please log in again`);
  }
  if (!isRecord(data)) throw new NotLoggedInError("credentials file has an unexpected structure; please log in again");
  const accessToken = str(data["access_token"] ?? data["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();
  const userid = str(data["userid"] ?? data["userId"] ?? data["uid"]);
  const obtainedAt = str(data["obtained_at"] ?? data["obtainedAt"]);
  let expiresAt = str(data["expires_at"] ?? data["expiresAt"]);
  if (!expiresAt && obtainedAt) {
    // 老凭据/手工导入的凭据可能没有 expires_at：只读它会让过期判定恒为 false
    const parsed = Date.parse(obtainedAt);
    if (Number.isFinite(parsed)) expiresAt = computeExpiresAt(parsed);
  }
  return {
    accessToken,
    userid,
    uid: userid,
    domain: "",
    phone: str(data["phone"]),
    nickname: str(data["nickname"]),
    expiresAt,
    obtainedAt,
    source: str(data["source"]),
  };
}

/**
 * 原子写凭据（0600）。
 *
 * 写法统一走共享层 `writeJsonSecret`（tmp → rename → 0600），不再各写一遍。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const payload = {
    access_token: c.accessToken,
    userid: c.userid,
    phone: c.phone,
    nickname: c.nickname,
    expires_at: c.expiresAt,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
  writeJsonSecret(credentialsPath(), payload);
}

// ── 登录（手机验证码）/ 续期（探测）──────────────────────────────────────────

/**
 * 登录响应 → 凭据并落盘。
 *
 * `session` 是响应里唯一的凭据（32 位小写 hex），`expire` 已在请求里声明 14 天，
 * 上游不回到期时间 ⇒ 由本地按 `SESSION_TTL_SECONDS` 推算。
 */
async function credentialsFromSession(
  data: Record<string, unknown>,
  source: string,
): Promise<Credentials> {
  const session = str(data["session"]);
  const userid = str(data["userid"]);
  if (!session) throw new Error("login response has no session");
  const c: Credentials = {
    ...EMPTY_CREDENTIALS,
    accessToken: session,
    userid,
    uid: userid,
    phone: str(data["phone"]),
    expiresAt: computeExpiresAt(),
    obtainedAt: nowIso(),
    source,
  };
  await save(c);
  return c;
}

/**
 * 登录选项。
 *
 * ⚠ 共享层还会传 `onUrl` / `onQr` / `pasteCode` / `timeoutSec` 等字段（扫码类渠道用），
 * 短信登录**不用**它们；这里只声明自己读的字段，其余按结构类型宽松忽略。
 */
interface LoginOptions {
  /** 进度提示（打到 CLI/控制台）。 */
  onStatus?: (message: string) => void;
}

/**
 * 手机验证码登录第一步：发码，返回 `msgid`（第二步要用它）。
 *
 * 两步是协议强制：`checkCode` 必须带上发码响应里的 `msgid`。
 */
export async function sendPhoneLoginCode(phone: string, baseUrl?: string): Promise<string> {
  if (!phone) throw new Error(`SMS login needs a phone number (${PHONE_ENV})`);
  const data = await accountPost(
    PHONE_SEND_MSG_PATH,
    { ccode: "86", phone, expire: 300 },
    baseUrl,
  );
  const msgid = str(data["msgid"]);
  if (!msgid) throw new Error("phone sendMsgCode response has no msgid");
  return msgid;
}

/** 手机验证码登录第二步：用 `msgid` + 验证码换 `session`。 */
export async function loginByPhoneCode(
  phone: string,
  mcode: string,
  msgid: string,
  baseUrl?: string,
): Promise<Credentials> {
  if (!phone) throw new Error(`SMS login needs a phone number (${PHONE_ENV})`);
  if (!mcode) throw new Error(`SMS login needs the code (${SMS_CODE_ENV})`);
  if (!msgid) throw new Error(`SMS login needs the msgid from the previous run (${SMS_MSGID_ENV})`);
  const data = await accountPost(
    PHONE_CHECK_CODE_PATH,
    { ccode: "86", phone, mcode, msgid, expire: SESSION_TTL_SECONDS },
    baseUrl,
  );
  return credentialsFromSession(data, "loomy-sms");
}

/**
 * 登录：**手机验证码，唯一路径**（两步协议，按环境变量驱动）。
 *
 * - 只给 `LOOMY_PHONE` → 发码，把 `msgid` 打进错误信息里（第一步）；
 * - 再给 `LOOMY_SMS_CODE` + `LOOMY_SMS_MSGID` → 校验换 `session`（第二步）。
 *
 * 为什么只留这条路（主人决定，2026-10-22）：微信扫码在无浏览器环境下注定别扭 ——
 * 授权页每次加载都是新 uuid（扫错就永远等不到），回调页线上是 404 只能靠用户从地址栏
 * 把 `code` 粘回来；密码登录则要求用户先在讯飞账号中心设密码。短信是唯一**单一路径就能
 * 闭环**的方式。历史实现见 `docs/channels/loomy/FINDINGS.md`。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus } = options;
  const phone = (process.env[PHONE_ENV] ?? "").trim();
  const mcode = (process.env[SMS_CODE_ENV] ?? "").trim();
  const msgid = (process.env[SMS_MSGID_ENV] ?? "").trim();

  if (!phone) {
    throw new Error(
      `SMS login needs a phone number: set ${PHONE_ENV}=<phone> and re-run (then ${SMS_CODE_ENV} + ${SMS_MSGID_ENV} with the code)`,
    );
  }
  if (mcode && msgid) {
    onStatus?.("verifying the phone code...");
    return loginByPhoneCode(phone, mcode, msgid, baseUrl);
  }
  // 只有手机号：把码发出去，让用户带着验证码 + msgid 重跑第二步。
  onStatus?.("sending the SMS code...");
  const freshMsgid = await sendPhoneLoginCode(phone, baseUrl);
  throw new Error(
    `SMS code sent to ${phone}. Re-run with ${SMS_CODE_ENV}=<code> ${SMS_MSGID_ENV}=${freshMsgid} to finish login.`,
  );
}

/**
 * `refresh()`：Loomy **没有 refresh 端点**，故这里只做**有效性探测**
 * （调最便宜的只读端点 `GET /points/records`，不消耗积分、无副作用）。
 *
 * 失效时抛错让 UI 显示「凭证过期，请重新登录」—— **绝不假装续期成功**。
 * 探测通过时做**有效期对账**（账号池的 expiresAt 是 UI 唯一的显示依据）。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  try {
    await upstream.fetchPointsRecords(c);
  } catch (err) {
    if (err instanceof upstream.UpstreamUnauthorized) {
      throw new Error(`Loomy has no refresh endpoint; session is invalid, please log in again (${String(err)})`);
    }
    throw new Error(`refresh probe failed: ${String(err)}`);
  }
  if (!isExpired(c)) return c; // 仍有效 → 不改动时间戳
  const next: Credentials = { ...c, expiresAt: computeExpiresAt(), obtainedAt: nowIso() };
  await save(next);
  return next;
}

/** 登录基址：Loomy 是单账号域，无 realm 概念（参数仅为满足契约）。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return accountBase();
}
