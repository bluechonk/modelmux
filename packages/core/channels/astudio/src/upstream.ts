/**
 * AStudio 上游：模型网关端点、Bearer 头、请求体改写与凭据刷新。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md）：
 *   - 对话是**标准 OpenAI 兼容**：`POST {gateway}/chat/completions` + `Authorization: Bearer`。
 *     非流式 / 流式 SSE / 工具调用 / 思考档位全部实测通过（WIRE = "openai"）。
 *   - 模型网关基址与账号 API 基址**是两个不同的域**，极易误改 —— 见下方常量注释。
 *   - 思考档位必须校验在该模型的档位表内（远端不认的值比不给更糟 → 静默删掉）。
 *   - 401/403 与业务码 `80000` 都表示会话失效，交给共享层触发 `cred.refresh()`。
 */

import { readFileSync } from "node:fs";

import { ensureDir, upstreamPath, writeJsonFile } from "@modelmux/gateway";

import * as catalog from "./catalog.js";
import * as cred from "./cred.js";

/**
 * 模型网关基址（对话端点）。
 *
 * ⚠ 与 `cred.DEFAULT_BASE_URL`（账号 API 基址 `agent.xfyun.cn/xingchen-studio`）
 * **不是同一个域**：模型网关是 `astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`。
 * 契约要求本模块导出 `DEFAULT_BASE_URL`，其语义是**对话侧**基址。
 */
export const DEFAULT_BASE_URL =
  "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1";

/**
 * 账号 API 基址（刷新凭据 / 账号信息用）。
 *
 * 与 `cred.DEFAULT_BASE_URL` 同值，但**引用处不同**：这里用于拼 `/bot/models/configs`，
 * 故显式声明，避免以后有人把两个域混用。
 */
const STUDIO_BASE_URL = "https://agent.xfyun.cn/xingchen-studio";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "AStudio";

/** 上游线型：标准 OpenAI 兼容 SSE，网关只需规范化透传。 */
export const WIRE: "openai" | "custom" = "openai";

/**
 * 对话端点路径。
 * - 方法 / 完整 URL：POST `…/model-gateway/v1/chat/completions`
 * - query：**无**（`model` / `messages` / `stream` 全在 body）
 */
const CHAT_PATH = "/chat/completions";

/**
 * 模型配置端点（**刷新凭据**用，不在模型网关上）。
 * - 方法 / 完整 URL：GET `https://agent.xfyun.cn/xingchen-studio/bot/models/configs`
 * - 鉴权：Cookie（`ssoSessionId` / `account_id` / `token`）
 */
const MODEL_CONFIGS_PATH = "/bot/models/configs";

/**
 * 认证端点（**云端直连**，不走本地服务代理层）。
 *
 * ⚠⚠ 2026-10-26 重要更正：这些路径**没有 `/api/astron-auth/` 前缀**。
 * 那个前缀是 AStudio 桌面应用**本地服务代理层**的路径；云端账号 API 的路径就是
 * `{studioBaseUrl}/<path>`。此前本仓库把「直连云端回 404」当成架构结论，
 * 那是**测错了路径**（见 docs/channels/astudio/PROTOCOL.md §5）。
 *
 * 实测（2026-10-26，云端直连、无 Cookie）：
 * - `GET  /chat/gee-captcha` → `200 code=0`，返回真实 GeeTest v3 配置；
 * - `POST /login/mobile/send-verify-code` → `200 code=20009 geetest verify failed`
 *   （端点可达，只是 captcha 没解）；
 * - `POST /login/phone-quick-login` → `200 code=10501002 验证码无效，请重新获取并验证`
 *   （端点可达、参数形态正确，验证码是假的）。
 */
const GEE_CAPTCHA_PATH = "/chat/gee-captcha";
const SEND_VERIFY_CODE_PATH = "/login/mobile/send-verify-code";
const PHONE_QUICK_LOGIN_PATH = "/login/phone-quick-login";
const TENANT_INIT_PATH = "/tenant-app/v2/init-app";
const POINTS_BALANCE_PATH = "/points/balance";

/** 会话失效的业务码（云端账号 API 返回 `80000` 表示「登录异常，请重新登录」）。 */
export const SESSION_INVALID_CODE = "80000";

/** 上游认为凭据失效（HTTP 401/403 或业务码 80000）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 AStudio 端点。 */
interface Config {
  /** 对话侧基址（模型网关）。 */
  baseUrl: string;
  /** 账号 API 基址（刷新凭据用）。 */
  studioBaseUrl: string;
}

/**
 * 凭据的最小面（避免 upstream ↔ cred 循环依赖）。
 *
 * `sessionToken` / `ssoSessionId` 供刷新用；`uid` 用于拼 `account_id` Cookie。
 */
interface AuthLike {
  modelBearerToken: string;
  sessionToken?: string;
  ssoSessionId?: string;
  uid?: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, studioBaseUrl: STUDIO_BASE_URL };
}

/** 读取已解析的上游描述符；返回 `[配置, 是否来自磁盘]`。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch {
    return [defaultConfig(), false];
  }
  const cfg: Config = {
    baseUrl:
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
    studioBaseUrl:
      typeof parsed.studioBaseUrl === "string" && parsed.studioBaseUrl
        ? parsed.studioBaseUrl
        : STUDIO_BASE_URL,
  };
  return [cfg, true];
}

/** 持久化上游描述符（临时文件 + 原子替换）。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function base(cfg?: Config): string {
  return trimSlash((cfg ?? loadConfig()[0]).baseUrl);
}

/** 对话端点。 */
export function chatUrl(cfg?: Config): string {
  return `${base(cfg)}${CHAT_PATH}`;
}

/**
 * 模型列表端点。
 *
 * AStudio 的模型清单**不是**从网关拉的（网关无 `/models`），而是随包内置 + 云端配置。
 * 这里返回云端配置端点，供 `fetchModels()` 做凭据校验与配置落盘。
 */
export function modelsUrl(cfg?: Config): string {
  const studio = trimSlash((cfg ?? loadConfig()[0]).studioBaseUrl);
  return `${studio}${MODEL_CONFIGS_PATH}`;
}

/**
 * 账号信息端点（`/xingchen-studio/userInfo`）。
 *
 * 会话文件里**没有 `nickname` 键**、`mobile` 也可能是旧的 —— 上游 `/userInfo` 才是
 * 账号信息的权威来源（实测 `code=0`，含 `uid` / `mobile` / `nickname`，见 PROTOCOL §4.2）。
 * 渠道登录时用它补全一次（2026-10-26，见 ROADMAP 第 3 项）。
 */
export function userInfoUrl(cfg?: Config): string {
  const studio = trimSlash((cfg ?? loadConfig()[0]).studioBaseUrl);
  return `${studio}/userInfo`;
}

// ── 认证头 ───────────────────────────────────────────────────────────────────

/**
 * 对话头：**只发 `Authorization: Bearer`**。
 *
 * 实测（2026-10-26）：只带 Bearer 即可，非流式/流式/工具调用全部通过。
 * 不发 `token` / Cookie —— 那是账号 API 的形态，模型网关不认。
 */
export function buildHeaders(credential: AuthLike): Record<string, string> {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.modelBearerToken}`,
  };
}

/** 会话 Cookie（源码 `buildAstronCookieHeader` 的形态）。 */
function cookieHeader(credential: AuthLike): string {
  const uid = credential.uid ?? "";
  return [
    credential.ssoSessionId ? `ssoSessionId=${credential.ssoSessionId}` : null,
    credential.ssoSessionId ? `sso_sessionid=${credential.ssoSessionId}` : null,
    uid ? `account_id=${uid}` : null,
    credential.sessionToken ? `token=${credential.sessionToken}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join("; ");
}

// ── 会话失效判据 ─────────────────────────────────────────────────────────────

/**
 * 判断是否为鉴权失败。
 *
 * 模型网关侧：HTTP 401/403。
 * 账号 API 侧：HTTP 401/403 **或**业务码 `80000`（「登录异常，请重新登录」）。
 */
export function isAuthFailure(status: number, bodySnippet: string): boolean {
  if (status === 401 || status === 403) return true;
  return bodySnippet.includes(SESSION_INVALID_CODE);
}

/** 额度信号：AStudio 的 `mode: "unrestricted"` 免费档没有额度墙 → 恒不报。 */
export function quotaSignal(
  _status: number,
  _bodySnippet: string,
): "usage_limit" | "balance" | null {
  return null;
}

// ── 模型配置（刷新凭据）─────────────────────────────────────────────────────

/**
 * 取模型配置（`/bot/models/configs`）。
 *
 * 这是**刷新链路**：带 Cookie 打云端，拿回 `api_key`（= 模型网关 Bearer）。
 * 失败时抛出（`UpstreamUnauthorized` 或普通 Error），由 `cred.refresh()` 决定如何上报。
 */
export async function fetchModelConfigs(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const url = modelsUrl(cfgOverride);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Cookie: cookieHeader(credential) },
      signal: AbortSignal.timeout(cred.HTTP_TIMEOUT),
    });
  } catch (err) {
    throw new Error(`model configs request failed: ${String(err)}`);
  }
  const text = await resp.text();
  if (isAuthFailure(resp.status, text)) {
    throw new UpstreamUnauthorized(
      `AStudio rejected the session while fetching model configs (HTTP ${resp.status})`,
    );
  }
  if (resp.status !== 200) {
    throw new Error(`model configs request returned HTTP ${resp.status}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`model configs response is not valid JSON: ${String(err)}`);
  }
}

/**
 * 取账号信息（`/xingchen-studio/userInfo`）。
 *
 * 返回**内层 `userInfo` 对象**（实测结构：`{login, uid, nickname, email, mobile,
 * realName, avatarColor}`）。会话失效（`code=80000` / HTTP 401）抛 `UpstreamUnauthorized`。
 *
 * ⚠ **尽力而为**：调用方（`cred.enrichFromUserInfo`）失败时保留会话文件的值，
 * 不让登录因为账号信息拉取失败而失败。
 */
export async function fetchUserInfo(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(userInfoUrl(cfgOverride), {
      method: "GET",
      headers: { Accept: "application/json", Cookie: cookieHeader(credential) },
      signal: AbortSignal.timeout(cred.HTTP_TIMEOUT),
    });
  } catch (err) {
    throw new Error(`userInfo request failed: ${String(err)}`);
  }
  const text = await resp.text();
  if (isAuthFailure(resp.status, text)) {
    throw new UpstreamUnauthorized(
      `AStudio rejected the session while fetching userInfo (HTTP ${resp.status})`,
    );
  }
  if (resp.status !== 200) {
    throw new Error(`userInfo request returned HTTP ${resp.status}`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`userInfo response is not valid JSON: ${String(err)}`);
  }
  // 外层信封：{code, msg, userInfo:{...}}；内层才是我们要的
  const inner = payload["userInfo"];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    throw new Error("userInfo response has no userInfo object");
  }
  return inner as Record<string, unknown>;
}

// ── 认证链路（云端直连，2026-10-26 新增）────────────────────────────────────
//
// 手机号验证码登录的三个端点 + 两个辅助端点。形态来自参考实现
// `packages/core/channels/astudio/reference/2951461586_AStudio2API/internal/astron/login.go`
// （逆向自官方客户端 bundle 的 `createAstronAccountGateway`）。
//
// ⚠ 全部是 **multipart/form-data**，不是 JSON —— 参考实现用 `multipartFields()`。

/** GeeTest v3 配置（`GET /chat/gee-captcha`）。 */
export interface GeetestConfig {
  /** GeeTest 站点标识。 */
  gt: string;
  /** 本次挑战标识（后续 validate/seccode 与它配对）。 */
  challenge: string;
  /** 上游是否接受离线模式。 */
  success?: unknown;
  newCaptcha?: unknown;
}

/** 浏览器解出的 GeeTest 结果（三个字段缺一不可）。 */
export interface GeetestSolution {
  geetest_challenge: string;
  geetest_validate: string;
  geetest_seccode: string;
}

/** 短信登录的返回（`POST /login/phone-quick-login`）。 */
export interface SmsLoginResult {
  account_id: string;
  token: string;
  ssoSessionId: string;
  uid: string;
  mobile: string;
  nickname: string;
  avatar: string;
}

/** 拼 multipart 请求体（字段顺序按参考实现；`seccode` 由调用方先 base64）。 */
function multipartBody(fields: Array<[string, string]>): { body: Buffer; contentType: string } {
  const boundary = `----modelmux${randomHex(8)}`;
  const parts: string[] = [];
  for (const [name, value] of fields) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
    );
  }
  const body = Buffer.from(`${parts.join("")}--${boundary}--\r\n`, "utf8");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 随机 hex（multipart 边界用）。 */
function randomHex(bytes: number): string {
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  ).join("");
}

/** 取值收窄（只接受 string，其它一律空串）。 */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 发一个云端账号 API 请求，返回解析后的外层信封。 */
async function accountApi(
  method: string,
  path: string,
  opts: { body?: Buffer; contentType?: string; cookie?: string },
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const url = `${trimSlash((cfgOverride ?? loadConfig()[0]).studioBaseUrl)}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      ...(opts.body ? { body: new Uint8Array(opts.body) } : {}),
      signal: AbortSignal.timeout(cred.HTTP_TIMEOUT),
    });
  } catch (err) {
    throw new Error(`${path} request failed: ${String(err)}`);
  }
  const text = await resp.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${path} response is not valid JSON (HTTP ${resp.status}): ${text.slice(0, 120)}`,
    );
  }
  // 信封：{flag, code, desc, data, traceId}
  // ⚠ `code` 是**数字**（实测 `0` / `80000` / `20009`），不是字符串 ——
  // 用「只接受 string」的取值函数会把 0 变成空串，导致成功响应被判失败。
  const code = codeText(payload["code"]);
  const ok = resp.status >= 200 && resp.status < 300 && payload["flag"] === true && code === "0";
  if (!ok) {
    const desc = str(payload["desc"]) || `HTTP ${resp.status}`;
    throw new Error(`${path} rejected (code=${code || "?"}): ${desc}`);
  }
  return payload;
}

/** 信封 `code` 归一：数字或字符串都取文本（实测是数字 `0`）。 */
function codeText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value).trim();
}

/**
 * 取 GeeTest v3 配置（`GET /chat/gee-captcha`）。
 *
 * 浏览器侧用它初始化滑块组件（官方客户端同款 `initGeetest`）。
 */
export async function fetchGeetestConfig(cfgOverride?: Config): Promise<GeetestConfig> {
  const payload = await accountApi("GET", GEE_CAPTCHA_PATH, {}, cfgOverride);
  const data = payload["data"];
  const cfg = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const gt = str(cfg["gt"]).trim();
  const challenge = str(cfg["challenge"]).trim();
  if (!gt || !challenge) throw new Error("GeeTest 配置无效（gt / challenge 为空）");
  return { gt, challenge, success: cfg["success"], newCaptcha: cfg["new_captcha"] };
}

/**
 * 发短信验证码（`POST /login/mobile/send-verify-code`）。
 *
 * ⚠ `geetest_seccode` 必须是 **base64 编码后**的值（上游要求，参考实现同）。
 * ⚠ 请求体**不含** `expire` 字段（带了的会被判「参数无效」，实测）。
 */
export async function sendSmsCode(
  mobile: string,
  solution: GeetestSolution,
  cfgOverride?: Config,
): Promise<void> {
  const { body, contentType } = multipartBody([
    ["geetest_challenge", solution.geetest_challenge],
    ["geetest_validate", solution.geetest_validate],
    ["geetest_seccode", Buffer.from(solution.geetest_seccode, "utf8").toString("base64")],
    ["mobile", mobile.trim()],
    ["countryCode", "86"],
  ]);
  await accountApi("POST", SEND_VERIFY_CODE_PATH, { body, contentType }, cfgOverride);
}

/**
 * 短信验证码换 session（`POST /login/phone-quick-login`）。
 *
 * ⚠ 这个端点**不需要** captcha（`send-verify-code` 才需要）。
 */
export async function loginWithSms(
  mobile: string,
  verifyCode: string,
  cfgOverride?: Config,
): Promise<SmsLoginResult> {
  const { body, contentType } = multipartBody([
    ["mobile", mobile.trim()],
    ["verifyCode", verifyCode.trim()],
    ["countryCode", "86"],
  ]);
  const payload = await accountApi("POST", PHONE_QUICK_LOGIN_PATH, { body, contentType }, cfgOverride);
  const data = (payload["data"] && typeof payload["data"] === "object"
    ? payload["data"]
    : {}) as Record<string, unknown>;
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = str(data[k]).trim();
      if (v) return v;
    }
    return "";
  };
  return {
    account_id: first("account_id"),
    token: first("token"),
    ssoSessionId: first("ssoSessionId"),
    uid: first("uid"),
    mobile: first("mobile", "phoneNum", "phone"),
    nickname: first("nickname", "displayName", "username", "userName", "nickName"),
    avatar: first("avatar", "avatarUrl"),
  };
}

/**
 * 租户初始化（`POST /tenant-app/v2/init-app`）—— 返回封禁状态。
 *
 * 需要 Cookie（会话已建立才有意义）。
 */
export async function fetchTenantState(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<{ banned: boolean }> {
  const payload = await accountApi(
    "POST",
    TENANT_INIT_PATH,
    { cookie: cookieHeader(credential) },
    cfgOverride,
  );
  const data = (payload["data"] && typeof payload["data"] === "object"
    ? payload["data"]
    : {}) as Record<string, unknown>;
  return { banned: data["banned"] === true };
}

/**
 * 积分余额（`GET /points/balance`）—— 需要 Cookie。
 *
 * 返回结构实测含两个池（通用积分 / 星火积分），见 PROTOCOL §8.2。
 */
export async function fetchPointsBalance(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const payload = await accountApi(
    "GET",
    POINTS_BALANCE_PATH,
    { cookie: cookieHeader(credential) },
    cfgOverride,
  );
  const data = payload["data"];
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/**
 * 从模型配置响应里挑出模型网关 Bearer。
 *
 * 取法与 AStudio 源码一致（`fetchAstronModelCredential`）：
 * `is_current` → `is_default` → `data[0]`，取它的 `api_key`。
 */
export function pickModelBearerToken(payload: unknown): string {  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("model configs payload is malformed");
  }
  const data = (payload as Record<string, unknown>)["data"];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("model configs payload has no data array");
  }
  const rows = data.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  const chosen =
    rows.find((row) => row["is_current"] === true) ??
    rows.find((row) => row["is_default"] === true) ??
    rows[0];
  const apiKey = chosen?.["api_key"];
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("AStudio account has no available model credential");
  }
  return apiKey.trim();
}

/**
 * 刷新凭据：带 Cookie 打 `/bot/models/configs`，取 `api_key` 作为新的 Bearer。
 *
 * 供 `cred.refresh()` 调用。
 */
export async function fetchModelBearerToken(credential: cred.Credentials): Promise<string> {
  const payload = await fetchModelConfigs(credential);
  return pickModelBearerToken(payload);
}

// ── 模型目录载荷（登录校验 + 配置落盘）──────────────────────────────────────

/**
 * 拉一次模型载荷：既验证凭据可用，也顺带把上游连接配置落盘。
 *
 * AStudio **没有**网关侧的 `/models` 端点，故这里打的是云端配置端点
 * （`/bot/models/configs`）。目录本身是随包内置的（见 `catalog.ts`），
 * 本函数只负责「确认凭据还活着」并返回配置载荷。
 */
export async function fetchModels(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  return fetchModelConfigs(credential, cfgOverride);
}

/**
 * 从模型载荷推导连接配置。
 *
 * 端点固定，载荷不下发连接信息 —— 返回默认配置（保留本函数是为了契约一致）。
 */
export function resolveConfig(_data: Record<string, unknown>, fallback?: Config): Config {
  return { ...(fallback ?? defaultConfig()) };
}

// ── 请求体改写 ───────────────────────────────────────────────────────────────

/**
 * 把下游 OpenAI 请求改写成 AStudio 模型网关能接受的形状。
 *
 * - `model` 换成池内归一化后的上游模型 id；
 * - `reasoning_effort` **校验档位在该模型的档位表内**，不过就静默删掉
 *   （给一个远端不认的值比不给更糟 —— 会回 400）；
 * - `stream` 恒 true（客户端要非流式由网关聚合）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  const effort = body["reasoning_effort"];
  if (effort !== undefined) {
    const known = catalog.modelEffortLevels(upstreamModel);
    const value = typeof effort === "string" ? effort : "";
    if (!value || !known.includes(value)) {
      delete body["reasoning_effort"]; // 静默不下发（退回服务端默认档）
    }
  }

  body["stream"] = true;
  return body;
}

/** 翻译器接口（`WIRE === "openai"` 时网关不会调用，导出仅为契约一致）。 */
interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/** 恒等翻译器。 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}
