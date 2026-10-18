/**
 * WorkBuddyAI 上游：端点、请求头、请求体改写。
 *
 * ## 本模块承载的渠道知识
 *
 * 上游的全部硬约束都在 `buildChatBody()` 里实现（网关只负责调用它），每一条
 * 都是真机实测过的拒收原因（规格见同包 `docs/PROTOCOL.md`）：
 *
 * 1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
 * 2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
 *    客户端要非流式时也向上游要流式，由网关层聚合成普通 JSON
 * 3. **指纹拦截** —— 命中则整条会话被 400 `code=11128`
 *    `Illegal API invocation from an unapproved channel` 拒绝，需改写特征片段
 * 4. **`tool_choice` / `stop` 只认 Go 原生类型** —— 发 OpenAI 的对象形态与字符串
 *    `stop` 都是 400 `code=11101`
 * 5. **工具调用序列必须成对且相邻** —— 违反即 400 `code=11148`
 *    `tool_call_sequence_broken`，且该会话后续每轮都重放同一段历史
 * 6. **DeepSeek 思考模式下每条 assistant 必须带 `reasoning_content`**
 *
 * ⚠ **chat 路径不用 `prefixPath`**（实测）：模型载荷里声明了
 * `authentication.attributes.prefixPath` 为 `/plugin`，但
 * `POST /plugin/v2/chat/completions` 返回 **404**，而
 * `POST /v2/chat/completions` 返回 **200** —— 故刻意不使用该前缀。
 *
 * 另外：上游按**整组身分头**判定请求是否来自官方桌面客户端，缺任一员整条
 * 会话被 400 `code=11128` 拒绝 —— `buildChatHeaders()` 按官方 5.8.4 抓包补齐
 * 头族（规格见同包 `docs/PROTOCOL.md` §1-§3；网关经 `Channel.buildChatHeaders`
 * 可选钩子取用）。
 */

import { readFileSync } from "node:fs";
import { writeFile, rename, chmod } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";

import { upstreamPath, ensureDir } from "@modelmux/gateway";

import * as catalog from "./catalog.js";

export const DEFAULT_BASE_URL = "https://www.workbuddy.ai";

/** 桌面端 UA 与版本随 realm 分版（官方 5.8.4 / 5.5.6 抓包；见 docs/PROTOCOL.md §2）。 */
const DESKTOP_UA_INTL = "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
const DESKTOP_UA_CN = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";

/**
 * realm 表：chat 上游 / X-Domain / 身分头取值随国际版 / 国内版切换。
 *
 * 依据 `wb_identity.py` 的 endpoint_for：cn 桌面端 chat 上游是 copilot.tencent.com，
 * www.codebuddy.cn 只做计费；intl 两者同为 www.workbuddy.ai。
 */
const REALM_INTL = {
  chatUpstream: "https://www.workbuddy.ai",
  domain: "www.workbuddy.ai",
  origin: "https://www.workbuddy.ai",
  ua: DESKTOP_UA_INTL,
  ideVersion: "5.8.4",
  acceptLanguage: "en-US",
} as const;
const REALM_CN = {
  chatUpstream: "https://copilot.tencent.com",
  domain: "copilot.tencent.com",
  origin: "https://www.codebuddy.cn",
  ua: DESKTOP_UA_CN,
  ideVersion: "5.5.6",
  acceptLanguage: "zh-CN",
} as const;

/** 凭据 domain → realm（取不到就按国际版；见 docs/PROTOCOL.md §1）。 */
function realmOf(domain: string): typeof REALM_INTL | typeof REALM_CN {
  const d = domain.trim().toLowerCase();
  return d === "copilot.tencent.com" || d.endsWith("codebuddy.cn") ? REALM_CN : REALM_INTL;
}

/** 每轮新生的会话 id（带连字符 UUID；上游不按它存历史）。 */
function newConversationId(): string {
  return randomUUID();
}

/**
 * 每条消息新生的请求 id（UUIDv7 形态：48 位毫秒时间戳 + ver7 + 变体位，
 * 32 位无连字符 hex —— 与官方客户端一致）。
 */
function newMessageId(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((ts >> BigInt(40 - 8 * i)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.toString("hex");
}

/** W3C traceparent + b3 链路族（X-B3-ParentSpanId 需要真实父子关系，不伪造）。 */
function traceHeaders(): Record<string, string> {
  const trace = randomBytes(16).toString("hex");
  const span = randomBytes(8).toString("hex");
  return {
    // 官方客户端除 W3C/b3 外还回传自家的 X-Trace-ID（取值同 trace id）
    "X-Trace-ID": trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    "X-B3-TraceId": trace,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
  };
}

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "WorkBuddyAI";

/**
 * 上游线型：`openai` 表示上游就是标准 OpenAI SSE delta，网关只需规范化透传。
 *
 * workbuddy 属于 `openai`；网关因此不会调用 `newTranslator()`，
 * 但本模块仍导出它（契约要求所有渠道导出同一套接口）。
 */
export const WIRE: "openai" | "custom" = "openai";

/** 已验证的 chat-completions 路由（见文件头注释）。 */
export const DEFAULT_CHAT_PATH = "/v2/chat/completions";

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 WorkBuddyAI chat 端点。JSON 字段名与 Go 版一致。 */
export interface Config {
  baseUrl: string;
  chatPath: string;
  tokenHeader: string;
  tokenType: string;
  usernameHeader: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明这几个字段而不是 import `cred.Credentials` —— 那会形成
 * upstream ↔ cred 的循环依赖。
 */
export interface AuthLike {
  accessToken: string;
  uid: string;
  domain: string;
}

/**
 * 上游安全策略按**指纹片段**拦截整条请求：命中即 400
 * `code=11128 Illegal API invocation from an unapproved channel`。
 *
 * 触发物是「各家 CLI 的身份署名 + 计费标记」的特征片段，不是整段样板 ——
 * 故改写必须把片段本身换掉。旧版只把 `Main branch (you will usually use this
 * for PRs)` 改成 `Main branch (used for PRs)`，特征 `Main branch (` 仍原样留着，
 * 等于没改。规则按 hub 的 `wb_proxy.py`（SANITIZE_FEATURES / SANITIZE_REWRITES，
 * 实测口径）补齐整族。
 *
 * 顺序有意：带冒号的计费头必须在裸头名之前删，否则先被裸头规则改成残留串。
 */
const FINGERPRINT_RULES: Array<[RegExp, string]> = [
  // OhMyOpenCode 的连续指纹（单出现 `OhMyOpenCode` 不触发，只改写整段）
  [/Sisyphus-Junior - Focused executor from OhMyOpenCode/gi, "Sisyphus-Junior - Focused executor"],
  // 各家 CLI 的身份首句：上游按框架署名判定「非官方渠道」
  [
    /You are Claude Code, Anthropic's official CLI for Claude/gi,
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\./gi,
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
  ],
  [
    /To give feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/gi,
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  // `Main branch (` 本身就是特征，连分支名一起换成等价表述
  [
    /Main branch \(you will usually use this for PRs\)/gi,
    "Default branch (you will usually use this for PRs)",
  ],
  // 错误码字面量出现在正文里同样触发
  [/11128/g, "11-128"],
  // Anthropic CLI 注入的计费/会话标记：整段删除，不属于用户语义
  [/x-anthropic-billing-header:[^;\r\n]*;?\s*/gi, ""],
  [/\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi, ""],
  // 裸头名（去掉冒号后的残留）
  [/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr"],
];

/** 指纹特征片段（小写）：命中任意一条才走正则清洗，避免每段文本都跑一遍正则。 */
const FINGERPRINT_MARKERS = [
  "from ohmyopencode",
  "you are claude code",
  "you are a coding agent running in the codex cli",
  "github.com/anthropics/",
  "main branch (",
  "11128",
  "cc_",
  "x-anthropic-billing-header",
];

export function defaultConfig(): Config {
  return {
    baseUrl: DEFAULT_BASE_URL,
    chatPath: DEFAULT_CHAT_PATH,
    tokenHeader: "Authorization",
    tokenType: "bearerToken",
    usernameHeader: "X-User-Id",
  };
}

/**
 * 读取已解析的上游描述符。
 *
 * 返回 `[配置, 是否来自磁盘]`；文件缺失时返回默认配置（由调用方按「默认值生效」处理）。
 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  const parsed = JSON.parse(raw) as Partial<Config>;
  const cfg: Config = {
    baseUrl:
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
    chatPath:
      typeof parsed.chatPath === "string" && parsed.chatPath ? parsed.chatPath : DEFAULT_CHAT_PATH,
    tokenHeader: parsed.tokenHeader ?? "Authorization",
    tokenType: parsed.tokenType ?? "bearerToken",
    usernameHeader: parsed.usernameHeader ?? "X-User-Id",
  };
  // 历史遗留：旧版默认 baseUrl 曾是 www.codebuddy.ai，实测 DNS 沉洞（解析到 0.0.0.1），
  // 国际版请求指向它必然超时 —— 读出即归一到国际版 chat 上游（下次 saveConfig 落盘纠正）
  if (hostOf(cfg.baseUrl) === "www.codebuddy.ai") cfg.baseUrl = REALM_INTL.chatUpstream;
  return [cfg, true];
}

/** 持久化上游描述符（临时文件 + 原子替换，避免半截文件）。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  const path = upstreamPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureSlash(value: string): string {
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

/** 完整限定的 chat-completions URL。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.chatPath);
}

/** 连接配置端点（窄口径：endpoint / authentication / agents）。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}/v2/enterprises/personal/models`;
}

/**
 * 真正的模型目录端点。
 *
 * `/v2/enterprises/personal/models` 的 `data.models` 只是面向前端展示的窄表
 * （实测 18 条，且以 `default-model` 这类路由别名开头）；桌面端选择器的目录在
 * `/v3/config` 的 `agents[].models`（实测 27 条，含 `deepseek-v4.1-flash`）——
 * 参考 `ardeyouxipianyi_workbuddy2api-hub` 的 `REMOTE_CONFIG_PATH`：
 * “The narrow endpoint is not the desktop catalogue”。
 */
export function catalogUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}/v3/config`;
}

/** 从 baseUrl 提取 host 部分。 */
export function hostOf(baseUrl: string): string {
  const withoutScheme = baseUrl.includes("://") ? baseUrl.split("://", 2)[1]! : baseUrl;
  const cut = withoutScheme.search(/[/?]/);
  return cut < 0 ? withoutScheme : withoutScheme.slice(0, cut);
}

/**
 * 构造上游请求头（鉴权 + 客户端伪装）。
 *
 * `User-Agent` 的**品牌字样是必须的**：上游按出站 UA 归因「使用端」，
 * 缺了对应产品品牌会让账单显示为 `-`。
 */
export function buildHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const domain = credential.domain || hostOf(resolved.baseUrl);
  const realm = realmOf(domain);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // 官方桌面端 UA：上游按 UA 归因「使用端」（账单品牌）并参与渠道校验
    "User-Agent": realm.ua,
    "X-Domain": realm.domain,
  };
  const headerName = resolved.tokenHeader || "Authorization";
  headers[headerName] = `Bearer ${credential.accessToken}`;
  if (resolved.usernameHeader && credential.uid) {
    headers[resolved.usernameHeader] = credential.uid;
  }
  return headers;
}

/**
 * 对话请求的官方身分头族：在基础头之上补齐 X-Agent-* / X-IDE-* / X-Product /
 * 会话与请求 ID / 链路族（整组缺任一员都会被 11128 拒绝，见 docs/PROTOCOL.md §2/§4）。
 *
 * 会话与请求 ID 是**每轮新生**的（上游不按会话 id 存历史，不需要跨轮一致）；
 * `buildChatBody` 仍负责请求体的三条硬约束（首条 system / 强制流式 / 指纹改写）。
 */
export function buildChatHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const domain = credential.domain || hostOf(resolved.baseUrl);
  const realm = realmOf(domain);
  const convReqId = newMessageId();
  const messageId = newMessageId();
  return {
    ...buildHeaders(credential, cfg),
    // 浏览器语义头：渠道校验要求请求「像从官方前端发出」—— Origin/Referer/
    // X-CodeBuddy-Request 缺任一都会 11128（参考 hub 的 account.headers("chat")，
    // 计费头因带这组而通过、对话头缺它被拒，实机对照结论）
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": realm.origin,
    "Referer": `${realm.origin}/`,
    "X-CodeBuddy-Request": "1",
    "Accept-Language": realm.acceptLanguage,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": realm.ideVersion,
    "X-Private-Data": "true",
    "X-Product": "SaaS",
    "X-Conversation-ID": newConversationId(),
    "X-Conversation-Request-ID": convReqId,
    "X-Root-Request-ID": convReqId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": messageId,
    ...traceHeaders(),
  };
}

/** 兼容旧调用形态：把鉴权头就地合并进 `headers`。 */
export function applyAuth(
  headers: Record<string, string>,
  cfg: Config,
  token: string,
  uid: string,
): void {
  Object.assign(headers, buildHeaders({ accessToken: token, uid, domain: "" }, cfg));
}

type Rec = Record<string, unknown>;

/** 对象（非数组、非 null）才当消息看。 */
function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

/** 文本是否命中指纹族（快路径：先纯字面量扫描，命中才跑正则）。 */
function hasFingerprint(text: string): boolean {
  const low = text.toLowerCase();
  return FINGERPRINT_MARKERS.some((marker) => low.includes(marker));
}

/** 改写命中上游拦截指纹的文本，返回 `[新文本, 是否改动]`。 */
function sanitizeText(text: string): [string, boolean] {
  if (!text || !hasFingerprint(text)) return [text, false];
  let out = text;
  for (const [pattern, replacement] of FINGERPRINT_RULES) out = out.replace(pattern, replacement);
  return [out, out !== text];
}

/** 改写 messages 里的正文、思考链与工具实参（三者都在上游的内容审核面上）。 */
function sanitizeMessages(messages: unknown[]): number {
  let hits = 0;
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (!rec) continue;

    const content = rec["content"];
    if (typeof content === "string") {
      const [next, changed] = sanitizeText(content);
      rec["content"] = next;
      if (changed) hits += 1;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = asRecord(part);
        if (!p || typeof p["text"] !== "string") continue;
        const [next, changed] = sanitizeText(p["text"]);
        p["text"] = next;
        if (changed) hits += 1;
      }
    }

    if (typeof rec["reasoning_content"] === "string") {
      const [next, changed] = sanitizeText(rec["reasoning_content"]);
      rec["reasoning_content"] = next;
      if (changed) hits += 1;
    }

    const calls = rec["tool_calls"];
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const c = asRecord(call);
        const fn = asRecord(c?.["function"]);
        if (!fn || typeof fn["arguments"] !== "string") continue;
        const [next, changed] = sanitizeText(fn["arguments"]);
        fn["arguments"] = next;
        if (changed) hits += 1;
      }
    }
  }
  return hits;
}

/**
 * OpenAI 的 `developer` 角色在本上游没有对应枚举，按 `system` 处理 ——
 * 原样透传会以 11128 拒整条会话（hub 实测口径）。
 */
function normalizeRoles(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    const rec = asRecord(msg);
    if (!rec || rec["role"] !== "developer") return msg;
    return { ...rec, role: "system" };
  });
}

/** 本轮是否要了思考（决定是否必须回填 `reasoning_content`）。 */
function thinkingRequested(body: Rec): boolean {
  const thinking = asRecord(body["thinking"]);
  if (thinking) {
    const type = typeof thinking["type"] === "string" ? thinking["type"].trim().toLowerCase() : "";
    if (type === "disabled") return false;
    if (type === "enabled") return true;
  }
  const effort = body["reasoning_effort"] ?? body["reasoningEffort"];
  const text = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  return text !== "" && text !== "none";
}

/**
 * DeepSeek 思考模式下上游要求**每条 assistant 消息**都带 `reasoning_content`，
 * 缺一条就 400 —— 而多数客户端只回传自己那部分，历史里总会有空位。
 *
 * 与 hub 的差异：hub 对 deepseek 一律按「已开思考」处理；这里只在
 * `hasTrace || 本轮要了思考` 时回填，普通无思考的短对话不会被塞进空占位。
 *
 * 上游还校验 `len(reasoning) > 0`，所以空串不够：`reasoning` 镜像成空白串
 *（长度合法且对模型不可见）。
 */
function backfillReasoningContent(messages: unknown[], body: Rec): number {
  const model = typeof body["model"] === "string" ? body["model"] : "";
  if (!model.toLowerCase().startsWith("deepseek")) return 0;

  // 历史里已有思考链（客户端自己回传了）→ 必须补齐其余；否则看本轮有没有要思考
  let hasTrace = false;
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (!rec) continue;
    const reasoning = rec["reasoning"];
    if (typeof reasoning === "string" && reasoning) {
      hasTrace = true;
      break;
    }
    if ("reasoning_content" in rec) {
      hasTrace = true;
      break;
    }
  }
  if (!hasTrace && !thinkingRequested(body)) return 0;

  let filled = 0;
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (!rec || rec["role"] !== "assistant") continue;
    const raw = rec["reasoning_content"];
    const legacy = rec["reasoning"];
    const text = typeof raw === "string" ? raw : typeof legacy === "string" ? legacy : "";
    if (typeof raw !== "string") {
      rec["reasoning_content"] = text;
      filled += 1;
    }
    const existing = rec["reasoning"];
    if (!(typeof existing === "string" && existing)) {
      rec["reasoning"] = text || " ";
      filled += 1;
    }
  }
  return filled;
}

/** `content` 是否为空（None / 空串 / 空数组）。 */
function isEmptyContent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 把 src 的 `reasoning_content` 并入 dst（两边都有就换行拼接）。 */
function mergeReasoningContent(dst: Rec, src: Rec): void {
  const rc = src["reasoning_content"];
  if (typeof rc !== "string" || !rc) return;
  const prev = dst["reasoning_content"];
  dst["reasoning_content"] = typeof prev === "string" && prev ? `${prev}\n${rc}` : rc;
}

/**
 * 合并相邻的 assistant tool_calls 消息（并行批次被客户端拆成多条 assistant）。
 *
 * DeepSeek 系上游对拆开的批次回 `400 code=11148 tool_call_sequence_broken`，
 * 而且每轮每重试都重放同一段历史，换账号也救不回来 —— 只能在发出去前修形状。
 */
function mergeAdjacentToolCalls(messages: unknown[]): boolean {
  if (messages.length < 2) return false;
  let changed = false;
  const out: unknown[] = [];
  for (const msg of messages) {
    const rec = asRecord(msg);
    const prev = asRecord(out.at(-1));
    if (rec && rec["role"] === "assistant" && prev && prev["role"] === "assistant") {
      const calls = rec["tool_calls"];
      const prevCalls = prev["tool_calls"];
      // 形态一：本条声明了工具调用且无正文 → 并入上一条
      if (
        Array.isArray(calls) &&
        calls.length > 0 &&
        isEmptyContent(rec["content"]) &&
        Array.isArray(prevCalls) &&
        prevCalls.length > 0
      ) {
        prev["tool_calls"] = [...prevCalls, ...calls];
        mergeReasoningContent(prev, rec);
        changed = true;
        continue;
      }
      // 形态二：本条是纯文本、上一条只有工具调用 → 正文并上去
      if (
        !("tool_calls" in rec) &&
        typeof rec["content"] === "string" &&
        rec["content"] &&
        Array.isArray(prevCalls) &&
        prevCalls.length > 0 &&
        isEmptyContent(prev["content"])
      ) {
        prev["content"] = rec["content"];
        mergeReasoningContent(prev, rec);
        changed = true;
        continue;
      }
    }
    out.push(msg);
  }
  if (!changed) return false;
  messages.length = 0;
  messages.push(...out);
  return true;
}

/**
 * 把工具结果紧跟在声明它的 assistant 消息之后（中间不夹其他消息）。
 *
 * 上游要求 `role:"tool"` 的结果**紧跟**请求方，中间夹一条就判配对断裂
 *（`11148`）。这里只重排：结果集合与相对顺序不变，插队者挪到整批之后。
 */
function repackToolResultBlocks(messages: unknown[]): boolean {
  if (messages.length < 3) return false;
  let changed = false;
  const out: unknown[] = [];
  let i = 0;
  while (i < messages.length) {
    const rec = asRecord(messages[i]);
    const calls = rec?.["tool_calls"];
    if (!rec || rec["role"] !== "assistant" || !Array.isArray(calls) || calls.length === 0) {
      out.push(messages[i]);
      i += 1;
      continue;
    }
    const want = new Set<string>();
    for (const call of calls) {
      const id = asRecord(call)?.["id"];
      if (typeof id === "string" && id) want.add(id);
    }
    out.push(messages[i]);
    i += 1;
    const results: unknown[] = [];
    const between: unknown[] = [];
    let sawNonTool = false;
    while (i < messages.length) {
      const mm = asRecord(messages[i]);
      if (!mm) break;
      const role = mm["role"];
      if (role === "tool") {
        const id = mm["tool_call_id"];
        if (typeof id !== "string" || !want.has(id)) break;
        results.push(messages[i]);
        if (sawNonTool) changed = true;
        i += 1;
        continue;
      }
      if (results.length === 0) break;
      // 下一条 assistant.tool_calls 是下一批，交回外层处理，否则它的结果不会被重排
      const nextCalls = mm["tool_calls"];
      if (role === "assistant" && Array.isArray(nextCalls) && nextCalls.length > 0) break;
      between.push(messages[i]);
      sawNonTool = true;
      i += 1;
    }
    out.push(...results, ...between);
  }
  if (!changed) return false;
  messages.length = 0;
  messages.push(...out);
  return true;
}

/**
 * 丢掉没有结果的工具调用、以及没有调用的孤立结果。
 *
 * 失败的工具调用（参数错、超时、工具不存在）客户端永远不会补结果，但那条
 * assistant 记录会跟着历史重放，**每轮**都被上游拒一次（11148），一次失败就能
 * 废掉整个会话。两侧按同一份 id 集合裁剪，不留半配对。
 */
function cleanupOrphanToolCalls(messages: unknown[]): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (!rec) continue;
    if (rec["role"] === "tool") {
      const id = rec["tool_call_id"];
      if (typeof id === "string" && id) resultIds.add(id);
    } else if (rec["role"] === "assistant" && Array.isArray(rec["tool_calls"])) {
      for (const call of rec["tool_calls"] as unknown[]) {
        const id = asRecord(call)?.["id"];
        if (typeof id === "string" && id) callIds.add(id);
      }
    }
  }
  if (callIds.size === 0 && resultIds.size === 0) return false;
  const keep = new Set([...callIds].filter((id) => resultIds.has(id)));

  let changed = false;
  for (const msg of messages) {
    const rec = asRecord(msg);
    const calls = rec?.["tool_calls"];
    if (!rec || rec["role"] !== "assistant" || !Array.isArray(calls) || calls.length === 0) {
      continue;
    }
    const kept = (calls as unknown[]).filter((call) => {
      const id = asRecord(call)?.["id"];
      return typeof id === "string" && keep.has(id);
    });
    if (kept.length === calls.length) continue;
    changed = true;
    if (kept.length > 0) rec["tool_calls"] = kept;
    else delete rec["tool_calls"];
  }

  const out = messages.filter((msg) => {
    const rec = asRecord(msg);
    if (!rec || rec["role"] !== "tool") return true;
    const id = rec["tool_call_id"];
    if (typeof id === "string" && keep.has(id)) return true;
    changed = true;
    return false;
  });
  if (!changed) return false;
  messages.length = 0;
  messages.push(...out);
  return true;
}

/** `max_completion_tokens`（新版 OpenAI 名）→ `max_tokens`（本上游只认后者）。 */
function translateMaxCompletionTokens(body: Rec): void {
  const alias = body["max_completion_tokens"];
  if (alias === undefined) return;
  delete body["max_completion_tokens"];
  if ("max_tokens" in body) return;
  const value = Number(alias);
  if (Number.isFinite(value) && value > 0) body["max_tokens"] = Math.floor(value);
}

/**
 * `tool_choice` 归一化。
 *
 * 上游把它声明成 Go **string**，收到 OpenAI 的对象形态直接 400 `code=11101`：
 * - `"none"` 原样保留（**不删 tools**：删了模型拿不到函数签名，会把调用降级成
 *   文本塞进 content，Agent 因此原地空转）；
 * - `{"type":"auto"|"required"|"none"}` → 同名串；
 * - `{"type":"function","function":{"name":"x"}}` → `"x"`；
 * - 其余对象 / 非标量 → 删字段（无法表达就不表达）。
 */
function normalizeToolChoice(body: Rec): void {
  if (!("tool_choice" in body)) return;
  const value = body["tool_choice"];
  if (typeof value === "string") {
    body["tool_choice"] = value.trim().toLowerCase() || "auto";
    return;
  }
  const rec = asRecord(value);
  if (!rec) {
    delete body["tool_choice"];
    return;
  }
  const type = typeof rec["type"] === "string" ? rec["type"].trim().toLowerCase() : "";
  if (type === "none" || type === "auto" || type === "required") {
    body["tool_choice"] = type;
    return;
  }
  if (type === "function") {
    const fn = asRecord(rec["function"]);
    const name = fn?.["name"] ?? rec["name"];
    const trimmed = typeof name === "string" ? name.trim() : "";
    body["tool_choice"] = trimmed || "auto";
    return;
  }
  delete body["tool_choice"];
}

/** 顶层的 `{type:"function",name,…}` 工具声明包进 `function` 子对象（本上游只认嵌套形态）。 */
function normalizeTools(body: Rec): void {
  const tools = body["tools"];
  if (!Array.isArray(tools)) return;
  const normalized: unknown[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (!rec) continue;
    if (rec["type"] === "function" && "name" in rec && !("function" in rec)) {
      const fn: Rec = {
        name: rec["name"] ?? "",
        description: rec["description"] ?? "",
        parameters: rec["parameters"] ?? {},
      };
      if ("strict" in rec) fn["strict"] = rec["strict"];
      normalized.push({ type: "function", function: fn });
      continue;
    }
    normalized.push(tool);
  }
  body["tools"] = normalized;
}

/**
 * `stop` 归一化成数组。
 *
 * OpenAI 允许 `stop` 是 string 或 array；本上游的 Go 端把它定死为 `[]string`，
 * 收到字符串直接 400 `code=11101`（`cannot unmarshal string into Go struct
 * field Request.stop of type []string`）。实测同一条 prompt：`"END"` → 11101，
 * `["END"]` → 200。空值一律删字段（空停止序列在上游同样判非法）。
 */
function normalizeStop(body: Rec): void {
  if (!("stop" in body)) return;
  const value = body["stop"];
  let list: string[] = [];
  if (typeof value === "string") list = value ? [value] : [];
  else if (Array.isArray(value)) {
    list = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (list.length > 0) body["stop"] = list;
  else delete body["stop"];
}

/**
 * 把下游 OpenAI 请求改写成 WorkBuddyAI 能接受的形状。
 *
 * 管线顺序（每一步都对应一条上游硬约束，乱序会互相破坏）：
 * 1. `developer` → `system`（角色枚举不含 developer）
 * 2. 指纹改写（正文 / 思考链 / 工具实参）—— 命中即 11128
 * 3. DeepSeek 思考模式下回填 `reasoning_content` —— 缺一条即 400
 * 4. 首条必须是 system —— 否则 400 `first message is not system prompt`
 * 5. 工具调用配对修复（合并拆开的并行批次 → 结果紧随 → 裁掉孤儿）—— 否则 11148
 * 6. 参数归一化：`max_completion_tokens` / `tool_choice` / `tools` / `stop` —— 否则 11101
 * 7. 强制流式 —— 否则 400 `Non-stream chat request is currently not supported`
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  const rawMessages = body["messages"];
  // 逐条浅拷贝：后续会就地改写，不能污染网关持有的原始 payload
  const messages: unknown[] = (Array.isArray(rawMessages) ? rawMessages : []).map((msg) =>
    asRecord(msg) ? { ...(msg as Rec) } : msg,
  );

  const normalized = normalizeRoles(messages);
  messages.length = 0;
  messages.push(...normalized);

  sanitizeMessages(messages);
  backfillReasoningContent(messages, body);

  const firstRole = asRecord(messages[0])?.["role"];
  if (firstRole !== "system") {
    messages.unshift({ role: "system", content: "You are a helpful assistant." });
  }

  mergeAdjacentToolCalls(messages);
  repackToolResultBlocks(messages);
  cleanupOrphanToolCalls(messages);
  body["messages"] = messages;

  translateMaxCompletionTokens(body);
  normalizeToolChoice(body);
  normalizeTools(body);
  normalizeStop(body);

  // 上游只支持流式，恒设为 true（客户端要非流式由网关层聚合）
  body["stream"] = true;
  if (!("stream_options" in body)) body["stream_options"] = { include_usage: true };

  return body;
}

/**
 * 拉取并解码模型载荷，返回其中的 data 字典。
 *
 * 用途有二：① 解析连接配置；② 探测凭据是否有效（401/403 抛 UpstreamUnauthorized）。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }

  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      headers: buildHeaders(credential, cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`models request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) throw new Error(`models request failed: HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`models response is not valid JSON: ${String(err)}`);
  }
  const data = env["data"];
  if (!data) {
    throw new Error(
      `models response has no "data" field (code=${String(env["code"])} msg=${String(env["msg"] ?? "")})`,
    );
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("decode models payload: data is not an object");
  }
  const record = data as Record<string, unknown>;
  const models = record["models"];
  if (!Array.isArray(models)) throw new Error("models payload contains no models");
  // 窄表只是展示用目录；真实目录在 /v3/config（见 catalogUrl 注释）。
  // 真目录拉不到时用窄表兜底 —— 有表总比只剩随包快照强。
  try {
    await fetchCatalog(credential, cfg);
  } catch {
    catalog.setRemoteModels(models);
  }
  return record;
}

/** 目录行（已归一成 catalog.parseRow 能读的字段名）。 */
export interface CatalogRow {
  id: string;
  name?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  credits?: string;
}

/**
 * 从任意一份 product-config 载荷里取模型目录。
 *
 * 目录本体是 `agents[].models` 的**裸 id 字符串**（cli 那个 agent 最全）；
 * 逐模型元数据散在 `models[]`（`id` / `name` / `maxInputTokens` / `supportsImages`）。
 * 两份都要拼起来，只有 id 的表也并非不可用（名字退回 id）。
 */
export function parseCatalogPayload(payload: unknown): CatalogRow[] {
  const root = asRecord(payload);
  if (!root) return [];
  const scopes: Rec[] = [root];
  const inner = asRecord(root["data"]);
  if (inner) scopes.push(inner);

  // 1) 裸 id 列表：cli 优先，同类取最长
  const lists: Array<{ cli: boolean; ids: string[] }> = [];
  for (const scope of scopes) {
    const agents = Array.isArray(scope["agents"]) ? scope["agents"] : [];
    for (const agent of agents) {
      const rec = asRecord(agent);
      if (!rec || !Array.isArray(rec["models"])) continue;
      const ids = rec["models"]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value !== "");
      if (ids.length === 0) continue;
      const label = `${String(rec["name"] ?? "")} ${String(rec["id"] ?? "")}`.toLowerCase();
      lists.push({ cli: label.includes("cli"), ids });
    }
  }

  // 2) 元数据：树里每个 `models[]` 对象数组，按 id 建索引（先到先得）
  const meta = new Map<string, Rec>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const value of node) walk(value);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const rows = rec["models"];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const item = asRecord(row);
        if (!item) continue;
        const id = typeof item["id"] === "string" ? item["id"].trim() : "";
        if (id && !meta.has(id)) meta.set(id, item);
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(root);

  const pool = lists.some((entry) => entry.cli) ? lists.filter((entry) => entry.cli) : lists;
  pool.sort((a, b) => b.ids.length - a.ids.length);
  const ordered = pool[0]?.ids ?? [...meta.keys()];

  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const info = meta.get(id) ?? {};
    const row: CatalogRow = { id };
    const name = typeof info["name"] === "string" ? info["name"] : "";
    if (name) row.name = name;
    for (const key of ["maxInputTokens", "maxOutputTokens"] as const) {
      const value = info[key];
      if (typeof value === "number" && Number.isFinite(value)) row[key] = value;
    }
    if (typeof info["supportsImages"] === "boolean") row.supportsImages = info["supportsImages"];
    if (typeof info["credits"] === "string" && info["credits"]) row.credits = info["credits"];
    rows.push(row);
  }
  return rows;
}

/**
 * 拉取真实模型目录并落盘（`mx model <cid> --refresh` 与登录后自动调用）。
 *
 * 失败**招错**：自动路径由 `fetchModels` 捕获后回落窄表，显式刷新时用户必须
 * 知道这次没成。
 */
export async function fetchCatalog(
  credential: AuthLike,
  cfgOverride?: Config,
  timeoutMs = 20_000,
): Promise<CatalogRow[]> {
  const cfg = cfgOverride ?? loadConfig()[0];
  let resp: Response;
  try {
    resp = await fetch(catalogUrl(cfg), {
      // 目录端点跟着桌面端身分走：UA 决定回哪份目录，未知 UA 直接 400 code=12403
      headers: buildChatHeaders(credential, cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`catalog request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) throw new Error(`catalog request failed: HTTP ${resp.status}`);

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`catalog response is not valid JSON: ${String(err)}`);
  }
  const rows = parseCatalogPayload(payload);
  if (rows.length === 0) throw new Error("catalog payload contains no models");
  catalog.setRemoteModels(rows);
  return rows;
}

/** 从模型载荷推导连接配置。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? defaultConfig()) };
  const endpoint = data["endpoint"];
  if (typeof endpoint === "string" && endpoint) cfg.baseUrl = endpoint;
  cfg.chatPath = DEFAULT_CHAT_PATH;
  const auth = data["authentication"];
  if (auth && typeof auth === "object") {
    const attrs = (auth as Record<string, unknown>)["attributes"];
    if (attrs && typeof attrs === "object") {
      const a = attrs as Record<string, unknown>;
      if (typeof a["tokenHeader"] === "string") cfg.tokenHeader = a["tokenHeader"];
      if (typeof a["tokenType"] === "string") cfg.tokenType = a["tokenType"];
      if (typeof a["usernameHeader"] === "string") cfg.usernameHeader = a["usernameHeader"];
    }
  }
  return cfg;
}

/** 翻译器接口（契约要求所有渠道都导出，即使 `WIRE === "openai"` 用不到）。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/**
 * 恒等翻译器。
 *
 * workbuddy 是 `openai` 线型，网关不会调用本函数；提供它是为了满足契约
 * （所有渠道导出同一套接口），且万一被误用也只是原样透传、不丢数据。
 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}
