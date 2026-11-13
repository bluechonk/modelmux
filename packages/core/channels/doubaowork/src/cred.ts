/**
 * 豆包工作认证：纯 HTTP 手机号 + 短信验证码登录 → 会话 Cookie 落盘 → 设备号绑定。
 *
 * 关键约束（端点/字段/实测见 docs/channels/doubaowork/PROTOCOL.md）：
 *   - 登录域是 `accounts.doubao.com`；表单值按 XOR 0x05 编码，两跳共用同一个 cookie jar。
 *   - 登录态是 Cookie，上游**无续期接口**，失效只能重登；`token/beat/web/` 只做探测。
 *   - 对话必须带设备号（`device_id` + `fp=verify_<device_id>`），否则被 `shark_admin` 滑块拦。
 *
 * 铁律：Cookie 原文不进日志/输出，只给指纹与长度。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  writeJsonSecret,
  type Credential,
} from "@modelmux/gateway";

const { str, fetchWithTimeout } = shared;

/** 契约要求 `cred` 模块导出 `DEFAULT_BASE_URL`（登录与上游共用的默认基址）。 */
export const DEFAULT_BASE_URL = "https://www.doubao.com";

/** 登录 / 账号域（与对话域不同，见文件头）。 */
export const ACCOUNTS_HOST = "https://accounts.doubao.com";

/** 应用 id：豆包网页/客户端（`aid=497858` 是登录域，`1044603` 是对话域）。 */
export const AID_LOGIN = "497858";
export const AID_CHAT = "1044603";

/** 客户端版本：上游按 `pc_version` 下发模型菜单，缺失会拿到空菜单。 */
export const CLIENT_VERSION = "2.33.5";

const HTTP_TIMEOUT_MS = 30_000;

/** 浏览器 UA（与登录时的真实 UA 保持一致，换 UA 会被判新设备）。 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const NOT_LOGGED_IN_MSG = "no usable credentials found; run `doubaowork login` first";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 单条 Cookie（落盘用；`expires` 为 -1 表示会话 Cookie）。 */
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  /** 完整 Cookie 列表（落盘用，保留 domain/path/expires）。 */
  readonly cookies: StoredCookie[];
  /** 直接可用的 Cookie 请求头（`a=b; c=d`），每次请求都用它。 */
  readonly cookieHeader: string;
  /** 设备号（`Local State` 的 `aha.device.device_id`）；缺失则对话必被人机验证拦下。 */
  readonly deviceId: string;
  /** `s_v_web_id` 指纹（Cookie 里带）。 */
  readonly fingerprint: string;
  /** 登录手机号（脱敏展示用；上游账号信息里也有）。 */
  readonly phone: string;
  /** 昵称。 */
  readonly nickname: string;
  /** 客户端版本（模型菜单依赖它）。 */
  readonly clientVersion: string;
  readonly obtainedAt: string;
}

const EMPTY: Credentials = {
  accessToken: "",
  uid: "",
  domain: "doubao.com",
  cookies: [],
  cookieHeader: "",
  deviceId: "",
  fingerprint: "",
  phone: "",
  nickname: "",
  clientVersion: CLIENT_VERSION,
  obtainedAt: "",
};

/** 指纹（日志用）：只给前 6 位 + 长度。 */
function fingerprintOf(token: string): string {
  if (!token) return "-";
  return `${createHash("sha256").update(token).digest("hex").slice(0, 12)}(${token.length})`;
}

/** Cookie 头里是否已有登录会话。 */
function hasSession(cookieHeader: string): boolean {
  return /(?:^|;\s*)sessionid(_ss)?=/.test(cookieHeader);
}

/** 从 Cookie 头里取某个键的值（取不到返回空串）。 */
export function cookieValue(header: string, name: string): string {
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

/** 读本机豆包工作客户端的设备号（读不到返回空串，不抛错）。 */
export function readDeviceId(): string {
  const base = process.env["LOCALAPPDATA"];
  const candidates: string[] = [];
  if (platform() === "win32" && base) {
    candidates.push(join(base, "DoubaoWork", "User Data", "Local State"));
    candidates.push(join(base, "Doubao", "User Data", "Local State"));
  } else if (platform() === "darwin") {
    candidates.push(join(homedir(), "Library", "Application Support", "DoubaoWork", "Local State"));
    candidates.push(join(homedir(), "Library", "Application Support", "Doubao", "Local State"));
  }
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const aha = parsed["aha"] as Record<string, unknown> | undefined;
      const device = aha?.["device"] as Record<string, unknown> | undefined;
      const id = device?.["device_id"];
      const text = typeof id === "string" ? id : typeof id === "number" ? String(id) : "";
      if (/^[A-Za-z0-9_-]{1,64}$/.test(text)) return text;
    } catch {
      /* 客户端没装 / 格式变了都算读不到，继续看下一个候选 */
    }
  }
  return "";
}

export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `doubaowork login` to sign in with your phone");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const cookieHeader = str(parsed["cookieHeader"]);
  if (!cookieHeader || !hasSession(cookieHeader)) {
    throw new NotLoggedInError("Credential has no login session cookie, please log in again");
  }
  const cookies = Array.isArray(parsed["cookies"])
    ? (parsed["cookies"] as StoredCookie[]).filter(
        (c) => typeof c?.name === "string" && typeof c?.value === "string",
      )
    : [];
  return {
    accessToken: cookieHeader,
    uid: str(parsed["uid"]),
    domain: str(parsed["domain"]) || "doubao.com",
    cookies,
    cookieHeader,
    // 设备号优先用落盘的（登录时读到的那台），没有再实时读一次
    deviceId: str(parsed["deviceId"]) || readDeviceId(),
    fingerprint: str(parsed["fingerprint"]),
    phone: str(parsed["phone"]),
    nickname: str(parsed["nickname"]),
    clientVersion: str(parsed["clientVersion"]) || CLIENT_VERSION,
    obtainedAt: str(parsed["obtainedAt"]),
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断「已登录」）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), credential);
}

export function resolveBaseUrl(_realm?: string): string {
  return DEFAULT_BASE_URL;
}

// ── 登录（纯 HTTP 两跳） ────────────────────────────────────────────────────

/** 表单编码：UTF-8 字节逐位异或 `0x05`，再转小写 hex（见 PROTOCOL.md §1.1）。 */
function enc(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const b of bytes) out += (b ^ 0x05).toString(16).padStart(2, "0");
  return out;
}

/**
 * 上游表单里的手机号形态：`+86 ` + 11 位（抓包原文，见 PROTOCOL.md §1.1）。
 *
 * 注意中间那个空格：漏掉会拿到 `1003 手机号错误`，多写也会。
 * `normalizePhone` 补过的 `+86` 前缀要先剥掉，否则国家码会重复。
 */
function formPhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2);
  return `+86 ${digits}`;
}

/** 极简 cookie jar：按 domain 存，解析 Set-Cookie 的 name/value/expires。 */
class CookieJar {
  private readonly cookies: StoredCookie[] = [];

  /** 并入一条 Set-Cookie（`responseHost` 用于缺省 domain）。 */
  add(setCookie: string | null | undefined, responseHost: string): void {
    if (!setCookie) return;
    const parts = setCookie.split(";");
    const first = (parts[0] ?? "").trim();
    const eq = first.indexOf("=");
    if (eq <= 0) return;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    const attrs = parts.slice(1).map((s) => s.trim());
    let domain = responseHost.toLowerCase();
    let path = "/";
    let expires = -1;
    for (const attr of attrs) {
      const idx = attr.indexOf("=");
      const key = (idx > 0 ? attr.slice(0, idx) : attr).trim().toLowerCase();
      const val = idx > 0 ? attr.slice(idx + 1).trim() : "";
      if (key === "domain" && val) domain = val.replace(/^\./, "").toLowerCase();
      else if (key === "path" && val) path = val;
      else if (key === "expires" && val) {
        const parsed = Date.parse(val);
        if (Number.isFinite(parsed)) expires = parsed;
      } else if (key === "max-age" && /^\d+$/.test(val)) {
        expires = Date.now() + Number(val) * 1000;
      }
    }
    const cookie: StoredCookie = { name, value, domain, path, expires };
    const at = this.cookies.findIndex(
      (c) => c.name === name && c.domain === domain && c.path === path,
    );
    if (at >= 0) this.cookies[at] = cookie;
    else this.cookies.push(cookie);
  }

  /** 发给某 host 的 Cookie 头（过期的丢掉）。 */
  headerFor(host: string): string {
    const h = host.toLowerCase();
    const now = Date.now();
    return this.cookies
      .filter((c) => c.expires <= 0 || c.expires > now)
      .filter((c) => c.domain === h || (c.domain !== "" && h.endsWith(`.${c.domain}`)))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** 落盘快照（过期的丢掉）。 */
  snapshot(): StoredCookie[] {
    const now = Date.now();
    return this.cookies.filter((c) => c.expires <= 0 || c.expires > now);
  }
}

/** 取响应的全部 Set-Cookie（undici 的 `getSetCookie()`；老实现回落 get）。 */
function setCookiesOf(resp: Response): string[] {
  const headers = resp.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = resp.headers.get("set-cookie");
  return raw ? [raw] : [];
}

/** 登录 / 账号域的公共 query（`ts` 为 unix 秒）。 */
function loginQuery(): string {
  return new URLSearchParams({
    aid: AID_LOGIN,
    language: "zh",
    account_app_language: "zh-CN",
    account_sdk_source: "web",
    multi_login: "1",
    device_platform: "web",
    os_type: "1",
    terminal_type: "2",
    ts: String(Math.floor(Date.now() / 1000)),
  }).toString();
}

const SEND_CODE_PATH = "/passport/web/send_code/";
const SMS_LOGIN_PATH = "/passport/web/sms_login/";

/** 公共登录头（Cookie 由调用方按域注入）。 */
function loginHeaders(cookie: string, contentType?: string): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Cookie: cookie,
    Origin: "https://www.doubao.com",
    Referer: "https://www.doubao.com/",
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

/** 发码。 */
async function sendCode(jar: CookieJar, phone: string): Promise<Record<string, unknown>> {
  const body = `mix_mode=1&mobile=${enc(formPhone(phone))}&type=${enc("24")}&is6Digits=1&fixed_mix_mode=1`;
  const resp = await fetchWithTimeout(
    `${ACCOUNTS_HOST}${SEND_CODE_PATH}?${loginQuery()}`,
    {
      method: "POST",
      headers: loginHeaders(jar.headerFor("accounts.doubao.com"), "application/x-www-form-urlencoded"),
      body,
    },
    HTTP_TIMEOUT_MS,
  );
  for (const c of setCookiesOf(resp)) jar.add(c, "accounts.doubao.com");
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/** 校验验证码：成功后 jar 里有会话 Cookie。 */
async function smsLogin(
  jar: CookieJar,
  phone: string,
  code: string,
): Promise<Record<string, unknown>> {
  const body =
    `mix_mode=1&mobile=${enc(formPhone(phone))}&code=${enc(code)}&login_only=false&fixed_mix_mode=1`;
  const resp = await fetchWithTimeout(
    `${ACCOUNTS_HOST}${SMS_LOGIN_PATH}?${loginQuery()}`,
    {
      method: "POST",
      headers: loginHeaders(jar.headerFor("accounts.doubao.com"), "application/x-www-form-urlencoded"),
      body,
    },
    HTTP_TIMEOUT_MS,
  );
  for (const c of setCookiesOf(resp)) jar.add(c, "accounts.doubao.com");
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/** 上游错误描述（不回显 Cookie，只取 message / msg / code）。 */
function describeUpstreamError(body: Record<string, unknown>): string {
  const msg = str(body["msg"]) || str(body["message"]) || str(body["code"]);
  return msg === "" ? "上游未给出原因" : msg;
}

/**
 * 登录：纯 HTTP 两跳（发码 → 校验），同一个 cookie jar 贯穿。
 *
 * 为什么不用浏览器：`accounts.doubao.com` 的表单值是 XOR 0x05 编码的，两跳在同一个
 * cookie jar 里就能完成，不需要 `a_bogus` 签名器（零浏览器实测可跑通，见 PROTOCOL.md §8）。
 */
export async function login(
  _baseUrl: string,
  options?: {
    onUrl?: (url: string) => void;
    onStatus?: (msg: string) => void;
    requestInput?: (req: { kind: "phone" | "code"; prompt: string }) => Promise<string | undefined>;
    force?: boolean;
  },
): Promise<Credentials> {
  const status = options?.onStatus ?? (() => {});
  const jar = new CookieJar();

  // 1. 页面预热：拿匿名 cookie（ttwid 等）
  status("正在预热登录页…");
  const warm = await fetchWithTimeout(
    `${DEFAULT_BASE_URL}/chat/`,
    { headers: { "User-Agent": USER_AGENT } },
    HTTP_TIMEOUT_MS,
  );
  for (const c of setCookiesOf(warm)) jar.add(c, "www.doubao.com");

  // 2. 发码
  const phone = normalizePhone(await resolvePhone(options));
  status(`正在向 ${maskPhone(phone)} 发送验证码…`);
  const sent = await sendCode(jar, phone);
  if (sent["message"] !== "success") throw new Error(`发码失败：${describeUpstreamError(sent)}`);

  // 3. 验证码（凭据：只说格式，不回显）
  const code = (
    await options?.requestInput?.({
      kind: "code",
      prompt: `已向 ${maskPhone(phone)} 发送验证码，请输入收到的 6 位验证码：`,
    })
  )?.trim() ?? "";
  if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式无效（应为 4-8 位数字）");

  // 4. 校验（同会话 Cookie）
  status("正在校验验证码…");
  const verified = await smsLogin(jar, phone, code);
  if (verified["message"] !== "success") {
    throw new Error(`登录失败：${describeUpstreamError(verified)}`);
  }

  const cookieHeader = jar.headerFor("www.doubao.com");
  if (!hasSession(cookieHeader)) {
    throw new Error("登录流程结束但没有拿到会话 Cookie（sessionid），请重试");
  }

  // 5. 账号信息（昵称 / uid）
  const account = await readAccount(cookieHeader);

  const credential: Credentials = {
    accessToken: cookieHeader,
    uid: account.uid,
    domain: "doubao.com",
    cookies: jar.snapshot(),
    cookieHeader,
    deviceId: readDeviceId(),
    fingerprint: cookieValue(cookieHeader, "s_v_web_id"),
    phone,
    nickname: account.nickname,
    clientVersion: CLIENT_VERSION,
    obtainedAt: new Date().toISOString(),
  };
  if (!credential.deviceId) {
    status(
      "警告：未读到本机豆包工作客户端设备号（Local State），对话请求可能被人机验证拦下。" +
        "请先安装并登录一次豆包工作客户端，或把 device.json 放进渠道目录。",
    );
  }
  status(`登录成功：${credential.nickname || maskPhone(phone)}（Cookie ${credential.cookies.length} 条）`);
  await save(credential);
  return credential;
}

/** 手机号归一：裸 11 位补 `+86`。 */
function normalizePhone(raw: string): string {
  const phone = raw.trim();
  if (phone.startsWith("+")) return phone;
  if (/^86\d{11}$/.test(phone)) return `+${phone}`;
  if (/^\d{11}$/.test(phone)) return `+86${phone}`;
  return phone;
}

/** 脱敏：`131****9411`。 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return phone || "-";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

const PHONE_ENV = "DOUBAOWORK_PHONE";

/** 取手机号：界面输入 → 环境变量。 */
async function resolvePhone(options?: {
  requestInput?: (req: { kind: "phone" | "code"; prompt: string }) => Promise<string | undefined>;
}): Promise<string> {
  const fromInput = await options?.requestInput?.({
    kind: "phone",
    prompt: "请输入豆包账号手机号（11 位）：",
  });
  const raw = (fromInput ?? "").trim() || (process.env[PHONE_ENV] ?? "").trim();
  if (!raw) throw new Error(`缺少手机号：请在界面输入，或设置环境变量 ${PHONE_ENV}`);
  const phone = normalizePhone(raw);
  if (!/^\+\d{6,15}$/.test(phone)) throw new Error(`手机号格式无效：${maskPhone(raw)}`);
  return phone;
}

// ── 续期 / 探测 ─────────────────────────────────────────────────────────────

/**
 * 校验登录态是否仍然有效（`passport/token/beat/web/`，GET）。
 *
 * 上游**没有续期接口** —— Cookie 到期只能重新登录。本函数只回答「还有效吗」。
 */
export async function probeSession(credential?: Credentials): Promise<boolean> {
  const c = credential ?? load();
  const qs = new URLSearchParams({
    passport_jssdk_version: "3.1.6",
    passport_jssdk_type: "normal",
    is_from_ttaccountsdk: "1",
    aid: AID_LOGIN,
    language: "zh",
    account_app_language: "zh-CN",
    ts: String(Math.floor(Date.now() / 1000)),
    scene: "boot",
    account_sdk_source: "web",
    version: "2.1.6",
    os_type: "1",
    terminal_type: "2",
    request_host: encodeURIComponent(DEFAULT_BASE_URL),
  });
  try {
    const resp = await fetchWithTimeout(
      `${ACCOUNTS_HOST}/passport/token/beat/web/?${qs}`,
      {
        method: "GET",
        headers: {
          Cookie: c.cookieHeader,
          "User-Agent": USER_AGENT,
          Origin: DEFAULT_BASE_URL,
          Referer: `${DEFAULT_BASE_URL}/`,
        },
      },
      HTTP_TIMEOUT_MS,
    );
    if (resp.status !== 200) return false;
    const body = (await resp.json()) as Record<string, unknown>;
    const data = body["data"] as Record<string, unknown> | undefined;
    return Number(data?.["error_code"] ?? -1) === 0;
  } catch {
    return false;
  }
}

/**
 * 刷新：豆包工作无续期端点，只做有效性探测。
 *
 * 有效时原样返回；无效时抛 `NotLoggedInError` 让上层走重新登录，
 * 绝不伪造一个「刷新成功」。
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  if (await probeSession(credential)) return credential;
  throw new NotLoggedInError(
    "豆包工作登录态已失效（上游无续期接口），请运行 `doubaowork login` 重新登录",
  );
}

/** 登出：只销毁本地凭据（拿不到上游登出端点）。 */
export async function logout(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(credentialsPath(), { force: true });
}

/** 日志用：Cookie 指纹（不打印原文）。 */
export function describe(credential: Credentials): string {
  return `cookie=${fingerprintOf(credential.cookieHeader)} device=${credential.deviceId || "-"} user=${credential.nickname || "-"}`;
}

/** 空凭据（共享层按账号初始化时用）。 */
export function empty(): Credentials {
  return { ...EMPTY };
}

/**
 * 读账号信息（已登录态下 `passport/account/info/v2` 可用）。
 *
 * 登录页 DOM 里没有稳定的账号标识，直接打账号端点更可靠；失败不致命
 * （昵称/uid 只用于展示，不影响对话）。
 */
async function readAccount(cookieHeader: string): Promise<{ uid: string; nickname: string }> {
  try {
    const { login: sharedLogin } = await import("@modelmux/gateway");
    const { fetchWithTimeout } = sharedLogin;
    const qs = new URLSearchParams({
      aid: "497858",
      device_platform: "web",
      version_code: "20800",
      language: "zh",
      region: "CN",
      sys_region: "CN",
    });
    const resp = await fetchWithTimeout(
      `https://www.doubao.com/passport/account/info/v2/?${qs}`,
      {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
          "User-Agent": USER_AGENT,
          Origin: "https://www.doubao.com",
          Referer: "https://www.doubao.com/chat/",
        },
      },
      15_000,
    );
    if (resp.status !== 200) return { uid: "", nickname: "" };
    const body = (await resp.json()) as Record<string, unknown>;
    const data = body["data"] as Record<string, unknown> | undefined;
    const uid = String(data?.["user_id_str"] ?? data?.["user_id"] ?? "");
    const nickname = String(data?.["name"] ?? data?.["screen_name"] ?? "");
    return { uid: /^\d+$/.test(uid) ? uid : "", nickname };
  } catch {
    return { uid: "", nickname: "" };
  }
}

/** Cookie 指纹（日志用）。 */
