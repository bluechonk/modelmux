/**
 * 宽松 JSON 解析：在「正文被分片传输、首屏只拿到前缀」的前提下尽量拆出消息。
 *
 * 上下文弹窗按 64 KiB 分片读取，正文（尤其 qoder / raccoon 这类 MB 级 agent 上下文）
 * 首屏必然是**残缺前缀**，直接 `JSON.parse` 一定失败。若因此整段按原文糊上去，
 * 就丢掉了「逐条消息卡片」的可读性 —— 那才是主人要的（对照图 3 / 图 4）。
 *
 * 本模块只做两件安全的事：
 *   1. 剥信封：`{"messages": [...]}` 之外，值里再藏一层 JSON 字符串的也解开；
 *   2. 容错截断：前缀不完整时，把已完整出现的顶层字段与消息数组抢救出来。
 * 解不出任何消息结构时返回 null，调用方回退原文呈现。
 */

/** 解析结果：顶层对象（含 messages / tools）+ 抢救到的消息数与截断标记。 */
export interface LenientParsed {
  /** 顶层字段（messages / tools / 其余原样） */
  top: Record<string, unknown>;
  /** 是否因截断只拿到部分消息 */
  truncated: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 标准解析优先；失败才走宽松抢救。数组顶层不当对象看。 */
export function parseLenient(text: string): LenientParsed | null {
  if (text === "") return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isObj(value)) return { top: unwrapEnvelope(value), truncated: false };
    if (Array.isArray(value)) return { top: { messages: value }, truncated: false };
  } catch {
    // 截断前缀：下面的宽松扫描专门处理这种情况
  }
  return salvagePartial(text);
}

/**
 * 信封剥离：顶层没有 messages，但某个字符串字段本身就是一层 JSON 对象
 * （`{"payload":"{\"messages\":…}"}`）时，把内层提到顶层。只下钻一层，不递归。
 */
function unwrapEnvelope(top: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(top["messages"])) return top;
  for (const [, v] of Object.entries(top)) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s.startsWith("{")) continue;
    try {
      const inner: unknown = JSON.parse(v);
      if (isObj(inner) && Array.isArray(inner["messages"])) {
        // 内层覆盖外层同名字段（内层才是真正发给上游的 messages/tools）
        return { ...top, ...inner };
      }
    } catch {
      // 该字段不是藏了 JSON 的字符串：继续找下一个
    }
  }
  return top;
}

/**
 * 从截断前缀里抢救：定位 `"messages"` 数组，逐个抽取**完整**的消息对象。
 *
 * 不追求解析整份文档，只要拿到「前缀里已经写全的那几条消息」。计数括号（跳过
 * 字符串内的括号与转义），消息对象闭合就收一条；中途断了就用已收到的部分。
 */
function salvagePartial(text: string): LenientParsed | null {
  const key = text.indexOf('"messages"');
  if (key < 0) return null;
  const arrStart = text.indexOf("[", key + '"messages"'.length);
  if (arrStart < 0) return null;

  const messages: unknown[] = [];
  let i = arrStart + 1;
  let sawCloseBracket = false;
  while (i < text.length) {
    // 跳过数组里对象之间的空白与逗号
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      if (text[i] === "]" && i === arrStart + 1) {
        sawCloseBracket = true;
        break;
      }
      i += 1;
    }
    if (i >= text.length) break;
    if (text[i] === "]") {
      sawCloseBracket = true;
      break;
    }
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    const end = matchBrace(text, i);
    if (end === null) {
      // 最后一个对象没闭合（被截断）：尽力 parse 已到达的部分，失败则丢弃这条
      const partial = coercePartial(text.slice(i));
      if (partial !== null) messages.push(partial);
      break;
    }
    try {
      messages.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      // 理论上完整对象不会 parse 失败；真失败就当截断处理
    }
    i = end + 1;
  }

  if (messages.length === 0) return null;
  const top: Record<string, unknown> = unwrapEnvelope({ messages });
  return { top, truncated: !sawCloseBracket };
}

/** 从 open（指向 `{`）找配对 `}` 的下标；跳过字符串与转义。不平衡返回 null。 */
function matchBrace(s: string, open: number): number | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * 截断对象尽力补全：从末尾向前逐个候选 `}` 截断，补足够 `}` 使括号平衡后尝试解析。
 * 取能成功的最长前缀；全失败返回 null（这条残缺消息直接丢弃，宁可少一条不显示假数据）。
 */
function coercePartial(frag: string): Record<string, unknown> | null {
  // 只在末尾若干字节内找最后一个较完整的字段边界；粗暴截到最后一个 `}` 逐步回退
  let lastBrace = frag.lastIndexOf("}");
  let guard = 0;
  while (lastBrace > 0 && guard < 200) {
    guard += 1;
    const head = frag.slice(0, lastBrace + 1);
    const balanced = balanceBraces(head);
    if (balanced !== null) {
      try {
        const v: unknown = JSON.parse(balanced);
        if (isObj(v)) return v;
      } catch {
        // 继续回退
      }
    }
    lastBrace = frag.lastIndexOf("}", lastBrace - 1);
  }
  return null;
}

/** 补齐未闭合的 `{` / `"` 使片段可解析；无法平衡返回 null。 */
function balanceBraces(head: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const c of head) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  }
  if (depth < 0) return null;
  let out = head;
  if (inStr) out += '"';
  // 末尾可能是 `"key":` 或 `"key": ` 这种悬空，补 null 让它合法
  if (/:\s*$/.test(out)) out += "null";
  else if (/,\s*$/.test(out)) out = out.replace(/,\s*$/, "");
  out += "}".repeat(depth);
  return out;
}
