/**
 * /v1/messages/count_tokens 的本地启发式估算（Claude Code 必需端点）。
 *
 * 为什么不转发上游：官方实现要真打一次上游才能数 token，慢且烧钱；
 * Claude Code 只拿它做上下文窗口预估，±20% 的启发式完全够用。
 * 估算口径取 CCR 同款（ascii 词 + CJK×1.15 向上取整，见
 * .tmp/ref/claude-code-router routing/token-estimator.ts）。
 */

type Rec = Record<string, unknown>;

/** 一段文本的估算 token 数：非 CJK 按空白/标点切词，CJK 逐字 ×1.15。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  const nonCjk = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, (ch) => {
    cjk += 1;
    return " ";
  });
  const words = nonCjk.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g)?.length ?? 0;
  return Math.ceil(words + cjk * 1.15);
}

/** 每条消息的结构开销（role/content 包裹的固定成本），经验值。 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 估算请求体的 input tokens：system + 全部消息 + 工具 schema。
 *
 * **必须同时认 Anthropic 原生形态与 OpenAI chat 形态**：本函数的调用点
 * `relay.ts:220` 传进来的是 `translateAnthropicRequest` **翻译后**的 chat payload
 * （`parsed.payload`），不是客户端原始体。只认原生形态会让工具 schema 整段漏算 ——
 * 实测同一请求 2.46x 低估、面板显示 59% 的假余量，客户端因此不触发自动压缩，
 * 一路涨到上游硬顶被 `context length exceeded` 拒掉（2026-11-08 实测 traecn）。
 *
 * 两种形态的差异：
 *   - 工具定义：原生 `tools[].input_schema` ↔ chat `tools[].function.parameters`
 *   - 工具调用：原生 `content[].type="tool_use"` ↔ chat `message.tool_calls[].function.arguments`
 *
 * 对同构字段做了形态探测而非二选一：同一份 body 里两种形态不会并存，
 * 但调用方（含测试）可能直接传原生体，两处都要覆盖。
 */
export function estimateInputTokens(body: Rec): number {
  let total = 0;
  const system = body["system"];
  if (typeof system === "string") total += estimateTextTokens(system);
  else if (Array.isArray(system)) {
    for (const raw of system) {
      if (raw && typeof raw === "object") total += estimateTextTokens(String((raw as Rec)["text"] ?? ""));
    }
  }

  if (Array.isArray(body["messages"])) {
    for (const raw of body["messages"]) {
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Rec;
      total += PER_MESSAGE_OVERHEAD;
      total += estimateMessageContent(message["content"]);
      total += estimateToolCalls(message["tool_calls"]);
    }
  }

  if (Array.isArray(body["tools"])) {
    for (const raw of body["tools"]) {
      if (!raw || typeof raw !== "object") continue;
      const tool = raw as Rec;
      // chat 形态把 name/description/parameters 包在 function 里；原生形态在顶层
      const fn = tool["function"] && typeof tool["function"] === "object" ? (tool["function"] as Rec) : tool;
      total += estimateTextTokens(`${String(fn["name"] ?? "")} ${String(fn["description"] ?? "")}`);
      const schema = fn["input_schema"] ?? fn["parameters"];
      if (schema !== undefined) total += estimateTextTokens(JSON.stringify(schema));
    }
  }
  return total;
}

/** chat 形态的 assistant 工具调用：`tool_calls[].function.{name,arguments}`。 */
function estimateToolCalls(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const fn = (item as Rec)["function"];
    if (!fn || typeof fn !== "object") continue;
    const f = fn as Rec;
    total += estimateTextTokens(String(f["name"] ?? ""));
    total += estimateTextTokens(String(f["arguments"] ?? ""));
  }
  return total;
}

function estimateMessageContent(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Rec;
    switch (block["type"]) {
      case "text":
        total += estimateTextTokens(String(block["text"] ?? ""));
        break;
      case "image":
        // 图按固定开销估（base64 数据不按字符数算 —— 那会是天文数字）
        total += 800;
        break;
      case "tool_use":
        total += estimateTextTokens(String(block["name"] ?? ""));
        total += estimateTextTokens(JSON.stringify(block["input"] ?? {}));
        break;
      case "tool_result":
        total += estimateMessageContent(block["content"]);
        break;
      default:
        break;
    }
  }
  return total;
}
