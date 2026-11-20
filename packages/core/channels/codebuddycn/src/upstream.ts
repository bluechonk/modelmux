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

import { createHash, randomUUID } from "node:crypto";
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

/**
 * 对话请求头族（网关 `buildChatHeaders` 钩子）：基础头 + 会话/链路追踪头。
 *
 * 会话与链路头是多家实现共同收敛的最小集（Agent2Providers / ccLoad / Buddy2api）：
 * `X-Conversation-ID` 在同一会话内稳定（按首条 user 消息派生，账号维度隔离），
 * 每请求随机的 request/message id 与 W3C trace 头让上游能把一条请求串成一棵链路树。
 * 稳定 conversation id 的反面教训：每请求随机会话 id = 上游看到「新会话 + 完整历史」矛盾。
 */
export function buildChatHeaders(
  credential: AuthLike,
  _cfg?: unknown,
  body?: Buffer,
): Record<string, string> {
  const headers = buildHeaders(credential, { chat: true });
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = traceId.slice(0, 16);
  headers["X-Request-ID"] = traceId;
  headers["X-Root-Request-ID"] = traceId;
  headers["X-Trace-ID"] = traceId;
  headers["traceparent"] = `00-${traceId}-${spanId}-01`;
  headers["b3"] = `${traceId}-${spanId}-1`;
  headers["X-B3-TraceId"] = traceId;
  headers["X-B3-SpanId"] = spanId;
  headers["X-B3-Sampled"] = "1";
  headers["X-Conversation-ID"] = conversationIdOf(body);
  headers["X-Conversation-Request-ID"] = randomUUID();
  headers["X-Conversation-Message-ID"] = randomUUID();
  return headers;
}

/** 会话指纹：首条 user 消息文本派生（同会话各轮相同）；没有 user 消息时每请求随机。 */
function conversationIdOf(body?: Buffer): string {
  let firstUser = "";
  if (body) {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { messages?: Array<Record<string, unknown>> };
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      for (const m of messages) {
        if ((m?.["role"] ?? "") !== "user") continue;
        const content = m["content"];
        firstUser = typeof content === "string" ? content : JSON.stringify(content ?? "");
        break;
      }
    } catch {
      /* 解析失败 → 随机 */
    }
  }
  if (firstUser === "") return randomUUID();
  return createHash("sha256").update(firstUser, "utf8").digest("hex").slice(0, 32);
}

// ── 请求体改写 ───────────────────────────────────────────────────────────────

/**
 * 上游「渠道校验」（业务码 11128）的真实触发因是**提示词指纹**：官方回复明确是针对
 * 反代滥用的 DeepSeek Harness 检测，读 system 与 assistant 消息、不读 user 与工具
 * 结果（magpie REFUSED.md + Buddy2api #115 + Android-AI-gateway #16 多源实测）。
 * 触发表随上游更新：目前实锤 `DeepSeek Harness` / `DeepSeekRuntime`（两种写法）、
 * `workspace root` 路径说明句、字面量 `11-128`（最后这条不做改写 —— 语义会变，
 * 触发时按「11128 指纹拦截」如实透传给客户端）。这里做**最小改写**（同义替换，
 * 不用零宽字符）—— 改写不影响语义，换来的是 DSH 长会话能正常走这条渠道。
 */
const REFUSAL_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/DeepSeek\s*[-_ ]?\s*Harness/gi, "CodeBuddy Harness"],
  [/DeepSeek\s*[-_ ]?\s*Runtime/gi, "CodeBuddy Runtime"],
  [/workspace root/gi, "project root"],
];

/** 对 system / assistant 文本做指纹改写（user 与 tool 结果上游不读，不动）。 */
function sanitizeRefusal(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REFUSAL_REWRITES) out = out.replace(pattern, replacement);
  return out;
}

/** 上游拒绝的文本路径提取（string 或 content 数组里的 text 段）。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === "object" && !Array.isArray(p) && (p as Record<string, unknown>)["type"] === "text",
    )
    .map((p) => (typeof p["text"] === "string" ? p["text"] : ""))
    .join("");
}

/** 文本路径回写（与 `textOf` 同构）；没有文本段时原样返回。 */
function writeText(content: unknown, rewrite: (text: string) => string): unknown {
  if (typeof content === "string") return rewrite(content);
  if (!Array.isArray(content)) return content;
  return content.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return p;
    const part = p as Record<string, unknown>;
    if (part["type"] === "text" && typeof part["text"] === "string") {
      return { ...part, text: rewrite(part["text"]) };
    }
    return p;
  });
}

/** 上游拒绝的消息条数硬上限（Agent2API #48 实测：512 条稳定 400，511 条通过）。 */
const MAX_MESSAGES = 512;

/** 家族缺省 system：ccLoad/Agent2Providers 同款（上游要求首条必须是 system）。 */
const DEFAULT_SYSTEM =
  "You are CodeBuddy Code. You are an interactive CLI tool that helps users with software engineering tasks.";

/**
 * 把下游 OpenAI 请求改写成上游能接受的形状。
 *
 * - `model` 换成上游 id；恒设 `stream: true`（客户端要非流式由网关聚合）
 * - `developer` 角色上游不接受 → 复制成 `system`（内容不变，位置不动）
 * - system/assistant 文本做 11128 指纹改写（见 `REFUSAL_REWRITES`）
 * - 首条不是 system 时注入缺省 system（上游要求 system 在首条）
 * - `tool_choice` 对象 → 字符串；`none` 时删 tools/functions；`image_url` 字符串 → 对象；
 *   `max_completion_tokens` → `max_tokens`；补 `stream_options.include_usage`
 * - 消息条数 ≥ 512 → 直接报错（上游对条数上限是硬断连，报错要发生在建连之前）
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel, stream: true };
  if (Array.isArray(body["messages"])) {
    const messages = body["messages"] as unknown[];
    if (messages.length >= MAX_MESSAGES) {
      throw new Error(
        `messages exceed upstream limit: CodeBuddy accepts at most ${MAX_MESSAGES - 1} messages per request, got ${messages.length}`,
      );
    }
    const normalized = messages.map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return message;
      const m = message as Record<string, unknown>;
      let next: Record<string, unknown> =
        m["role"] === "developer" ? { ...m, role: "system" } : { ...m };
      if (next["role"] === "system" || next["role"] === "assistant") {
        next = { ...next, content: writeText(next["content"], sanitizeRefusal) };
      }
      return next;
    });
    if (
      !normalized.some(
        (m) =>
          m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>)["role"] === "system",
      )
    ) {
      normalized.unshift({ role: "system", content: sanitizeRefusal(DEFAULT_SYSTEM) });
    }
    body["messages"] = normalized;
  }
  // max_completion_tokens 是 max_tokens 的 OpenAI 别名；上游只认后者
  if (body["max_completion_tokens"] !== undefined) {
    if (body["max_tokens"] === undefined) body["max_tokens"] = body["max_completion_tokens"];
    delete body["max_completion_tokens"];
  }
  // stream_options：上游按 OpenAI 语义吃 include_usage
  if (body["stream_options"] === undefined) {
    body["stream_options"] = { include_usage: true };
  }
  // tool_choice：上游只认字符串形态；none 时工具清单必须一并删掉
  const choice = body["tool_choice"];
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const rec = choice as Record<string, unknown>;
    if (typeof rec["function"] === "object" && rec["function"] !== null) {
      body["tool_choice"] = (rec["function"] as Record<string, unknown>)["name"];
    } else {
      delete body["tool_choice"];
    }
  }
  if (choice === "none") {
    delete body["tools"];
    delete body["functions"];
    delete body["tool_choice"];
  }
  // image_url 字符串 → 对象形态（上游按 OpenAI 的 parts 结构解析）
  if (Array.isArray(body["messages"])) {
    body["messages"] = (body["messages"] as unknown[]).map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return message;
      const m = message as Record<string, unknown>;
      if (!Array.isArray(m["content"])) return m;
      return {
        ...m,
        content: (m["content"] as unknown[]).map((part) => {
          if (!part || typeof part !== "object" || Array.isArray(part)) return part;
          const p = part as Record<string, unknown>;
          if (p["type"] !== "image_url" || typeof p["image_url"] !== "string") return p;
          return { ...p, image_url: { url: p["image_url"] } };
        }),
      };
    });
  }
  return body;
}

/**
 * 额度信号（网关钩子）：额度族业务码来自多仓交叉的码表（Agent2Providers errors.rs /
 * Buddy2api / 9routerx）。`6004` 带上游重置时刻（usage_limit），`10105` 是 60 秒窗口
 * 的频率限制（rate_limit → 渠道级短冷却）；额度耗尽族按「余额不足」冷却账号。
 */
export function quotaSignal(status: number, body: string): "balance" | "usage_limit" | "rate_limit" | null {
  if (status === 402) return "balance";
  const codeOf = (code: string): boolean => new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(body);
  if (["14001", "14012", "14013", "14014", "14018", "14019"].some(codeOf)) return "balance";
  if (codeOf("6004")) return "usage_limit";
  if (codeOf("10105")) return "rate_limit";
  return null;
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
/**
 * 拉模型目录：`/v3/config` 为主（官方云模型目录，个人/企业都可用），个人模型表兜底。
 * Agent2Providers 已不再使用 personal/models；`/v3/config` 的可见性由
 * `agents[name=cli].models` 决定（解析见 catalog 的 `parseConfigModels`）。
 */
export async function fetchModels(credential: AuthLike): Promise<Record<string, unknown>> {
  let firstStatus = 0;
  try {
    return await getJson(configUrl(), credential);
  } catch (err) {
    if (err instanceof UpstreamUnauthorized) throw err;
    firstStatus = err instanceof Error && /HTTP (\d+)/.exec(err.message)?.[1]
      ? Number(/HTTP (\d+)/.exec(err.message)![1])
      : 0;
  }
  if (![404, 405, 501].includes(firstStatus)) {
    throw new Error(`Model catalog request failed: HTTP ${firstStatus || "network"}`);
  }
  return getJson(modelsUrl(), credential);
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
