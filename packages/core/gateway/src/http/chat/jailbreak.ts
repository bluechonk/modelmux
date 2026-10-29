/**
 * `/jailbreak` 上下文裁剪：客户端要求「丢掉前面全部上下文」时的快捷方式（规则见 docs/JAILBREAK.md）。
 *
 * ⚠ 裁剪范围是**整包**：messages 之外，`tools` / `tool_choice` / `functions` / `function_call` /
 *   `parallel_tool_calls` 这些「前置能力声明」一并删除 —— 它们描述的是被丢弃的那段会话能用的
 *   工具，留着会让上游按旧会话的工具面回答（本功能为提示词注入 / 破甲服务）。
 * ⚠ 只在 **user** 消息里找精确小写的 `/jailbreak`；出现多次取**最后一次**；丢弃它之前的一切
 *   （system / assistant / user 一视同仁），只保留标记后面的内容。
 * ⚠ 放在转发层：上下文怎么组装是转发层的职责，各渠道翻译器不该各实现一遍。
 * ⚠ `MODELMUX_JAILBREAK=0` 可整体关闭；网关只监听 127.0.0.1，不构成越权面。
 */

/** 触发标记。精确匹配小写 —— 大小写变体不触发，避免误伤正文里的同形词。 */
export const JAILBREAK_MARKER = "/jailbreak";

/** 触发裁剪时随 messages 一并删除的顶层字段（工具与函数调用声明）。 */
export const JAILBREAK_DROP_FIELDS: ReadonlyArray<string> = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "parallel_tool_calls",
];

export interface JailbreakResult {
  /** 裁剪后的 payload（新对象；未触发时与入参同一引用）。 */
  payload: Record<string, unknown>;
  /** 裁剪后的 messages；未触发时与入参同一引用。 */
  messages: unknown[];
  /** 是否触发。 */
  applied: boolean;
  /** 被丢弃的消息条数（供日志与排查用）。 */
  dropped: number;
  /** 随裁剪删除的顶层字段名。 */
  droppedFields: string[];
  /** 触发标记在哪条消息上（原数组下标）。 */
  at?: number;
}

/** 开关：`MODELMUX_JAILBREAK=0` 关闭，其余（含未设）启用。 */
export function jailbreakEnabled(): boolean {
  return process.env["MODELMUX_JAILBREAK"] !== "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 该消息是否 user 角色。 */
function isUser(message: unknown): boolean {
  return isRecord(message) && message["role"] === "user";
}

/** 取一个 content part 的文本（字符串 part 或对象 part 的 `text` 字段）。 */
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  const text = part["text"];
  return typeof text === "string" ? text : "";
}

/** 把 content 摊平成可读文本（多模态时只取文本部分，与 `role`/`content` 的宽松形态一致）。 */
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partText).join("");
  return "";
}

/** 在 content 里找标记的**最后一次**出现；找不到返回 -1。 */
function lastMarkerOffset(content: unknown): number {
  return flatten(content).lastIndexOf(JAILBREAK_MARKER);
}

/**
 * 剥掉标记及其之前的全部内容，返回新的 content。
 *
 * - 字符串形态：直接切掉前缀并去掉前导空白；
 * - 数组形态：丢掉含标记那个 part **之前**的所有 parts，并把该 part 的文本切掉前缀
 *   （切完为空则不产出这个 part —— 「只保留标记后面的内容」在空的情况下就是没有内容）。
 */
function stripThrough(content: unknown, offset: number): unknown {
  const markerEnd = offset + JAILBREAK_MARKER.length;
  if (typeof content === "string") return content.slice(markerEnd).trimStart();
  if (!Array.isArray(content)) return content;

  const out: unknown[] = [];
  let acc = 0;
  for (const part of content) {
    const text = partText(part);
    const next = acc + text.length;
    if (offset < next) {
      const sliced = text.slice(markerEnd - acc).trimStart();
      if (sliced !== "") {
        out.push(typeof part === "string" ? sliced : { ...(part as Record<string, unknown>), text: sliced });
      }
      return out;
    }
    acc = next;
  }
  return out;
}

/**
 * 应用 `/jailbreak` 裁剪。未触发（没有标记 / 被关闭）时原样返回入参。
 *
 * 只在 user 消息里找；**取最后一次**出现 —— 标记出现多次时以最后一次为准，
 * 之前的（含更早的标记本身）全部丢弃；工具与函数调用声明一并删除。
 */
export function applyJailbreak(
  payload: Record<string, unknown>,
  enabled: boolean = jailbreakEnabled(),
): JailbreakResult {
  const empty: JailbreakResult = { payload, messages: [], applied: false, dropped: 0, droppedFields: [] };
  if (!enabled) return { ...empty, messages: payload["messages"] as unknown[] ?? [] };

  const messagesRaw = payload["messages"];
  const messages = Array.isArray(messagesRaw) ? messagesRaw : [];
  if (messages.length === 0) return { ...empty, messages };

  let hit: { index: number; content: unknown; offset: number } | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isUser(message)) continue;
    const content = (message as Record<string, unknown>)["content"];
    const offset = lastMarkerOffset(content);
    if (offset >= 0) hit = { index: i, content, offset };
  }
  if (hit === null) return { ...empty, messages };

  const stripped = stripThrough(hit.content, hit.offset);
  const head = { ...(messages[hit.index] as Record<string, unknown>), content: stripped };
  const newMessages = [head, ...messages.slice(hit.index + 1)];

  const droppedFields: string[] = [];
  const newPayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "messages") {
      newPayload[key] = newMessages;
      continue;
    }
    if (JAILBREAK_DROP_FIELDS.includes(key)) {
      droppedFields.push(key);
      continue;
    }
    newPayload[key] = value;
  }

  return {
    payload: newPayload,
    messages: newMessages,
    applied: true,
    dropped: hit.index,
    droppedFields,
    at: hit.index,
  };
}
