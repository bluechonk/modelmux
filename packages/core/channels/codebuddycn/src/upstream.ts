/**
 * CodeBuddy 国内版上游：端点表 + 头族 + 请求体改写 + 模型目录拉取。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codebuddycn/PROTOCOL.md）：
 *   - 对话端点是 `/v2/chat/completions`，请求体是 **gzip 压缩**的 OpenAI 形态
 *     （`Content-Encoding: gzip` + `Accept-Encoding: identity`）——不压缩会被上游拒。
 *   - 头族按账号带 `X-User-Id` / `X-Domain` / `X-Enterprise-Id`，并伪装官方 CLI
 *     身份（User-Agent / X-IDE-* / x-stainless-*）—— 上游按整组头判定是否官方客户端。
 *   - 模型目录在 `/v2/enterprises/personal/models`（仅个人账号；企业账号无此表）。
 */

import { readFileSync } from "node:fs";

import { login as shared, upstreamPath } from "@modelmux/gateway";

import * as cred from "./cred.js";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "CodeBuddy 国内版";

/** 接口基址（国内版固定，不做 `--realm` 漂移）。 */
export const DEFAULT_BASE_URL = "https://copilot.tencent.com";

/** 对话路径（完整 URL = 基址 + 路径）。 */
const CHAT_PATH = "/v2/chat/completions";
/** 模型目录（GET）——**账单主机**，不是对话主机。 */
const MODELS_PATH = "/v2/enterprises/personal/models";
/** 目录兜底（GET，官方云模型目录 `/v3/config`，在对话主机上）。 */
const CONFIG_PATH = "/v3/config";
/** 账单/目录主机（与对话主机分离；额度与签到端点也在这里）。 */
export const BILLING_BASE_URL = "https://www.codebuddy.cn";

/** 官方 CLI 版本（头族里的 `X-IDE-Version` / User-Agent）。 */
const CLI_VERSION = "2.179.3";
const USER_AGENT = `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`;

/** 上游线型：标准 OpenAI 兼容 SSE（delta 帧 + usage 帧 + [DONE]）。 */
export const WIRE: "openai" | "custom" = "openai";

const HTTP_TIMEOUT_MS = 60_000;

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 凭据的最小面（避免 upstream <-> cred 循环依赖）。 */
interface AuthLike {
  accessToken: string;
  uid: string;
  domain: string;
  enterpriseId: string;
}

// ── 端点 ─────────────────────────────────────────────────────────────────────

/** 描述如何到达 CodeBuddy 端点。 */
interface Config {
  baseUrl: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
}

/** 磁盘上游描述符（`upstream.json`）里的基址；读不到 / 形状不对返回空串。 */
function persistedBaseUrl(): string {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const base = parsed["baseUrl"];
    return typeof base === "string" && base.startsWith("http") ? base : "";
  } catch {
    return "";
  }
}

/** 解析生效基址：磁盘描述符优先，否则默认。 */
export function resolveConfig(): Config {
  return { baseUrl: persistedBaseUrl() || defaultConfig().baseUrl };
}

/**
 * 读磁盘上游描述符（共享层契约要求）。
 *
 * @returns `[配置, 是否读到]`；读不到时给默认配置 + `false`（与其它渠道同形）。
 */
export function loadConfig(): [Config, boolean] {
  const baseUrl = persistedBaseUrl();
  return [baseUrl ? { baseUrl } : defaultConfig(), Boolean(baseUrl)];
}

export async function saveConfig(_cfg: Config): Promise<void> {
  // 端点固定，没有需要持久化的地址；保留签名以对齐契约。
}

/** 对话端点。 */
export function chatUrl(): string {
  return `${resolveConfig().baseUrl}${CHAT_PATH}`;
}

/** 模型目录端点（账单主机，GET）。 */
export function modelsUrl(): string {
  return `${BILLING_BASE_URL}${MODELS_PATH}`;
}

/** 目录兜底端点（官方云模型目录，GET）。 */
export function configUrl(): string {
  return `${resolveConfig().baseUrl}${CONFIG_PATH}`;
}

// ── 请求头 ───────────────────────────────────────────────────────────────────

/** 官方 SDK 伪装头（上游按整组头判定「是否官方客户端」）。 */
const SDK_HEADERS: Record<string, string> = {
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Linux",
  "x-stainless-package-version": "7.39.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.21.0",
  "X-Agent-Intent": "craft",
  "X-Agent-Purpose": "conversation",
  "X-Agent-Type": "main",
  "X-Private-Data": "false",
  "X-CodeBuddy-Request": "1",
  "X-Agent-Runtime": "other",
};

/**
 * 构造上游请求头。
 *
 * `chat` 形态带 `Accept: text/event-stream`；`json` 形态（目录 / 登录）带
 * `Accept: application/json`。`Authorization` 只在有 accessToken 时给
 * （续期请求不带）。
 */
export function buildHeaders(
  credential: AuthLike,
  opts: { chat?: boolean; json?: boolean } = {},
): Record<string, string> {
  const chat = opts.chat ?? false;
  const json = opts.json ?? false;
  const headers: Record<string, string> = {
    ...SDK_HEADERS,
    "User-Agent": USER_AGENT,
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CLI_VERSION,
    "X-User-Id": credential.uid,
    "X-Domain": credential.domain || "www.codebuddy.cn",
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (credential.accessToken) headers["Authorization"] = `Bearer ${credential.accessToken}`;
  if (credential.enterpriseId) {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
    // 企业账号默认压下隐私数据标记（官方 CLI 2.165+ 行为）
    headers["X-Private-Data"] = "true";
  }
  if (chat) {
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "text/event-stream";
    // 对话体走 gzip：不接受压缩回包
    headers["Accept-Encoding"] = "identity";
    headers["Content-Encoding"] = "gzip";
  } else if (json) {
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "application/json";
  } else {
    headers["Accept"] = "application/json";
  }
  return headers;
}

// ── 请求体改写 ───────────────────────────────────────────────────────────────

/**
 * 把下游 OpenAI 请求改写成上游能接受的形状。
 *
 * - `model` 换成上游 id
 * - `developer` 角色上游不接受 → 复制成 `system`（内容不变，位置不动）
 * - 恒设 `stream: true`（客户端要非流式由网关聚合）
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel, stream: true };
  if (Array.isArray(body["messages"])) {
    body["messages"] = (body["messages"] as unknown[]).map((message) =>
      message && typeof message === "object" && !Array.isArray(message) && (message as Record<string, unknown>)["role"] === "developer"
        ? { ...(message as Record<string, unknown>), role: "system" }
        : message,
    );
  }
  return body;
}

// ── 模型目录 ─────────────────────────────────────────────────────────────────

/** 目录请求头（GET，带 X-Request-ID —— 官方账单域要求）。 */
function catalogHeaders(credential: AuthLike): Record<string, string> {
  return {
    ...buildHeaders(credential, { json: true }),
    Accept: "application/json, text/plain, */*",
    "X-Request-ID": shared.randomHex(16),
  };
}

async function getJson(url: string, credential: AuthLike): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "GET",
    headers: catalogHeaders(credential),
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`CodeBuddy rejected the access token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`Model catalog returned HTTP ${resp.status}`);
  return (await resp.json().catch(() => {
    throw new Error("Model catalog response is not valid JSON");
  })) as Record<string, unknown>;
}

/**
 * 拉模型目录：先 `GET /v2/enterprises/personal/models`（账单主机，个人账号专用），
 * 404/405 时回落官方云目录 `GET /v3/config`（企业账号没有个人模型表）。
 */
export async function fetchModels(credential: AuthLike): Promise<Record<string, unknown>> {
  let firstStatus = 0;
  try {
    return await getJson(modelsUrl(), credential);
  } catch (err) {
    if (err instanceof UpstreamUnauthorized) throw err;
    firstStatus = err instanceof Error && /HTTP (\d+)/.exec(err.message)?.[1]
      ? Number(/HTTP (\d+)/.exec(err.message)![1])
      : 0;
  }
  if (![404, 405, 501].includes(firstStatus)) {
    throw new Error(`Model catalog request failed: HTTP ${firstStatus || "network"}`);
  }
  return getJson(configUrl(), credential);
}

/** 翻译器接口（`WIRE === "openai"` 时网关不会调用，导出仅为契约一致）。 */
interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/** 恒等翻译器（标准 OpenAI SSE 直透）。 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}
