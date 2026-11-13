/**
 * 豆包工作认证：手机号 + 短信验证码登录 → 会话 Cookie 落盘 → 设备号绑定。
 *
 * 关键约束（端点/字段/实测见 docs/channels/doubaowork/PROTOCOL.md）：
 *   - 登录域是 `accounts.doubao.com`；每请求带 `a_bogus` 签名，故登录走真实浏览器。
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

// ── 登录（浏览器驱动） ──────────────────────────────────────────────────────

/**
 * 登录：打开真实浏览器完成手机号 + 验证码登录，回收 Cookie。
 *
 * 为什么必须走浏览器：`accounts.doubao.com` 的每个请求都带 `a_bogus` 签名
 * （`webmssdk` 在页面里生成），纯 HTTP 复现要内嵌整个签名器；而短信接口还有
 * 频率限制与人机验证。用真实浏览器让字节自己的 JS 完成签名是唯一稳的路子。
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
  const phone = await resolvePhone(options);

  status("正在启动浏览器并打开豆包登录页…");
  options?.onUrl?.(`${DEFAULT_BASE_URL}/login/`);

  const result = await runBrowserLogin({
    phone,
    onStatus: status,
    requestCode: async () => {
      const code = await options?.requestInput?.({
        kind: "code",
        prompt: `已向 ${maskPhone(phone)} 发送验证码，请输入收到的 6 位验证码：`,
      });
      return (code ?? "").trim();
    },
  });

  if (!hasSession(result.cookieHeader)) {
    throw new Error("登录流程结束但没有拿到会话 Cookie（sessionid），请重试");
  }

  const credential: Credentials = {
    accessToken: result.cookieHeader,
    uid: result.uid,
    domain: "doubao.com",
    cookies: result.cookies,
    cookieHeader: result.cookieHeader,
    deviceId: readDeviceId(),
    fingerprint: cookieValue(result.cookieHeader, "s_v_web_id"),
    phone,
    nickname: result.nickname,
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

// ── 浏览器登录实现 ──────────────────────────────────────────────────────────

/** 登录页（手机号表单在这里）。 */
const LOGIN_URL = "https://www.doubao.com/login/";

/** 回收结果。 */
export interface BrowserLoginResult {
  readonly cookieHeader: string;
  readonly cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number }>;
  readonly uid: string;
  readonly nickname: string;
}

export interface BrowserLoginOptions {
  readonly phone: string;
  readonly onStatus: (msg: string) => void;
  /** 向用户要验证码（界面 / CLI 提供）。 */
  readonly requestCode: () => Promise<string>;
}

/**
 * 动态加载 playwright，缺失时给出明确的安装指引。
 *
 * 用变量名做动态导入：playwright 是**可选依赖**（只有登录需要），
 * 直接写 `import("playwright")` 会让 tsc 在未安装时报类型错误。
 */
async function loadChromium(): Promise<{
  launch: (opts: Record<string, unknown>) => Promise<BrowserHandle>;
}> {
  const specifier = "playwright";
  try {
    const mod = (await import(specifier)) as unknown as {
      chromium: { launch: (opts: Record<string, unknown>) => Promise<BrowserHandle> };
    };
    return mod.chromium;
  } catch {
    throw new Error(
      "登录需要 Playwright：请在仓库根运行 `npm i -D playwright && npx playwright install chromium`",
    );
  }
}

/** playwright 的最小结构化类型（避免把 playwright 作为编译期依赖）。 */
interface BrowserHandle {
  newContext(opts?: Record<string, unknown>): Promise<ContextHandle>;
  close(): Promise<void>;
}
interface ContextHandle {
  newPage(): Promise<PageHandle>;
  cookies(): Promise<RawCookie[]>;
  close(): Promise<void>;
}
interface PageHandle {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string, opts?: Record<string, unknown>): Promise<void>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
}
interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
}

/** 手机号输入框候选（登录页改版时按顺序尝试）。 */
const PHONE_SELECTORS = [
  'input[placeholder*="手机号"]',
  'input[type="tel"]',
  'input[name="mobile"]',
];
/** 「下一步」按钮候选。 */
const NEXT_SELECTORS = ['button:has-text("下一步")', 'button:has-text("登录")'];
/** 验证码输入框候选。 */
const CODE_SELECTORS = ['input[placeholder*="验证码"]', 'input[maxlength="6"]'];
/** 协议「同意」按钮候选。 */
const AGREE_SELECTORS = ['button:has-text("同意")', 'button:has-text("已阅读并同意")'];

/** 依次尝试选择器，返回第一个命中的。 */
async function firstMatch(page: PageHandle, selectors: string[], timeoutMs = 5_000): Promise<string | null> {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return selector;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/** 登录后判据：Cookie 里出现 `sessionid`。 */
async function hasSessionCookie(ctx: ContextHandle): Promise<boolean> {
  const cookies = await ctx.cookies();
  return cookies.some(
    (c) =>
      (c.name === "sessionid" || c.name === "sessionid_ss") &&
      c.value.length > 0 &&
      /doubao\.com$/.test(c.domain.replace(/^\./, "")),
  );
}

/**
 * 执行一次完整登录。
 *
 * 流程：打开登录页 → 填手机号 → 点下一步 → （同意协议）→ 等验证码输入框 →
 * 向用户要码 → 填入 → 等 `sessionid` 出现 → 回收 Cookie。
 */
export async function runBrowserLogin(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();

  try {
    options.onStatus("正在打开豆包登录页…");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 1. 手机号
    const phoneSelector = await firstMatch(page, PHONE_SELECTORS, 20_000);
    if (!phoneSelector) throw new Error("登录页没有找到手机号输入框（页面可能改版）");
    await page.fill(phoneSelector, options.phone.replace(/^\+86/, ""));
    options.onStatus("已填入手机号，点击下一步…");

    const nextSelector = await firstMatch(page, NEXT_SELECTORS, 10_000);
    if (!nextSelector) throw new Error("登录页没有找到「下一步」按钮");
    await page.click(nextSelector);

    // 2. 协议（出现就点同意）
    const agreeSelector = await firstMatch(page, AGREE_SELECTORS, 3_000);
    if (agreeSelector) {
      options.onStatus("点击同意服务协议…");
      await page.click(agreeSelector);
    }

    // 3. 验证码
    const codeSelector = await firstMatch(page, CODE_SELECTORS, 30_000);
    if (!codeSelector) throw new Error("没有出现验证码输入框（短信可能未发出或被风控拦截）");
    options.onStatus("验证码已发送，等待输入…");
    const code = await options.requestCode();
    // 验证码本身是凭据：只说「格式不对」，不回显它
    if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式无效（应为 4-8 位数字）");
    await page.fill(codeSelector, code);

    // 4. 等登录态落地
    options.onStatus("已提交验证码，等待登录完成…");
    const deadline = Date.now() + 60_000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      if (await hasSessionCookie(context)) {
        loggedIn = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!loggedIn) throw new Error("提交验证码后没有拿到会话 Cookie，登录未完成");

    // 5. 回收 Cookie（只留 doubao.com）
    const raw = await context.cookies();
    const cookies = raw
      .filter((c) => {
        const domain = c.domain.replace(/^\./, "");
        return domain === "doubao.com" || domain === "www.doubao.com";
      })
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
        path: c.path || "/",
        expires: typeof c.expires === "number" ? c.expires : -1,
      }));
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    if (!cookies.some((c) => c.name === "sessionid" && c.value)) {
      throw new Error("回收的 Cookie 里没有 sessionid，登录未完成");
    }

    // 6. 账号信息（昵称 / uid）
    const account = await readAccount(cookieHeader);

    return {
      cookieHeader,
      cookies,
      uid: account.uid,
      nickname: account.nickname,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
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
