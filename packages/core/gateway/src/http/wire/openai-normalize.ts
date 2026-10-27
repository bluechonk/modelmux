/**
 * 通用 OpenAI 请求体归一化：与具体上游无关的形状修复。
 *
 * ## 本模块的边界（铁律）
 *
 * 1. **只放通用 OpenAI 语义**：别名改名、对象形态压平、数组形态规整、
 *    工具调用序列的结构性修复、思考链字段回填。
 * 2. **不许出现渠道知识**：渠道协议事实由调用方以参数传入
 *    （如 `stringOnly` / `modelPrefix` / `mirrorReasoning`），判据留在渠道包里。
 * 3. **就地改写**传入的请求体 / 消息数组（不复制输入），返回值只报告改了什么；
 *    归一化必须**幂等**（同一请求体归一化两次，第二次不再产生改动）。
 */

/** 请求体 / 消息的通用对象形态。 */
export type OpenAiRecord = Record<string, unknown>;

/** 文本改写回调：返回 `[新文本, 是否改动]`。 */
export type TextRewrite = (text: string) => [string, boolean];

/** 对象（非数组、非 null）才当消息看。 */
export function asRecord(value: unknown): OpenAiRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as OpenAiRecord) : null;
}

/**
 * `developer` 角色降级为 `system`。
 *
 * OpenAI 的 `developer` 角色（推理模型引入）在部分兼容端不被识别，原样透传会被拒；
 * 两者语义等价，统一按 `system` 处理。**要不要降级由渠道决定**（判据在渠道侧）。
 */
export function normalizeDeveloperRole(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    const rec = asRecord(msg);
    if (!rec || rec["role"] !== "developer") return msg;
    return { ...rec, role: "system" };
  });
}

/**
 * 改写 messages 里的正文、思考链与工具实参（三者都在内容审核面上）。
 *
 * **改写规则由调用方给出**（各上游的拦截特征不同），本模块只负责遍历与计数。
 * 返回被改写的字段数。
 */
export function sanitizeMessageTexts(messages: unknown[], rewrite: TextRewrite): number {
  let hits = 0;
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (!rec) continue;

    const content = rec["content"];
    if (typeof content === "string") {
      const [next, changed] = rewrite(content);
      rec["content"] = next;
      if (changed) hits += 1;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = asRecord(part);
        if (!p || typeof p["text"] !== "string") continue;
        const [next, changed] = rewrite(p["text"]);
        p["text"] = next;
        if (changed) hits += 1;
      }
    }

    if (typeof rec["reasoning_content"] === "string") {
      const [next, changed] = rewrite(rec["reasoning_content"]);
      rec["reasoning_content"] = next;
      if (changed) hits += 1;
    }

    const calls = rec["tool_calls"];
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const c = asRecord(call);
        const fn = asRecord(c?.["function"]);
        if (!fn || typeof fn["arguments"] !== "string") continue;
        const [next, changed] = rewrite(fn["arguments"]);
        fn["arguments"] = next;
        if (changed) hits += 1;
      }
    }
  }
  return hits;
}

/** 本轮是否要了思考（决定是否必须回填思考链字段）。 */
export function thinkingRequested(body: OpenAiRecord): boolean {
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

/** 回填思考链字段的适用模型（**渠道协议事实，由渠道传入**）。 */
export interface BackfillReasoningOptions {
  /**
   * 只对模型名以该前缀开头的请求回填；空串表示全部模型
   * （判据由渠道自己把关时传空串）。
   *
   * 判据（哪一族模型要求思考链字段）属于渠道协议事实，共享层不认厂商名。
   */
  modelPrefix: string;
  /**
   * 目标端**也认旧字段** `reasoning` 时镜像一份（默认 true）。
   *
   * 只认标准字段 `reasoning_content` 的目标端传 false —— 多写的字段会被上游拒。
   */
  mirrorReasoning?: boolean;
  /**
   * 只有历史里**已经出现过思考链**才回填（默认 false）。
   *
   * 目标端以「会话已有思考链」为要求信号时传 true：此时本轮要思考也不足以触发，
   * 没有链的会话不会被塞进空占位。
   */
  requireExistingTrace?: boolean;
}

/**
 * 会话里是否出现过思考链。
 *
 * 判据：任一消息带 `reasoning_content` 字段，或带非空的 `reasoning` 串。
 */
export function hasReasoningTrace(messages: unknown[]): boolean {
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (!rec) continue;
    const reasoning = rec["reasoning"];
    if (typeof reasoning === "string" && reasoning) return true;
    if ("reasoning_content" in rec) return true;
  }
  return false;
}

/**
 * 回填 assistant 消息的思考链字段。
 *
 * 推理模型要求**每条 assistant 消息**都带思考链字段，缺一条就被拒 ——
 * 而多数客户端只回传自己那部分，历史里总会有空位。
 *
 * 补两处：标准字段 `reasoning_content` 与旧字段 `reasoning`（后者镜像成
 * 非空串 —— 空串长度不合法）。目标端只认标准字段时用 `mirrorReasoning: false`
 * 关闭镜像。
 *
 * 触发条件：已在历史里出现过思考链（客户端自己回传了）时补齐其余；否则只有本轮
 * 要了思考才回填，普通无思考的短对话不会被塞进空占位。目标端以「会话已有思考链」
 * 为唯一要求信号时用 `requireExistingTrace: true` 收紧。
 */
export function backfillReasoningContent(
  messages: unknown[],
  body: OpenAiRecord,
  options: BackfillReasoningOptions,
): number {
  const model = typeof body["model"] === "string" ? body["model"] : "";
  if (!model.toLowerCase().startsWith(options.modelPrefix.toLowerCase())) return 0;

  // 历史里已有思考链（客户端自己回传了）→ 必须补齐其余；否则看本轮有没有要思考
  const hasTrace = hasReasoningTrace(messages);
  if (!hasTrace && (options.requireExistingTrace === true || !thinkingRequested(body))) return 0;

  const mirror = options.mirrorReasoning !== false;
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
    if (!mirror) continue;
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
function mergeReasoningContent(dst: OpenAiRecord, src: OpenAiRecord): void {
  const rc = src["reasoning_content"];
  if (typeof rc !== "string" || !rc) return;
  const prev = dst["reasoning_content"];
  dst["reasoning_content"] = typeof prev === "string" && prev ? `${prev}\n${rc}` : rc;
}

/**
 * 合并相邻的 assistant 工具调用消息（并行批次被客户端拆成多条 assistant）。
 *
 * 拆开的批次会被上游判为工具调用序列断裂，而且每轮每重试都重放同一段历史，
 * 换账号也救不回来 —— 只能在发出去前修形状。
 */
export function mergeAdjacentToolCalls(messages: unknown[]): boolean {
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
 * 上游要求 `role:"tool"` 的结果**紧跟**请求方，中间夹一条就判配对断裂。
 * 这里只重排：结果集合与相对顺序不变，插队者挪到整批之后。
 */
export function repackToolResultBlocks(messages: unknown[]): boolean {
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
 * assistant 记录会跟着历史重放，**每轮**都被上游拒一次，一次失败就能
 * 废掉整个会话。两侧按同一份 id 集合裁剪，不留半配对。
 */
export function cleanupOrphanToolCalls(messages: unknown[]): boolean {
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

/**
 * 丢弃既没有正文也没有工具调用的 assistant 消息。
 *
 * 流式响应可能只产出思考链没有正文（目标端偶发「HTTP 200 但 content 为空」），
 * 客户端把这条「content 为空 + 无 tool_calls」的空壳 assistant 存进会话历史；
 * 下次重放时，对「空正文不带 content 键」的目标端（traecn 的 `toContentBlocks` 删键）
 * 会退化成 `{role:"assistant",reasoning_content:…}` 空壳，上游判 param invalid
 * （实测 traecn 4001：2026-10-23 ZCode 会话 27 次成功后连续 3 次失败，
 * 空壳数与成败零例外相关）。
 *
 * 删除是安全的：空壳不带 tool_calls，不影响工具配对；思考链本就不建议回传
 * 下一轮（OpenAI 规范），丢弃无信息损失。放在归一化管线**最前**跑 ——
 * 删出的相邻 assistant 交给 `mergeAdjacentToolCalls`，且不影响
 * `repackToolResultBlocks` 的配对前提。
 */
export function dropEmptyAssistantMessages(messages: unknown[]): boolean {
  const out = messages.filter((msg) => {
    const rec = asRecord(msg);
    if (!rec || rec["role"] !== "assistant") return true;
    if (!isEmptyContent(rec["content"])) return true;
    const calls = rec["tool_calls"];
    if (Array.isArray(calls) && calls.length > 0) return true;
    return false;
  });
  if (out.length === messages.length) return false;
  messages.length = 0;
  messages.push(...out);
  return true;
}

/** `max_completion_tokens`（新版 OpenAI 名）→ `max_tokens`（旧名，旧端 / 兼容端通用）。 */
export function translateMaxCompletionTokens(body: OpenAiRecord): void {
  const alias = body["max_completion_tokens"];
  if (alias === undefined) return;
  delete body["max_completion_tokens"];
  if ("max_tokens" in body) return;
  const value = Number(alias);
  if (Number.isFinite(value) && value > 0) body["max_tokens"] = Math.floor(value);
}

/** `tool_choice` 归一化的判据（**渠道协议事实，由渠道传入**）。 */
export interface ToolChoiceOptions {
  /**
   * 目标端**只认字符串形态**时，把对象形态压成字符串；
   * 关闭时原样保留（目标端原生支持对象形态）。
   */
  stringOnly: boolean;
}

/**
 * `tool_choice` 归一化。
 *
 * - 字符串：去空白并小写，空串按 `auto`；
 * - `{"type":"auto"|"required"|"none"}` → 同名串；
 * - `{"type":"function","function":{"name":"x"}}` → `"x"`；
 * - 其余对象 / 非标量 → 删字段（无法表达就不表达）。
 *
 * ⚠ `"none"` 原样保留且**不删 tools**：删了模型拿不到函数签名，会把调用降级成
 * 文本塞进 content。
 */
export function normalizeToolChoice(body: OpenAiRecord, options: ToolChoiceOptions): void {
  if (!options.stringOnly) return;
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

/**
 * 工具声明归一成 OpenAI 的嵌套形态（返回**新数组**）。
 *
 * 顶层 `{type:"function",name,…}` → `{type:"function",function:{name,…}}`；
 * 非对象条目丢弃，其余原样保留。
 */
export function normalizeToolList(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const normalized: unknown[] = [];
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (!rec) continue;
    if (rec["type"] === "function" && "name" in rec && !("function" in rec)) {
      const fn: OpenAiRecord = {
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
  return normalized;
}

/**
 * 工具声明归一成 OpenAI 的嵌套形态（就地改 body）。
 *
 * 顶层 `{type:"function",name,…}` → `{type:"function",function:{name,…}}`。
 */
export function normalizeTools(body: OpenAiRecord): void {
  if (!Array.isArray(body["tools"])) return;
  body["tools"] = normalizeToolList(body["tools"]);
}

/**
 * `stop` 归一化成数组。
 *
 * OpenAI 允许 `stop` 是 string 或 array；兼容端普遍只认数组形态，字符串会被拒。
 * 空值一律删字段（空停止序列同样判非法）。
 */
export function normalizeStop(body: OpenAiRecord): void {
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
