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
 * 估算 Anthropic 请求体的 input tokens：
 * system + 全部消息文本 + 工具 schema（Claude Code 的工具定义占大头，不能漏）。
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
    }
  }

  if (Array.isArray(body["tools"])) {
    for (const raw of body["tools"]) {
      if (!raw || typeof raw !== "object") continue;
      const tool = raw as Rec;
      total += estimateTextTokens(`${String(tool["name"] ?? "")} ${String(tool["description"] ?? "")}`);
      if (tool["input_schema"] !== undefined) {
        total += estimateTextTokens(JSON.stringify(tool["input_schema"]));
      }
    }
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
