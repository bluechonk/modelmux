/**
 * Raccoon（商汤小浣熊）上游：端点表 + 基址解析、三种请求头形态、思考通道与请求体安全化。
 *
 * 关键约束（端点/字段/实测见 docs/channels/raccoon/PROTOCOL.md）：
 *   - 本模块是渠道「地址」的唯一真相源，`cred.ts` 单向导入本模块（不反向依赖，避免循环依赖）。
 *   - 思考控制只能翻译进 `extra_body.thinking`（`reasoning_effort` 等原样透传无效）；只有明确的「关闭」才关，未知档位按开启处理。
 *   - `max_tokens` 只放行安全正整数（0/负数/NaN 会让整轮对话起不来）；`tools` 必须真的下发到请求体顶层。
 */

import { readFileSync } from "node:fs";

import { ensureDir, upstreamPath, writeJsonFile } from "@modelmux/gateway";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "Raccoon";

// ── 端点表（渠道的「地址真相源」）────────────────────────────────────────────
//
// 每个常量旁注「方法 + 完整 URL + 端点路径 + query/body 来源」。
// 完整 URL 一律由 `channelBaseUrl()` + 路径拼出，**别处不再拼第二次**。

/** 接口基址。 */
export const DEFAULT_BASE_URL = "https://xiaohuanxiong.com";

/** 鉴权域前缀。 */
const AUTH_PREFIX = "/api/web/auth/v1";
/** 推理域前缀。 */
const LLM_PREFIX = "/api/web/llm/v2";
/** 积分域前缀。 */
const POINTS_PREFIX = "/api/web/points/v1";
/** 桌面端域前缀。 */
const DESKTOP_PREFIX = "/api/web/desktop/v1";
/** 办公端域前缀（每日积分触发器挂在这里）。 */
const OFFICE_PREFIX = "/api/web/office/v3";

/**
 * 授权码换凭证（网页登录第二步）。
 * - 方法：POST
 * - 完整 URL：`{基址}/api/web/auth/v1/login_with_authorization_code`
 * - 端点路径：`/api/web/auth/v1/login_with_authorization_code`
 * - body：`{authorization_code}`；失败业务码 `200035`（码已失效/已消费，终态）
 */
const EXCHANGE_PATH = `${AUTH_PREFIX}/login_with_authorization_code`;
/**
 * 续期。
 * - 方法：POST
 * - 完整 URL：`{基址}/api/web/auth/v1/refresh`
 * - 端点路径：`/api/web/auth/v1/refresh`
 * - body：`{refresh_token}`；响应可能只给新的 access_token（此时**保留旧 refresh_token**）
 */
const REFRESH_PATH = `${AUTH_PREFIX}/refresh`;
/**
 * 用户信息（只用于昵称/手机号展示，失败不阻塞）。
 * - 方法：GET
 * - 完整 URL：`{基址}/api/web/auth/v1/user_info`
 * - 端点路径：`/api/web/auth/v1/user_info`
 * - query：无
 */
const USER_INFO_PATH = `${AUTH_PREFIX}/user_info`;
/**
 * 对话。
 * - 方法：POST
 * - 完整 URL：`{基址}/api/web/llm/v2/chat/completions`
 * - 端点路径：`/api/web/llm/v2/chat/completions`
 * - 必需 query：无
 */
const CHAT_PATH = `${LLM_PREFIX}/chat/completions`;
/**
 * 模型目录。
 * - 方法：GET
 * - 完整 URL：`{基址}/api/web/llm/v2/model_catalog`
 * - 端点路径：`/api/web/llm/v2/model_catalog`
 * - 必需 query：无
 */
const MODEL_CATALOG_PATH = `${LLM_PREFIX}/model_catalog`;
/**
 * 积分余额（**只读**）。
 * - 方法：GET
 * - 完整 URL：`{基址}/api/web/points/v1/balance`
 * - 端点路径：`/api/web/points/v1/balance`
 * - query：无
 */
const BALANCE_PATH = `${POINTS_PREFIX}/balance`;
/**
 * 积分账单。
 * - 方法：GET
 * - 完整 URL：`{基址}/api/web/points/v1/bills?paging.limit=<n>&paging.offset=0`
 * - 端点路径：`/api/web/points/v1/bills`
 * - query：`paging.limit` / `paging.offset`（分页；参考实现用 20，本仓用 50）
 */
const BILLS_PATH = `${POINTS_PREFIX}/bills`;
/** 账单分页条数（参考实现用 20，本仓用 50）。 */
const BILLS_LIMIT = 50;
/**
 * 桌面端登录奖励（**一次性幂等**，不是每日签到）。
 * - 方法：POST
 * - 完整 URL：`{基址}/api/web/desktop/v1/login/points/grant`
 * - 端点路径：`/api/web/desktop/v1/login/points/grant`
 * - body：无；**需 `X-Client-Platform` 头**
 */
const LOGIN_GRANT_PATH = `${DESKTOP_PREFIX}/login/points/grant`;
/**
 * 每日积分触发器（**按天幂等**，发放由服务端完成；账单才是入账的权威判据）。
 * - 方法：GET
 * - 完整 URL：`{基址}/api/web/office/v3/setting_info`
 * - 端点路径：`/api/web/office/v3/setting_info`
 * - query：无；**需 `X-Client-Platform` 头**
 */
const SETTING_INFO_PATH = `${OFFICE_PREFIX}/setting_info`;

/** 授权码失效 / 已消费（换码时按终态处理）。 */
export const AUTHORIZATION_CODE_NOT_FOUND = 200035;

/** 客户端身份（`X-Client-Platform` 猜错会被拒）。 */
const CLIENT_PLATFORM = "desktop-windows";
export const USER_AGENT = "Raccoon Work/1.0.35 (Windows)";

/** 上游线型：标准 OpenAI 兼容 SSE，网关只需规范化透传。 */
export const WIRE: "openai" | "custom" = "openai";

const HTTP_TIMEOUT_MS = 60_000;

/** 上游 API 拒绝了访问令牌（HTTP 401/403 或 code 200003）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 Raccoon 端点。 */
interface Config {
  baseUrl: string;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
interface AuthLike {
  accessToken: string;
  officeIdentity: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
}

/**
 * 磁盘上游描述符（`upstream.json`）里的基址；读不到 / 形状不对返回空串。
 *
 * 描述符由共享层在登录成功后落盘（`saveConfig`），内容只有 baseUrl。
 */
function persistedBaseUrl(): string {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as { baseUrl?: unknown };
    return typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
  } catch {
    return "";
  }
}

/** 读取已解析的上游描述符；返回 `[配置, 是否来自磁盘]`。 */
export function loadConfig(): [Config, boolean] {
  const baseUrl = persistedBaseUrl();
  return baseUrl ? [{ baseUrl }, true] : [defaultConfig(), false];
}

/**
 * 渠道基址（**唯一真源**：鉴权域与推理域必须用同一个）。
 *
 * 优先级（自上而下）：
 *   1. `override`：调用方显式指定的基址（**取值等于默认值时视为未指定**）
 *   2. 环境变量 `RACCOON_API_BASE_URL`
 *   3. 磁盘上游描述符里的 baseUrl
 *   4. `DEFAULT_BASE_URL`
 *
 * ⚠ 曾经鉴权域只认环境变量、推理域只读磁盘描述符 ⇒ 设了环境变量就会出现
 * 「登录在镜像、对话在官方」，镜像签发的 token 被官方拒（401）。
 */
export function channelBaseUrl(opts: { override?: string } = {}): string {
  const explicit = opts.override && opts.override !== DEFAULT_BASE_URL ? opts.override : "";
  const raw = explicit || process.env["RACCOON_API_BASE_URL"] || persistedBaseUrl() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** 持久化上游描述符（临时文件 + 原子替换）。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

// ── 端点 URL（基址一律走 channelBaseUrl）─────────────────────────────────────
//
// 每个 builder 的可选 `override` 是「显式基址」；不传时走统一规则
// （显式 > 环境变量 > 磁盘描述符 > 默认值）。

/**
 * 对话端点。
 * - 方法：POST
 * - 完整 URL：`https://xiaohuanxiong.com/api/web/llm/v2/chat/completions`
 * - 端点路径：`/api/web/llm/v2/chat/completions`
 * - 必需 query：无
 */
export function chatUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${CHAT_PATH}`;
}

/**
 * 模型目录端点（**请求头内联，不含 platform**）。
 * - 方法：GET
 * - 完整 URL：`https://xiaohuanxiong.com/api/web/llm/v2/model_catalog`
 * - 端点路径：`/api/web/llm/v2/model_catalog`
 * - 必需 query：无
 */
export function modelsUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${MODEL_CATALOG_PATH}`;
}

/** 授权码换凭证端点（网页登录第二步；body `{authorization_code}`）。 */
export function exchangeCodeUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${EXCHANGE_PATH}`;
}

/** 续期端点（body `{refresh_token}`）。 */
export function refreshUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${REFRESH_PATH}`;
}

/** 用户信息端点。 */
export function userInfoUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${USER_INFO_PATH}`;
}

/** 积分余额端点。 */
export function balanceUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${BALANCE_PATH}`;
}

/** 账单端点（查奖励是否已领；query 见 `BILLS_PATH`）。 */
export function billsUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${BILLS_PATH}?paging.limit=${BILLS_LIMIT}&paging.offset=0`;
}

/** 桌面端登录奖励端点（**platform 必需**；一次性新手奖励，不是每日签到）。 */
export function loginGrantUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${LOGIN_GRANT_PATH}`;
}

/**
 * 每日积分触发器（`GET`，**platform 必需**）。
 *
 * 官方桌面端每次启动都会打这个接口，服务端据此**按天幂等**发放每日积分
 * —— 它才是「签到」的真正触发点（发放在服务端完成，账单是权威结果）。
 */
export function settingInfoUrl(override?: string): string {
  return `${channelBaseUrl({ override })}${SETTING_INFO_PATH}`;
}

// ── 请求头（三种形态）─────────────────────────────────────────────────────────

interface HeaderOptions {
  /** 带 `Content-Type: application/json`（有 body 时）。 */
  jsonBody?: boolean;
  /** 带 `X-Client-Platform`（grant 必需；对话也有）。 */
  platform?: boolean;
}

/**
 * 首帧静默上限：**180 秒**（共享层默认 120s）。
 *
 * Raccoon 的长上下文首字很慢：实测 313 条消息 / 19 万 prompt token 的请求首字
 * 105 秒、1106 条消息 / 46 万 token 的请求 99 秒（见 `~/.modelmux/logs/access/`），
 * 同期成功的请求耗时 62–115 秒 —— **正好卡在 120 秒线上**，慢几秒就被掐成
 * `upstream header timeout after 120000ms`。
 *
 * ⚠ 那个超时还会被记成**账号连败**（`http/chat/attempt.ts`：`status <= 0` 计连败），
 * 两次就把健康账号打成 `error` 而锁死路由（2026-10-26 实测：RaccoonCharlotte
 * 「连续失败 2 次」）。放宽到 180s 后这类「只是慢」的请求不再被误杀。
 *
 * 只放宽「连接层静默容忍」，不改变任何协议语义。
 */
export function idleTimeoutMs(): number {
  return 180_000;
}

/**
 * 构造上游请求头。
 *
 * ⚠ 对话形态**不含** `X-Client-Version` / `X-Client-Device-ID`（协议 §2.1 内联实测）；
 * 这两个头原先只随**已移除的短信登录**发出（全仓无其它发送方）⇒ 不再构造。
 * ⚠ 对话形态也**不含** `User-Agent`（只有 `jsonHeaders` 那一族带）。
 */
export function buildHeaders(credential: AuthLike, opts: HeaderOptions = {}): Record<string, string> {
  const chat = opts.jsonBody ?? true;
  const platform = opts.platform ?? true;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    // 个人账号为空串；客户端**总是**发送该头
    "X-Org-Code": credential.officeIdentity || "",
    "X-Raccoon-Language": "zh",
  };
  if (chat) {
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "text/event-stream";
  } else {
    headers["Accept"] = "application/json";
  }
  if (platform) headers["X-Client-Platform"] = CLIENT_PLATFORM;
  return headers;
}

/** 探活/管理端点用的头（JSON Accept，无 platform）。 */
function jsonHeaders(credential: AuthLike): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "X-Org-Code": credential.officeIdentity || "",
    "X-Raccoon-Language": "zh",
    "User-Agent": USER_AGENT,
  };
}

// ── 请求体改写 ────────────────────────────────────────────────────────────────

const THINKING_TYPES = new Set(["adaptive", "enabled", "disabled"]);
const OFF_VALUES = new Set(["off", "none", "disabled", "false", "no", "0"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSystemMessage(msg: unknown): boolean {
  return isRecord(msg) && msg["role"] === "system";
}

/** `system` 提示词提升为 `messages[0]`（多条字符串内容用 `\n\n` 合并）。 */
function hoistSystemMessages(messages: unknown[]): unknown[] {
  const systems = messages.filter(isSystemMessage);
  if (systems.length === 0) return [...messages];
  const contents = systems.map((m) => (m as Record<string, unknown>)["content"]);
  if (contents.some((c) => typeof c !== "string")) return [...messages];
  const merged: Record<string, unknown> = { ...(systems[0] as Record<string, unknown>) };
  merged["role"] = "system";
  merged["content"] = (contents as string[]).join("\n\n");
  return [merged, ...messages.filter((m) => !isSystemMessage(m))];
}

/** 从 `{type: '...'}` 形态里取合法枚举；非法/缺失返回 ""。 */
function thinkingType(value: unknown): string {
  if (!isRecord(value)) return "";
  const type = value["type"];
  return typeof type === "string" && THINKING_TYPES.has(type) ? type : "";
}

/**
 * 把下游的思考意图翻译成 `extra_body.thinking.type`（**唯一有效通道**）。
 *
 * 优先级：合法 `extra_body.thinking` > 合法顶层 `thinking` > `reasoning_effort`
 * （`off`/`none`/`disabled`/`false` → `disabled`，其余任何值 → `enabled`）。
 * 三处都没有 → **不发该字段**（服务端默认 = 开启，实测与显式 enabled 等价）。
 */
function resolveThinkingType(req: Record<string, unknown>): string {
  const explicit = thinkingType(isRecord(req["extra_body"]) ? req["extra_body"]["thinking"] : undefined);
  if (explicit) return explicit;
  const topLevel = thinkingType(req["thinking"]);
  if (topLevel) return topLevel;
  const effort = req["reasoning_effort"];
  if (effort === undefined) return "";
  if (typeof effort === "string") {
    return OFF_VALUES.has(effort.toLowerCase()) ? "disabled" : "enabled";
  }
  if (effort === false) return "disabled";
  // ⚠ 未知档位一律按开启处理（只有明确的「关闭」才关）
  return "enabled";
}

/** `max_tokens` 只放行安全正整数；其余**删掉该键**（远端输入不能崩掉整轮对话）。 */
function sanitizeMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

/**
 * 把下游 OpenAI 请求改写成 Raccoon 能接受的形状。
 *
 * - `system` 提升为 `messages[0]`
 * - 思考：翻译进 `extra_body.thinking`（**`reasoning_effort` 绝不通透**）
 * - `max_tokens` 安全化
 * - `tools` 留在顶层
 * - 恒设 `stream: true`（客户端要非流式由网关聚合）
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  if (Array.isArray(body["messages"])) {
    body["messages"] = hoistSystemMessages(body["messages"] as unknown[]);
  }

  delete body["reasoning_effort"]; // 被服务端接受但实测无效果 ⇒ 不原样透传
  delete body["thinking"]; // 顶层 thinking 会被上游忽略

  const thinking = resolveThinkingType(req);
  if (thinking) {
    body["extra_body"] = { thinking: { type: thinking } };
  } else {
    delete body["extra_body"];
  }

  const maxTokens = sanitizeMaxTokens(body["max_tokens"]);
  if (maxTokens === undefined) delete body["max_tokens"];
  else body["max_tokens"] = maxTokens;

  body["stream"] = true;
  return body;
}

// ── 端点调用 ──────────────────────────────────────────────────────────────────

function isAuthFailure(status: number, code: number): boolean {
  return status === 401 || status === 403 || code === 200003;
}

/**
 * 拉模型目录（**内联头**：Accept json、无 platform、无 Content-Type）。
 * 401/403/200003 → `UpstreamUnauthorized`。
 */
export async function fetchModels(credential: AuthLike): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(modelsUrl(), {
      headers: jsonHeaders(credential),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Model catalog request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`Raccoon rejected the access token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`Model catalog returned HTTP ${resp.status}`);
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`Model catalog response is not valid JSON: ${String(err)}`);
  }
  const record = isRecord(payload) ? payload : {};
  const code = typeof record["code"] === "number" ? record["code"] : 0;
  if (isAuthFailure(resp.status, code)) {
    throw new UpstreamUnauthorized(`Raccoon session expired (code=${code})`);
  }
  return record;
}

/**
 * 从模型载荷推导连接配置。Raccoon 端点固定（保留本函数是为了契约一致）。
 */
export function resolveConfig(_data: Record<string, unknown>, fallback?: Config): Config {
  return { ...(fallback ?? defaultConfig()) };
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
