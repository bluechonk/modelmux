/**
 * WorkBuddy（国内版）上游：端点、请求头、请求体改写。
 *
 * 关键约束（端点/字段/实测见 docs/channels/workbuddy/PROTOCOL.md）：
 *   - `buildChatBody()` 承担全部渠道特有改写；上游全部拒收原因（首条消息、仅流式、指纹、Go 原生类型、工具配对、思考模式字段）都实现在此。
 *   - `buildChatHeaders()` 按官方身分头族补齐，缺任一员整条会话会被拒。
 *   - chat 路径刻意不用 `prefixPath`（该前缀不可用）；通用 OpenAI 形状修复已下沉共享层 `http/openai-normalize.ts`。
 */

import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

import { upstreamPath, ensureDir, openaiNormalize, writeJsonFile, type QuotaSignal } from "@modelmux/gateway";

import * as catalog from "./catalog.js";

// chat 上游按 PROTOCOL §1 是 copilot.tencent.com；www.codebuddy.ai 是 DNS 沉洞（实测打不开），
// www.codebuddy.cn 只做计费域与前台 Origin。
export const DEFAULT_BASE_URL = "https://copilot.tencent.com";

/** 国内版桌面端身分取值（5.5.6；无对应抓包，维持参考实现原值）。 */
const DESKTOP_UA_CN = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
const DESKTOP_IDE_VERSION_CN = "5.5.6";
/** 国内版前台域（对话请求的 Origin/Referer；chat 上游仍是 copilot.tencent.com）。 */
const FRONT_DOMAIN_CN = "https://www.codebuddy.cn";

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
export const DISPLAY_NAME = "WorkBuddy";

/**
 * 上游线型：`openai` 表示上游就是标准 OpenAI SSE delta，网关只需规范化透传。
 *
 * workbuddy 属于 `openai`；网关因此不会调用 `newTranslator()`，
 * 但本模块仍导出它（契约要求所有渠道导出同一套接口）。
 */
export const WIRE: "openai" | "custom" = "openai";

/** 已验证的 chat-completions 路由（见文件头注释）。 */
const DEFAULT_CHAT_PATH = "/v2/chat/completions";

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

// ── 上游业务错误分类 ────────────────────────────────────────────────────────────

/**
 * 上游业务错误的**处置类别**。
 *
 * 码表来自官方客户端 `app.asar` 里提取的 `ServerErrorCode` 枚举，分类口径按
 * 「语义具体优先」分层（秒/分/时级限流是账号级、日额度是账号×模型级、
 * 模型缺服务是确定性不可用）。
 *
 * `[参考]` 码表与分层表：`reference/xiaofan6ya_workbuddy2api/docs/protocol-reference.md:1904-1952`
 * （码表）、`:1869-1889`（分层表）。本表只抄「码 → 语义 → 处置」的对应关系。
 */
type UpstreamErrorKind =
  /** 该后端无此模型（确定性）→ 换模型 */
  | "model_block"
  /** 模型级日额度 / 模型繁忙 → 换模型或换号 */
  | "model_rate"
  /** 模型排队 → 等上游给的 retry_after */
  | "model_queue"
  /** 秒/分/时级限流 → 换号即可 */
  | "soft_rate"
  /** 额度用尽（个人/企业/腾讯侧）→ 换号或等次日重置 */
  | "hard_credit"
  /** 账号级授权 / 风控限制 → 换号 */
  | "account_fault"
  /** 会话被上游删除 → 需重登 */
  | "session_dead"
  /** 模型行为策略拒绝 → 透传给客户端 */
  | "model_behavior"
  /** 上下文超长 → 透传给客户端 */
  | "context_too_long"
  /** 上游 5xx → 可退避重试 */
  | "server"
  /** 404 */
  | "not_found"
  /** 其余 4xx（含 11128 指纹、11101 参数、11148 工具配对）→ 不可重试 */
  | "client";

/**
 * 业务码 → 处置类别。
 *
 * ⚠ 这些码**不总是配 429**：上游会把限流包在 HTTP 200 或 400 里返回，只看状态码
 * 的实现会把它落到「不可重试」（`[参考]` hub docs/protocol-reference.md:1949-1952）。
 */
const BUSINESS_CODE_KINDS: Record<number, UpstreamErrorKind> = {
  // 限流码族 6000-6008：6004/6008 是「每天」额度（客户端当日额度、不重试）
  6000: "soft_rate",
  6001: "soft_rate",
  6002: "soft_rate",
  6003: "soft_rate",
  6004: "model_rate",
  6005: "soft_rate",
  6006: "soft_rate",
  6007: "soft_rate",
  6008: "model_rate",
  // 排队（模型级，附 retry_after）
  6020: "model_queue",
  6021: "model_queue",
  6022: "model_queue",
  // 额度 / 授权
  14001: "hard_credit",
  14003: "model_rate",
  14012: "hard_credit",
  14013: "hard_credit",
  14014: "hard_credit",
  14015: "account_fault",
  14016: "account_fault",
  14017: "account_fault",
  14018: "hard_credit",
  14019: "hard_credit",
  // 模型 / 账号 / 会话
  11102: "model_block",
  11115: "context_too_long",
  11140: "account_fault",
  11141: "model_behavior",
  11142: "account_fault",
  12153: "session_dead",
};

/** 各类别的处置建议。 */
interface KindDisposition {
  /** 换模型即可解（该模型对这个账号不可用）。 */
  rotateModel: boolean;
  /** 换号即可解（账号级问题）。 */
  rotateAccount: boolean;
  /** 需要重新登录（上游已删除该会话）。 */
  needsRelogin: boolean;
  /** 瞬时故障，可退避后重试。 */
  retryable: boolean;
}

const KIND_DISPOSITIONS: Record<UpstreamErrorKind, KindDisposition> = {
  model_block: { rotateModel: true, rotateAccount: false, needsRelogin: false, retryable: false },
  model_rate: { rotateModel: true, rotateAccount: true, needsRelogin: false, retryable: false },
  model_queue: { rotateModel: true, rotateAccount: false, needsRelogin: false, retryable: true },
  soft_rate: { rotateModel: false, rotateAccount: true, needsRelogin: false, retryable: true },
  hard_credit: { rotateModel: false, rotateAccount: true, needsRelogin: false, retryable: false },
  account_fault: { rotateModel: false, rotateAccount: true, needsRelogin: false, retryable: false },
  session_dead: { rotateModel: false, rotateAccount: false, needsRelogin: true, retryable: false },
  model_behavior: { rotateModel: false, rotateAccount: false, needsRelogin: false, retryable: false },
  context_too_long: { rotateModel: false, rotateAccount: false, needsRelogin: false, retryable: false },
  server: { rotateModel: false, rotateAccount: false, needsRelogin: false, retryable: true },
  not_found: { rotateModel: false, rotateAccount: false, needsRelogin: false, retryable: false },
  client: { rotateModel: false, rotateAccount: false, needsRelogin: false, retryable: false },
};

/** 会话被上游删除的文案标记（码可能没给，只给了话）。 */
const SESSION_DEAD_MARKERS = ["offline user session not found", "12153"];

/** 额度耗尽的文案标记。 */
const HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "credits exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "积分不足",
  "额度不足",
  "余额不足",
  "积分用完",
  "额度用尽",
  "没有积分",
];

/** 一次上游错误的归一化结论。 */
interface UpstreamErrorInfo {
  kind: UpstreamErrorKind;
  /** 上游业务码（信封里的 code）；取不到为 null。 */
  code: number | null;
  /** 上游给的人话（`displayMsg.zh` 优先，其次 `msg` / `message`）。 */
  message: string;
  /** 上游给出的重置/恢复时刻（毫秒时间戳）；取不到为 null。 */
  resetAtMs: number | null;
  /** 换模型即可解。 */
  rotateModel: boolean;
  /** 换号即可解。 */
  rotateAccount: boolean;
  /** 需要重新登录。 */
  needsRelogin: boolean;
  /** 瞬时故障，可退避后重试。 */
  retryable: boolean;
}

/** 取对象（非数组、非 null）当字典看。 */
function asDict(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 从上游响应体里抽出业务码与人话。
 *
 * 信封形如 `{code, msg, data}`；人话优先取 `displayMsg.zh`（官方给中文提示的字段），
 * 其次 `displayMsg.en` / `msg` / `message` / `error.message`。
 */
function parseUpstreamEnvelope(body: string): { code: number | null; message: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { code: null, message: body.slice(0, 200) };
  }
  const root = asDict(payload);
  if (!root) return { code: null, message: body.slice(0, 200) };

  const errObj = asDict(root["error"]);
  const rawCode = root["code"] ?? errObj?.["code"];
  const code = typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : null;

  const display = asDict(root["displayMsg"]) ?? asDict(errObj?.["displayMsg"]);
  const candidates = [
    display?.["zh"],
    display?.["en"],
    root["msg"],
    root["message"],
    errObj?.["message"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return { code, message: candidate.trim() };
  }
  return { code, message: "" };
}

/**
 * 限流重置时间：**优先读响应头**（机器契约），其次才看响应体文案。
 *
 * 头序：`Retry-After`（整数秒，最权威；日期形态按官方行为忽略）→
 * `anthropic-ratelimit-unified-reset`（epoch 秒或 HTTP 日期）→
 * `x-ratelimit-reset`（epoch 秒或 HTTP 日期）。
 * `[参考]` hub docs/protocol-reference.md:1891-1902。
 */
function resetAtFromHeaders(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const now = Date.now();
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter.trim(), 10);
    if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
  }
  for (const name of ["anthropic-ratelimit-unified-reset", "x-ratelimit-reset"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const text = raw.trim();
    const epoch = Number.parseInt(text, 10);
    if (Number.isFinite(epoch) && epoch > 0) return epoch * 1000;
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 把上游响应归一化成「类别 + 处置」。
 *
 * 判定顺序：**业务码优先**于状态码 —— 上游的限流/额度码不一定配 429，装在 200
 * 或 400 里返回；只按状态码判会把可换号的失败当成不可重试的客户端错误。
 */
export function classifyUpstreamError(
  status: number,
  body: string,
  headers?: Headers,
): UpstreamErrorInfo {
  const { code, message } = parseUpstreamEnvelope(body);
  // 文案标记只在**抽出来的人话**里找（不扫整段响应体）：长 body 里偶然出现
  // 「12153」不该被判成会话失效。
  const lower = message.toLowerCase();

  let kind: UpstreamErrorKind;
  if (code !== null && BUSINESS_CODE_KINDS[code] !== undefined) {
    kind = BUSINESS_CODE_KINDS[code]!;
  } else if (SESSION_DEAD_MARKERS.some((marker) => lower.includes(marker))) {
    kind = "session_dead";
  } else if (HARD_CREDIT_MARKERS.some((marker) => lower.includes(marker))) {
    kind = "hard_credit";
  } else if (status === 401) {
    kind = "session_dead";
  } else if (status === 403) {
    kind = "account_fault";
  } else if (status === 429) {
    kind = "soft_rate";
  } else if (status === 402 || status === 412) {
    kind = "hard_credit";
  } else if (status === 404) {
    kind = "not_found";
  } else if (status >= 500) {
    kind = "server";
  } else {
    kind = "client";
  }

  const disposition = KIND_DISPOSITIONS[kind];
  return {
    kind,
    code,
    message,
    resetAtMs: resetAtFromHeaders(headers),
    rotateModel: disposition.rotateModel,
    rotateAccount: disposition.rotateAccount,
    needsRelogin: disposition.needsRelogin,
    retryable: disposition.retryable,
  };
}

/**
 * 非标准状态码的鉴权失败判定（共享层钩子 `isAuthFailure`）。
 *
 * 上游删除会话（`12153` / `Offline user session not found`）时可能回 400 而不是
 * 401；归一成鉴权失败后，共享层会先刷新令牌重试一次、再把账号标为不可用 ——
 * 这正是「需要重登」的处置（`[参考]` hub docs/protocol-reference.md:1874、:2270-2300）。
 *
 * ⚠ 只对 4xx 且非 401/403 的响应调用；`11128`（指纹）**不**算鉴权失败 ——
 * 它要靠请求体改写解决，换令牌没用。
 */
export function isAuthFailure(status: number, body: string): boolean {
  return classifyUpstreamError(status, body).needsRelogin;
}

/**
 * 流内排队帧判定（共享层钩子 `isQueueError`）。
 *
 * 上游在 HTTP 200 的流里投一条业务错误帧表示「模型在排队」（码 6020-6022），
 * 帧里带 `retryAfterSeconds`。
 *
 * ⚠ 共享层目前只对 `WIRE === "custom"` 的渠道查这个钩子；本渠道是 `openai` 线型，
 * 故该钩子**当前不会被调用**（保留接口，等共享层放开）。
 */
export function isQueueError(frame: Record<string, unknown>): boolean {
  const errObj = asDict(frame["error"]);
  const rawCode = frame["code"] ?? errObj?.["code"];
  const code = typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : null;
  return code !== null && BUSINESS_CODE_KINDS[code] === "model_queue";
}

/**
 * 声明本渠道的额度信号（`UpstreamModule.quotaSignal`）。
 *
 * 本渠道用量限流回 **HTTP 429 + 业务码 `6004`**，原文（2026-10-24 真机，gateway.log）：
 *
 * ```
 * {"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-24 23:54:22 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"…"}
 * ```
 *
 * 关键语义：上游原文明说「**您也可以切换其他模型继续使用**」—— 这是**模型级**限流，
 * 不是账户级用量限额（国际版 `workbuddyai` 的同码 6004 才是账户级，两渠道行为不同）。
 * 故上报 `model_limit`：共享层只冷却这一个模型，**不连坐账号**。
 * 在此之前共享层靠通用正则命中「频率限制」按账户级处理，把整个账号冷却了 15 小时
 * （2026-10-24 实测），其他本来可用的模型被一起封掉。
 *
 * ⚠ 业务码 `6004` / `6008` 只能出现在**渠道包**里；共享层只认通用措辞
 * （见 `packages/core/gateway/src/http/chat/errors.ts`）。
 */
export function quotaSignal(status: number, body: string): QuotaSignal | null {
  if (status !== 429) return null;
  // 6004/6008 按 PROTOCOL §4.1 是模型级「每天」额度（客户端当日额度）；文案同族即频率限制
  return /600[48]|frequency[_ ]limit|usage[_ ]exceeds|频率限制/i.test(body) ? "model_limit" : null;
}

/**
 * 从上游错误体里认「限流重置时刻」（`UpstreamModule.quotaResetAt`）。
 *
 * **上游把重置时间写在 msg 文本里，不是 JSON 字段**，形状（2026-10-24 国内版真机）：
 *
 * ```
 * "您的使用量已超出频率限制，将在 2026-10-24 23:54:22 UTC+8 重置 …"
 * ```
 *
 * 时间戳是 **body 自己声明的 UTC 偏移**下的墙钟时间，按 UTC 解释成 epoch 后再**减去**
 * 该偏移 —— 直接按本地时区解析会在非 UTC+8 的机器上差几个小时（国际版同族实现
 * `workbuddyai/src/upstream.ts` 的 `quotaResetAt` 有同一结论，解析逻辑与其保持一致）。
 * 认不出返回 `null` —— 共享层回落自己的兜底，绝不编造时间。
 */
export function quotaResetAt(bodySnippet: string): number | null {
  const raw = bodySnippet ?? "";
  if (raw === "") return null;
  // 错误体里的中文 msg 常被转义成 \uXXXX
  const text = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_all: string, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  // 先确认这是「额度/限流」而不是别的 4xx
  if (!/6004|quota|usage|limit|频率|额度|限额|超出/i.test(text)) return null;

  const keyword = /(?:reset at|将在)\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(text);
  const loose = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s*UTC[+-]\d{1,2}/.exec(text);
  const match = keyword ?? loose;
  if (!match) return null;
  const stamp = (match[1] ?? "").replace("T", " ");

  // 偏移：UTC+8 / UTC-5 / UTC+05:30
  const tz = /UTC([+-]\d{1,2})(?::?(\d{2}))?/.exec(text);
  let offsetSeconds = 0;
  if (tz) {
    const hours = Number.parseInt(tz[1] ?? "0", 10);
    const minutes = Number.parseInt(tz[2] ?? "0", 10);
    offsetSeconds = hours * 3600 + (hours >= 0 ? minutes * 60 : -minutes * 60);
  }

  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!parts) return null;
  const utcMs = Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6]),
  );
  if (!Number.isFinite(utcMs)) return null;
  return utcMs - offsetSeconds * 1000;
}

/** 描述如何到达 WorkBuddy（国内版）chat 端点。JSON 字段名与 Go 版一致。 */
export interface Config {
  baseUrl: string;
  chatPath: string;
  tokenHeader: string;
  tokenType: string;
  usernameHeader: string;
  /**
   * 设备风控 token（`X-Device-Token`）。
   *
   * 腾讯 T-Sec TuringShield 原生 SDK 采集硬件指纹后换取的不透明串，**纯 HTTP 侧
   * 无法复刻**（`[参考]` hub docs/protocol-reference.md:2328-2351）。官方自身
   * 「拿不到就降级不带」，故缺失不算异常。手工填入 `upstream.json` 即可启用。
   */
  deviceToken: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明这几个字段而不是 import `cred.Credentials` —— 那会形成
 * upstream ↔ cred 的循环依赖。
 */
interface AuthLike {
  accessToken: string;
  uid: string;
  domain: string;
  /** 企业 ID（账号档案端点给）；空 = 个人账号。 */
  enterpriseId?: string;
  /** 昵称（账号档案端点给）；仅展示用。 */
  nickname?: string;
}

/**
 * 上游安全策略按**指纹片段**拦截整条请求：命中即 400
 * `code=11128 Illegal API invocation from an unapproved channel`。
 *
 * 触发物是「各家 CLI 的身份署名 + 计费标记」的特征片段，不是整段样板 ——
 * 故改写必须把**片段本身**换掉：只替换片段里的一段文字、保留特征前缀
 * （如 `Main branch (` 原样留着）等于没改。规则按 hub 的 `wb_proxy.py`
 * （SANITIZE_FEATURES / SANITIZE_REWRITES，实测口径）补齐整族。
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
    // Codex 身份句：**匹配串不带结尾标点**。CLI 版以句号收尾，桌面版
    // （claude-desktop-3p / Agent SDK）以逗号接后继内容 —— 带句号的整句只匹配
    // 前者，桌面版会漏网、指纹原样发上游 → 400 code=11128。替换串同样不带标点，
    // 让原文的标点原样保留（go internal/upstream/sanitize.go:42-49）。
    /You are a coding agent running in the Codex CLI, a terminal-based coding assistant/gi,
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant",
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
    deviceToken: "",
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
    deviceToken: typeof parsed.deviceToken === "string" ? parsed.deviceToken : "",
  };
  // `www.codebuddy.ai` 的 DNS 已沉洞（实测解析到 0.0.0.1）：配置里读到该域名
  // 一律归一到国内版 chat 上游（下次 saveConfig 落盘纠正）
  if (hostOf(cfg.baseUrl) === "www.codebuddy.ai") cfg.baseUrl = DEFAULT_BASE_URL;
  return [cfg, true];
}

/** 持久化上游描述符（临时文件 + 原子替换，避免半截文件）。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureSlash(value: string): string {
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * 端点与常量（显式化）。
 *
 * 国内版（`copilot.tencent.com`）与国际版（`www.workbuddy.ai`）**共用同一套路径**，
 * 只有 host 不同。下表逐条给出「方法 + 完整 URL + 端点路径 + query/body 来源」：
 *
 * | 用途 | 方法 | 完整 URL（国内版） | query / body |
 * | --- | --- | --- | --- |
 * | chat（流式） | POST | `https://copilot.tencent.com/v2/chat/completions` | 无 query；body 由 `buildChatBody` 归一化 |
 * | 真目录 | GET | `https://copilot.tencent.com/v3/config` | 无 query |
 * | 窄表（企业） | GET | `https://copilot.tencent.com/v2/enterprises/personal/models`（兜底 `/console/…`） | 无 query |
 * | 令牌刷新 | POST | `https://copilot.tencent.com/v2/plugin/auth/token/refresh` | 无 query；body `{}`；令牌走 `X-Refresh-Token` 头 |
 * | 登录 state | POST | `https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy` | `platform`（见 `cred.ts`） |
 * | 登录轮询 | GET | `https://copilot.tencent.com/v2/plugin/auth/token?state=<state>` | `state` |
 * | 账号档案 | GET | `https://copilot.tencent.com/v2/plugin/login/account?state=<state>` | `state`；带 `Authorization` |
 * | 额度 | POST | `https://copilot.tencent.com/v2/billing/meter/get-user-resource` | 无 query；body 带分页与 `ProductCode` |
 * | 每日签到 | POST | `https://copilot.tencent.com/v2/billing/meter/daily-checkin` | 无 query；body `{}` |
 *
 * ⚠ `/plugin` 前缀**只用于 auth 族**（来自官方 `product.json` 的 `prefixPath`）：
 * chat 路径加它实测 404（见文件头注释）。
 * ⚠ 计费域在参考实现里是**另一个 host**（`www.codebuddy.cn`，go
 * `internal/upstream/client.go:875`）；本渠道实测复用 chat base 可通，**未分离**
 * —— 登记在 `docs/channels/workbuddy/PROTOCOL.md`「已知边界」。
 */

/** 完整限定的 chat-completions URL。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.chatPath);
}

/**
 * 候选模型端点（按序探测）。
 *
 * `HanawaBanana_workbuddy2api` 给 CN 用的是 `/console/enterprises/personal/models`，
 * 但**未带凭证实测**该路径在 copilot.tencent.com 与 www.codebuddy.cn 上都是
 * **302 跳登录页**（浏览器路由），而 `/v2/enterprises/personal/models` 直接返回
 * `401 WWW-Authenticate: Bearer realm="copilot"` —— 那才是 API 路径。
 * 故 `/v2` 优先，`/console` 留作兜底（上游改版时可能反过来）。
 */
const MODELS_PATHS = [
  "/v2/enterprises/personal/models",
  "/console/enterprises/personal/models",
] as const;

/** 候选模型端点完整 URL（按优先级）。 */
function modelsUrls(cfg?: Config): string[] {
  const resolved = cfg ?? loadConfig()[0];
  return MODELS_PATHS.map((path) => trimSlash(resolved.baseUrl) + path);
}

/** 连接配置端点（窄口径：endpoint / authentication / agents）。 */
export function modelsUrl(cfg?: Config): string {
  return modelsUrls(cfg)[0]!;
}

/**
 * 真正的模型目录端点。
 *
 * 窄表（`/console|v2/enterprises/personal/models`）的 `models` 只是前端展示用；
 * 桌面端选择器的目录在 `/v3/config` 的 `agents[].models`（实测国际版 27 条，
 * 含 `deepseek-v4.1-flash`）。参考 `ardeyouxipianyi_workbuddy2api-hub` 的
 * `REMOTE_CONFIG_PATH`：“The narrow endpoint is not the desktop catalogue”。
 */
function catalogUrl(cfg?: Config): string {
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
 *
 * 身份头按官方 CLI 的 `X-No-*` 约定成对出现：某字段没有时用 `X-No-xxx: 1`
 * 代替，**不**两个都发（go `internal/upstream/headers.go:242-255`、
 * dsh `src/upstream.ts:479-483`）。
 */
export function buildHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // 官方桌面端 UA：上游按 UA 归因「使用端」（账单品牌）并参与渠道校验
    "User-Agent": DESKTOP_UA_CN,
  };
  const headerName = resolved.tokenHeader || "Authorization";
  headers[headerName] = `Bearer ${credential.accessToken}`;

  // 账号域：有域发 X-Domain，没域发 X-No-Department-Info（两者互斥）。
  // ⚠ 正常登录的凭据恒带域（`cred.login` 落盘时已兜底成 chat 上游 host），
  // 只有手写的旧凭据才会落到 X-No-Department-Info 分支。
  const domain = credential.domain;
  if (domain) {
    headers["X-Domain"] = domain;
  } else {
    headers["X-No-Department-Info"] = "1";
  }

  // 账号 id：有 uid 发 X-User-Id，没有发 X-No-User-Id（互斥）。
  if (resolved.usernameHeader && credential.uid) {
    headers[resolved.usernameHeader] = credential.uid;
  } else if (resolved.usernameHeader === "X-User-Id") {
    headers["X-No-User-Id"] = "1";
  }

  // 企业身份：`X-Enterprise-Id` 与 `X-User-Id` 必须**成对**出现 ——
  // dsh 实测：/v3/config 上只带 X-User-Id 选不中任何东西、只带 X-Enterprise-Id
  // 被直接拒；企业账号不带这对头会被**静默回个人目录**（18 vs 19 个模型，
  // dsh `reference/dsh-workbuddy-connect/src/upstream.ts:522-532`）。缺企业 id（或缺 uid，成对不成立）时
  // 按官方约定发 X-No-Enterprise-Id。
  if (credential.enterpriseId && credential.uid) {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  } else {
    headers["X-No-Enterprise-Id"] = "1";
  }

  // 设备风控 token：Turing SDK 产出的不透明串，纯 HTTP 侧无法生成；
  // 官方自己「拿不到就降级不带」，故缺失不算异常（hub
  // docs/protocol-reference.md:2342-2345）。填在 `upstream.json` 的
  // `deviceToken` 里即可启用。
  if (resolved.deviceToken) {
    headers["X-Device-Token"] = resolved.deviceToken;
  }

  return headers;
}

/**
 * 对话请求的身分头族：基础头 + X-Agent-* / X-IDE-* / 会话与请求 ID / 链路族
 * （渠道校验要求 X-Conversation-ID 恒发，缺头判非官方拒收）。
 *
 * 会话与请求 ID 是**每轮新生**的（上游不按会话 id 存历史，不需要跨轮一致）；
 * `buildChatBody` 负责请求体的全部硬约束（首条 system / 指纹改写 / 工具配对 /
 * 参数归一化 / 强制流式）。
 */
export function buildChatHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const convReqId = newMessageId();
  const messageId = newMessageId();
  return {
    ...buildHeaders(credential, cfg),
    // 浏览器语义头：渠道校验要求请求「像从官方前端发出」—— Origin/Referer/
    // X-CodeBuddy-Request 缺任一都会 11128（参考 hub 的 account.headers("chat")）
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": FRONT_DOMAIN_CN,
    "Referer": `${FRONT_DOMAIN_CN}/`,
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "zh-CN",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": DESKTOP_IDE_VERSION_CN,
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

type Rec = Record<string, unknown>;

/** 对象（非数组、非 null）才当消息看 —— 实现复用共享层，渠道不再自备副本。 */
const asRecord = openaiNormalize.asRecord;

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

/**
 * 思考链回填只对这一族模型生效。
 *
 * 「哪一族模型要求 assistant 必带 `reasoning_content`」是**渠道协议事实** ——
 * 共享层只提供回填机制，判据（模型名前缀）由本模块传入。
 */
const REASONING_MODEL_PREFIX = "deepseek";

/**
 * 把下游 OpenAI 请求改写成 WorkBuddy（国内版）能接受的形状。
 *
 * 管线顺序（每一步都对应一条上游硬约束，乱序会互相破坏）：
 * 1. `developer` → `system`（角色枚举不含 developer）—— 共享层
 * 2. 指纹改写（正文 / 思考链 / 工具实参）—— 命中即 11128 —— 渠道规则
 * 3. DeepSeek 思考模式下回填 `reasoning_content` —— 缺一条即 400 —— 共享层
 * 4. 首条必须是 system —— 否则 400 `first message is not system prompt` —— 渠道
 * 5. 工具调用配对修复（合并拆开的并行批次 → 结果紧随 → 裁掉孤儿）—— 否则 11148 —— 共享层
 * 6. 参数归一化：`max_completion_tokens` / `tool_choice` / `tools` / `stop` —— 否则 11101 —— 共享层
 * 7. 强制流式 —— 否则 400 `Non-stream chat request is currently not supported` —— 渠道
 *
 * 形状修复本身在共享层 `@modelmux/gateway` 的 `http/openai-normalize.ts`；
 * 本模块只保留渠道特有的判据（指纹规则、模型族、角色枚举、流式要求）。
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

  const normalized = openaiNormalize.normalizeDeveloperRole(messages);
  messages.length = 0;
  messages.push(...normalized);

  openaiNormalize.sanitizeMessageTexts(messages, sanitizeText);
  openaiNormalize.backfillReasoningContent(messages, body, {
    modelPrefix: REASONING_MODEL_PREFIX,
  });

  const firstRole = asRecord(messages[0])?.["role"];
  if (firstRole !== "system") {
    messages.unshift({ role: "system", content: "You are a helpful assistant." });
  }

  openaiNormalize.mergeAdjacentToolCalls(messages);
  openaiNormalize.repackToolResultBlocks(messages);
  openaiNormalize.cleanupOrphanToolCalls(messages);
  body["messages"] = messages;

  openaiNormalize.translateMaxCompletionTokens(body);
  // 上游把 `tool_choice` 声明成 Go string，只认字符串形态（渠道协议事实）
  openaiNormalize.normalizeToolChoice(body, { stringOnly: true });
  openaiNormalize.normalizeTools(body);
  openaiNormalize.normalizeStop(body);

  // 上游只支持流式，恒设为 true（客户端要非流式由网关层聚合）
  body["stream"] = true;
  if (!("stream_options" in body)) body["stream_options"] = { include_usage: true };

  return body;
}

/**
 * 拉取并解码模型载荷，返回其中的 data 字典。
 *
 * 用途有二：① 解析连接配置；② 探测凭据是否有效（401/403 抛 UpstreamUnauthorized）。
 *
 * 目录**并发双探**：真目录（`/v3/config`，主路）+ 企业窄表（次路），两路结果合并
 * 后落盘 —— 口径参考 go `internal/upstream/client.go:1281-1330`（FetchModels 并发探
 * 两端点）与 `:1336-1357`（mergeModelInfos：主路优先、次路只补缺）。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }

  const probe = await probeCatalog(credential, cfg, timeoutMs);
  const merged = mergeCatalogRows(probe.v3Rows, probe.narrowRows);
  if (merged.length === 0) {
    throw new Error(`models request failed: ${probe.errors.join("; ") || "no catalog rows"}`);
  }
  catalog.setRemoteModels(merged);
  // 连接配置（`endpoint` / `authentication`）只在窄表载荷里有；取不到时返回空对象，
  // `resolveConfig` 会保留既有配置。
  return probe.narrowData;
}

/** 目录行（已归一成 catalog.parseRow 能读的字段名）。 */
interface CatalogRow {
  id: string;
  name?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  /**
   * 输入模态数组（如 `["text","image"]`）。
   *
   * ⚠ 上游 `/v3/config` 目前**不下发**这个字段（实测 2026-10-20：`models[]` 只有
   * `supportsImages`）；这里带着是为了上游哪天改用数组形态时不丢字段 ——
   * `catalog.parseRow` 判「能不能吃图」时数组形态优先于布尔开关。
   */
  input_modalities?: string[];
  credits?: string;
}

/** 一次并发双探的结果。 */
interface CatalogProbe {
  /** 真目录（`/v3/config`）解析出的行。 */
  v3Rows: CatalogRow[];
  /** 企业窄表的原始行（未归一，交给 `catalog.parseRow` 解析）。 */
  narrowRows: unknown[];
  /** 窄表载荷的 data 字典（连接配置来源：`endpoint` / `authentication`）。 */
  narrowData: Record<string, unknown>;
  /** 两路各自的失败原因（拼进报错文案）。 */
  errors: string[];
}

/**
 * 并发双探目录：真目录（主路）+ 企业窄表（次路）。
 *
 * 两路**并发**发起（不串行等）：真目录是桌面端选择器那份，窄表是前端展示那份，
 * 各有各的失败模式 —— 串行的话窄表先成功就会把真目录挡在后面。
 * `[参考]` go `internal/upstream/client.go:1281-1330`。
 */
async function probeCatalog(
  credential: AuthLike,
  cfg: Config,
  timeoutMs: number,
): Promise<CatalogProbe> {
  const errors: string[] = [];
  const settle = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      // 鉴权失败要冒泡（共享层据此走刷新链路），其余失败降级成空结果。
      if (err instanceof UpstreamUnauthorized) throw err;
      errors.push(`${label}: ${String(err)}`);
      return fallback;
    }
  };

  const [v3Rows, narrow] = await Promise.all([
    settle<CatalogRow[]>("v3/config", () => probeV3Catalog(credential, cfg, timeoutMs), []),
    settle(
      "models",
      () => probeNarrowModels(credential, cfg, timeoutMs),
      { rows: [] as unknown[], data: {} as Record<string, unknown> },
    ),
  ]);
  return { v3Rows, narrowRows: narrow.rows, narrowData: narrow.data, errors };
}

/** 探真目录：`GET {base}/v3/config`。 */
async function probeV3Catalog(
  credential: AuthLike,
  cfg: Config,
  timeoutMs: number,
): Promise<CatalogRow[]> {
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
  return parseCatalogPayload(payload);
}

/**
 * 探企业窄表：`GET {base}/v2|console/enterprises/personal/models`。
 *
 * 候选路径按序试（`/v2` 优先，`/console` 兜底，理由见 `MODELS_PATHS` 注释）。
 */
async function probeNarrowModels(
  credential: AuthLike,
  cfg: Config,
  timeoutMs: number,
): Promise<{ rows: unknown[]; data: Record<string, unknown> }> {
  let resp: Response | null = null;
  const attempted: string[] = [];
  for (const url of modelsUrls(cfg)) {
    const path = new URL(url).pathname;
    try {
      resp = await fetch(url, {
        headers: buildHeaders(credential, cfg),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`models request failed: ${String(err)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new UpstreamUnauthorized("upstream rejected the access token (HTTP 401/403)");
    }
    if (resp.status === 200) break;
    // 非 200 先记下，试下一个候选（两个端点都可能改版）
    attempted.push(`${path}=${resp.status}`);
    resp = null;
  }
  if (!resp) {
    throw new Error(`models request failed: ${attempted.join(", ")}`);
  }

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
  return { rows: models, data: record };
}

/** 取一行目录条目的 id（窄表用 `slug`，真目录用 `id`）。 */
function catalogRowId(row: unknown): string {
  const rec = asRecord(row);
  if (!rec) return "";
  const slug = rec["slug"];
  if (typeof slug === "string" && slug.trim()) return slug.trim();
  const id = rec["id"];
  return typeof id === "string" ? id.trim() : "";
}

/**
 * 合并两路目录：主路（真目录）在前，次路（企业窄表）只补主路缺的 id。
 *
 * 同 id 以主路为准（真目录带倍率与上下文元数据），输出顺序 = 主路原序 + 次路补充项。
 * `[参考]` go `internal/upstream/client.go:1336-1357`（mergeModelInfos）。
 */
function mergeCatalogRows(primary: unknown[], secondary: unknown[]): unknown[] {
  if (secondary.length === 0) return [...primary];
  const seen = new Set<string>();
  for (const row of primary) {
    const id = catalogRowId(row);
    if (id) seen.add(id);
  }
  const out: unknown[] = [...primary];
  for (const row of secondary) {
    const id = catalogRowId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * 从任意一份 product-config 载荷里取模型目录。
 *
 * **型号集合取 `models[]` 全量**；`agents[].models` 的裸 id 字符串只作**排序基准**
 * （cli 那个 agent 排最前）。逐模型元数据散在 `models[]`（`id` / `name` / `maxInputTokens` /
 * `supportsImages` / `input_modalities`），只有 id 的表也并非不可用（名字退回 id）。
 *
 * 非对话条目（`nes-` / `completion-` / `codewise-` 前缀）在这里挡掉：它们列出来
 * 也选不中，选中后上游回 `code=11102`（`[参考]` go
 * `internal/upstream/client.go:1470-1473`）。
 */
function parseCatalogPayload(payload: unknown): CatalogRow[] {
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
        .filter((value) => value !== "" && catalog.isChatModelId(value));
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
        if (id && catalog.isChatModelId(id) && !meta.has(id)) meta.set(id, item);
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(root);

  const pool = lists.some((entry) => entry.cli) ? lists.filter((entry) => entry.cli) : lists;
  pool.sort((a, b) => b.ids.length - a.ids.length);

  // 排序基准：cli/最长 agent 的裸 id 列表；**型号集合取 `models[]` 全量**。
  // ⚠ agent 列表只能当排序基准，不能当白名单 —— 否则 `models[]` 里不在 agent 列表的型号
  // 会被整条丢掉，让窄表的旧值补位（实测：池内 `kimi-k2.5` 报 164000 而真目录是 256000）。
  const ordered: string[] = [];
  const orderedSeen = new Set<string>();
  for (const id of pool[0]?.ids ?? []) {
    if (orderedSeen.has(id)) continue;
    orderedSeen.add(id);
    ordered.push(id);
  }
  for (const id of meta.keys()) {
    if (orderedSeen.has(id)) continue;
    orderedSeen.add(id);
    ordered.push(id);
  }

  // `ordered` 已去重，逐条建 row
  const rows: CatalogRow[] = [];
  for (const id of ordered) {
    const info = meta.get(id) ?? {};
    const row: CatalogRow = { id };
    const name = typeof info["name"] === "string" ? info["name"] : "";
    if (name) row.name = name;
    for (const key of ["maxInputTokens", "maxOutputTokens"] as const) {
      const value = info[key];
      if (typeof value === "number" && Number.isFinite(value)) row[key] = value;
    }
    if (typeof info["supportsImages"] === "boolean") row.supportsImages = info["supportsImages"];
    const modalities = info["input_modalities"];
    if (Array.isArray(modalities)) {
      row.input_modalities = modalities.filter((v): v is string => typeof v === "string");
    }
    if (typeof info["credits"] === "string" && info["credits"]) row.credits = info["credits"];
    rows.push(row);
  }
  return rows;
}

/**
 * 拉取真实模型目录并落盘（`mx model <cid> --refresh` 与登录后自动调用）。
 *
 * 与 `fetchModels` 同样**并发双探 + 合并**：显式刷新时用户必须看到真目录，
 * 不能只拿到窄表。
 */
export async function fetchCatalog(
  credential: AuthLike,
  cfgOverride?: Config,
  timeoutMs = 20_000,
): Promise<unknown[]> {
  const cfg = cfgOverride ?? loadConfig()[0];
  const probe = await probeCatalog(credential, cfg, timeoutMs);
  const merged = mergeCatalogRows(probe.v3Rows, probe.narrowRows);
  if (merged.length === 0) {
    throw new Error(`catalog request failed: ${probe.errors.join("; ") || "no catalog rows"}`);
  }
  catalog.setRemoteModels(merged);
  return merged;
}

/**
 * 从模型载荷推导连接配置。
 *
 * `deviceToken` 是**客户端级**（机器级）配置：解析连接配置不该把它清掉 ——
 * 共享层登录后调的是 `resolveConfig(data)`（无 fallback），故在此兜底读回磁盘值。
 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? defaultConfig()) };
  if (fallback === undefined && !cfg.deviceToken) {
    cfg.deviceToken = loadConfig()[0].deviceToken;
  }
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
interface StreamTranslator {
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
