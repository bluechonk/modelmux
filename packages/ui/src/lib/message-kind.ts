/**
 * 上下文弹窗的**消息分类与正文预处理**（纯逻辑，可单测）。
 *
 * 铁律：不猜内容含义，只按**可验证的形态**分类 —— 分类错了比不分类更糟（读者会以为
 * 那是模型原文）。每条判据都写明它认的是什么形态，不确定的一律按「普通正文」处理。
 */

/** 一条消息在弹窗里的呈现形态。 */
export type MessageKind =
  /** 用户发言（右侧气泡） */
  | "user"
  /** AI 回复（左侧气泡，Markdown 渲染） */
  | "assistant"
  /** 思考过程（AI 的推理链，默认折叠；与 assistant 分开计数与着色） */
  | "thinking"
  /** 工具调用参数 / 工具结果（全宽卡片） */
  | "tool"
  /** 系统提示词、developer 指令、system-reminder 等（全宽，折叠） */
  | "system"
  /** 认不出来（全宽，原样） */
  | "other";

/**
 * 思考内容的**包裹标记**：客户端把推理链塞进正文时用的形态。
 *
 * 实测（2026-11-07）：本机 29 条 payload 里思考走 `reasoning_content` **字段**，
 * 正文包裹标记 0 命中；但不同客户端与网关（Anthropic 的 thinking block、某些客户端
 * 的 `/thinking` 包装）会把推理写进正文，所以两种入口都要认。
 *
 * 开标记要求出现在**行首**（避免正文里提到标签名时误判），闭合标记取**该开标记之后
 * 的第一个**（不要求行尾 —— 包裹段可能在正文中间）。
 */
const THINKING_WRAPPERS: ReadonlyArray<{ open: RegExp; close: RegExp }> = [
  { open: /^[ \t]*<thinking>/im, close: /<\/thinking>/i },
  { open: /^[ \t]*<thought>/im, close: /<\/thought>/i },
  { open: /^[ \t]*\[thinking\]/im, close: /\[\/thinking\]/i },
  { open: /^[ \t]*\/thinking\b/im, close: /\/endthinking/i },
];

/** 退化形态：没有闭合标记、但以 `Thinking:` 开头的整段正文（客户端截断过）。 */
const THINKING_PREFIX = /^\s*(Thinking|思考)\s*[:：]\s*/i;

export interface SplitThinking {
  /** 从正文里剥出的思考段（无包裹标记时为空串）。 */
  thinking: string;
  /** 剩下的正文（剥掉包裹标记后）。 */
  rest: string;
}

/**
 * 把正文里的思考包裹段剥出来。
 *
 * 只认**成对包裹**的形态：正文中间出现 `<thinking>` 字样不改分类（那可能是提示词里
 * 在讨论这个标记本身）。剥不干净就原样返回，不做半截处理。
 */
export function splitThinking(content: string): SplitThinking {
  for (const { open, close } of THINKING_WRAPPERS) {
    const openMatch = open.exec(content);
    if (!openMatch) continue;
    const start = openMatch.index;
    const afterOpen = start + openMatch[0].length;
    // 闭合标记必须在该开标记之后：`close.exec` 从 0 起搜，故在子串里找再补偏移
    const closeMatch = close.exec(content.slice(afterOpen));
    if (!closeMatch) continue;
    const innerEnd = afterOpen + closeMatch.index;
    const restStart = innerEnd + closeMatch[0].length;
    return {
      thinking: content.slice(afterOpen, innerEnd).trim(),
      rest: `${content.slice(0, start)}${content.slice(restStart)}`.trim(),
    };
  }
  // 退化形态：整段都是思考（无闭合标记）—— 只在**确实以标记开头**时认
  if (THINKING_PREFIX.test(content) && content.length > 0) {
    return { thinking: content.replace(THINKING_PREFIX, "").trim(), rest: "" };
  }
  return { thinking: "", rest: content };
}

/** 判定一条消息的呈现形态（`reasoning_content` 字段与正文包裹标记都算思考）。 */
export function classifyMessage(rec: Record<string, unknown>): MessageKind {
  const role = typeof rec["role"] === "string" ? rec["role"].toLowerCase() : "";
  // 工具结果：role=tool / function，或带 tool_call_id
  if (role === "tool" || role === "function" || typeof rec["tool_call_id"] === "string") return "tool";
  if (Array.isArray(rec["tool_calls"]) && (rec["tool_calls"] as unknown[]).length > 0) return "tool";
  // 系统类：system / developer（含 system-reminder 所在的 user 轮，下文单独处理）
  if (role === "system" || role === "developer") return "system";
  if (role === "user") return "user";
  if (role === "assistant") {
    // 只有思考、没有正文与工具调用的 assistant 轮：标成 thinking（否则退化成空 AI 气泡）
    const content = typeof rec["content"] === "string" ? rec["content"] : "";
    const hasReasoning = typeof rec["reasoning_content"] === "string" && rec["reasoning_content"] !== "";
    const { thinking, rest } = splitThinking(content);
    if (hasReasoning || thinking !== "") {
      if (rest === "" && !Array.isArray(rec["tool_calls"])) return "thinking";
    }
    return "assistant";
  }
  return "other";
}

/**
 * 正文是否该按 Markdown 渲染。
 *
 * 判据是**有 md 结构语法**（标题 / 列表 / 表格 / 代码块 / 强调 / 链接）+ 没有过多 XML 标签，
 * 而不是单纯看角色：只对 assistant 渲染会漏掉「思考过程」「工具结果里的文档」这些同样带
 * md 的内容；反过来对所有内容一律渲染又会吃掉 system-reminder 里的 XML 标签。
 *
 * 调用方仍应对 **system 类角色**直接跳过渲染（它们的正文可能是 YAML frontmatter +
 * 工具调用记录，`# 标题` 与 `1. 列表` 在那里是**数据**不是排版）。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text === "" || text.length > 400_000) return false;
  // XML 风味过重（system-reminder / env 块）：渲染会吃掉标签，保真优先
  const xmlTags = (text.match(/<\/?[a-z][a-z0-9_-]*[\s>]/gi) ?? []).length;
  if (xmlTags >= 3) return false;
  const signals = [
    /^#{1,6}\s+\S/m, // 标题
    /^\s*[-*+]\s+\S/m, // 无序列表
    /^\s*\d+[.)]\s+\S/m, // 有序列表
    /^\s*\|.*\|\s*$/m, // 表格行
    /^```/m, // 代码块
    /\*\*[^*\n]+\*\*/, // 粗体
    /\[[^\]\n]+\]\([^)\n]+\)/, // 链接
    /^\s*>\s+\S/m, // 引用
  ];
  const hits = signals.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  // 单条弱信号（一个粗体词）不足以判定；两条以上或命中强结构（标题/代码块/表格）
  const strong = /^#{1,6}\s+\S/m.test(text) || /^```/m.test(text) || /^\s*\|.*\|\s*$/m.test(text);
  return strong || hits >= 2;
}

/**
 * 该消息的正文能否按 Markdown 渲染（角色 + 内容形态双判据）。
 *
 * system / developer 一类**永不渲染**：它们的正文常是 YAML frontmatter（`---`）、
 * 工具调用记录（`Called the Read tool with ...`）与提示词原文 —— 这些里的 `#` / `1.`
 * 是数据不是排版，渲染出来会把原始内容改写成另一回事（保真优先，见 WEB-CONSOLE.md）。
 */
export function shouldRenderMarkdown(kind: MessageKind, text: string): boolean {
  // tool / other 也不渲染：工具结果多为命令输出、JSON、diff —— 渲染器会把 `#` 行当标题、
  // `---` 当分隔线，原始输出被改写成另一回事
  if (kind === "system" || kind === "tool" || kind === "other") return false;
  return looksLikeMarkdown(text);
}

/**
 * 过场内容（不该一进来就铺满屏的东西）的折叠判据。
 *
 * 系统提示词、skills 清单、system-reminder、超长工具输出：这些是**排查时要能查、
 * 阅读时要让路**的内容。默认折叠，标题写出类型与体量，读者按需展开。
 */
export interface CollapseDecision {
  collapse: boolean;
  /** 折叠标题（给人看的一句话）。 */
  label: string;
}

const REMINDER_TAG = /<\s*(system-reminder|env|environment|user-prompt-submit-hook|context)\b/i;

export function collapseDecision(
  kind: MessageKind,
  text: string,
  opts: { threshold?: number } = {},
): CollapseDecision {
  const threshold = opts.threshold ?? 800;
  if (kind === "system") {
    return { collapse: true, label: `系统提示词 · ${text.length} 字符` };
  }
  if (REMINDER_TAG.test(text)) {
    const tag = REMINDER_TAG.exec(text)?.[1] ?? "system-reminder";
    return { collapse: true, label: `${tag} · ${text.length} 字符` };
  }
  if (kind === "thinking" || kind === "tool") {
    return text.length > threshold
      ? { collapse: true, label: `${kind === "thinking" ? "思考过程" : "工具输出"} · ${text.length} 字符` }
      : { collapse: false, label: "" };
  }
  return text.length > threshold * 4
    ? { collapse: true, label: `长正文 · ${text.length} 字符` }
    : { collapse: false, label: "" };
}
