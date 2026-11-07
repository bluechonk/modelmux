/**
 * 干什么：从 modelmux 的 payload 日志抽取**某次请求的完整上下文**（系统提示词 / 用户消息 /
 *         助手回复 / 工具定义与调用），按客户端形态归一后输出结构化 JSON 或可读文本。
 *
 * 怎么跑：
 *   node .agents/skills/context-capture/scripts/extract-context.mjs --list
 *   node .agents/skills/context-capture/scripts/extract-context.mjs --id req_xxx
 *   node .agents/skills/context-capture/scripts/extract-context.mjs --id req_xxx --phase client --format text
 *   node .agents/skills/context-capture/scripts/extract-context.mjs --latest --model longcat-2.5
 *
 * 依赖：只读 `~/.modelmux/logs/payload/<date>/payload.log*`（网关落盘的原始请求字节）。
 *       不联网、不调网关、不需要网关在跑。
 *
 * 输出：--format json（默认）给结构化对象；--format text 给便于人读的分节文本。
 *       正文按 payload 里的原始字节解码（`bodyB64` 分片可能劈开多字节字符，这里拼齐后一次解码）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { format: "json", list: false, latest: false, phase: undefined, limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--list") out.list = true;
    else if (arg === "--latest") out.latest = true;
    else if (arg === "--id") out.id = next();
    else if (arg === "--date") out.date = next();
    else if (arg === "--model") out.model = next();
    else if (arg === "--cid") out.cid = next();
    else if (arg === "--phase") out.phase = next();
    else if (arg === "--format") out.format = next();
    else if (arg === "--limit") out.limit = Number.parseInt(next(), 10) || 20;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法：
  --list              列出最近有 payload 记录的请求（id / 时间 / 模型 / 渠道 / 相位 / 大小）
  --id <request id>   抽取指定请求的上下文
  --latest            抽取最新一条（可配 --model / --cid / --phase 过滤）
  --date <YYYY-MM-DD> 限定日期（默认扫最近 3 个有日志的日期）
  --phase client|upstream  只看某一侧（client = 客户端原样请求，upstream = 网关发往上游）
  --format json|text  json = 结构化（默认）；text = 分节可读
  --limit <N>         列表最多几条（默认 20）
`);
  process.exit(0);
}

// ── 落点与读取 ────────────────────────────────────────────────────────────────

const root = process.env["MODELMUX_HOME"] ?? join(homedir(), ".modelmux");
const payloadRoot = join(root, "logs", "payload");

/** 有 payload 日志的日期（新的在前）。 */
function payloadDates() {
  if (!existsSync(payloadRoot)) return [];
  return readdirSync(payloadRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * 某天所有 payload 文件（含轮转段），**按时间正序**。
 *
 * 轮转命名是 `payload.log` / `payload.log.1.log` / `payload.log.2.log`……，数字越大越旧；
 * 正序即「旧段在前」，与写入时间一致。
 */
function payloadFiles(date) {
  const dir = join(payloadRoot, date);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((n) => n.startsWith("payload.log"));
  const seqOf = (name) => {
    const m = /\.(\d+)\.log$/.exec(name);
    return m ? Number.parseInt(m[1], 10) : 0;
  };
  // 序号大的更旧 → 降序排即为正序；`payload.log`（序号 0）当前正在写，排最后
  return files.sort((a, b) => seqOf(b) - seqOf(a)).map((n) => join(dir, n));
}

/** 解一条记录的原始字节（三种存储形态都要认）。 */
function bodyOf(record) {
  const chunks = (record.bodyChunks ?? []).map((c) => Buffer.from(c, "base64"));
  const raw = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
  if (raw.length === 0) {
    // 明文形态（< 4KB 且是合法 UTF-8）：老格式直接放 body 字段
    return Buffer.from(String(record.body ?? ""), "utf8");
  }
  try {
    if (record.bodyEnc === "zstd") return zstdDecompressSync(raw);
    if (record.bodyEnc === "gzip") return gunzipSync(raw);
  } catch {
    return raw; // 解压失败别丢数据：原样交出去，由调用方按 base64 观察
  }
  return raw;
}

/** 读某天全部记录（逐行 JSON）。坏行跳过——半行是轮转切断的正常现象。 */
function readRecords(date) {
  const out = [];
  for (const file of payloadFiles(date)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 轮转切断的半行：跳过 */
      }
    }
  }
  return out;
}

// ── 上下文归一 ────────────────────────────────────────────────────────────────

/** 从正文里解出 JSON；解不出返回 null（渠道自定义编码体就落这里）。 */
function parseJsonBody(buf) {
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 内容分片 → 纯文本（多段 content 拼起来；非文本分片只报类型与体积）。 */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const bits = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part;
    if (typeof p["text"] === "string") bits.push(p["text"]);
    else if (p["type"] === "image" || p["type"] === "image_url") {
      const url = p["image_url"] && typeof p["image_url"] === "object" ? p["image_url"]["url"] : p["source"]?.["data"];
      const len = typeof url === "string" ? url.length : 0;
      bits.push(`[图片，约 ${Math.round(len / 1024)} KB]`);
    } else if (typeof p["type"] === "string") bits.push(`[${p["type"]} 片段]`);
  }
  return bits.join("\n");
}

/**
 * 把三种入站协议的请求体归一成同一条消息流。
 *
 * - OpenAI chat：`messages[]`（role / content / tool_calls / tool_call_id）
 * - Anthropic Messages：`system`（可字符串或数组）+ `messages[]`（content 分片数组）
 * - OpenAI Responses：`instructions` + `input[]`（含 `function_call` / `function_call_output`）
 */
function normalizeMessages(body) {
  const messages = [];

  // Anthropic：system 是顶层独立字段
  if (body["system"] !== undefined) {
    const text = contentToText(body["system"]);
    if (text.trim() !== "") messages.push({ role: "system", text, source: "system" });
  }
  // Responses：instructions 是顶层
  if (typeof body["instructions"] === "string" && body["instructions"].trim() !== "") {
    messages.push({ role: "system", text: body["instructions"], source: "instructions" });
  }

  const chatMessages = Array.isArray(body["messages"]) ? body["messages"] : [];
  for (const raw of chatMessages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw;
    const role = typeof m["role"] === "string" ? m["role"] : "unknown";
    const text = contentToText(m["content"]);
    const entry = { role, text, source: "messages" };
    const calls = Array.isArray(m["tool_calls"]) ? m["tool_calls"] : [];
    if (calls.length > 0) {
      entry.toolCalls = calls.map((c) => ({
        name: c?.["function"]?.["name"] ?? c?.["name"] ?? "",
        arguments: c?.["function"]?.["arguments"] ?? c?.["arguments"] ?? "",
      }));
    }
    if (typeof m["tool_call_id"] === "string") entry.toolCallId = m["tool_call_id"];
    if (typeof m["reasoning_content"] === "string" && m["reasoning_content"] !== "") {
      entry.reasoning = m["reasoning_content"];
    }
    messages.push(entry);
  }

  const input = Array.isArray(body["input"]) ? body["input"] : [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw;
    const type = typeof m["type"] === "string" ? m["type"] : "";
    if (type === "function_call") {
      messages.push({
        role: "assistant",
        text: "",
        source: "input.function_call",
        toolCalls: [{ name: String(m["name"] ?? ""), arguments: String(m["arguments"] ?? "") }],
      });
      continue;
    }
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        text: typeof m["output"] === "string" ? m["output"] : JSON.stringify(m["output"] ?? ""),
        source: "input.function_call_output",
        toolCallId: String(m["call_id"] ?? ""),
      });
      continue;
    }
    const text = contentToText(m["content"]);
    if (text !== "") {
      messages.push({ role: typeof m["role"] === "string" ? m["role"] : "unknown", text, source: "input" });
    }
  }

  return messages;
}

/** 工具定义（chat 的 `tools[].function` / Anthropic 的 `tools[].{name,description,input_schema}` / Responses 的 `tools[]`）。 */
function normalizeTools(body) {
  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const out = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw;
    const fn = t["function"] && typeof t["function"] === "object" ? t["function"] : t;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name === "") continue;
    out.push({
      name,
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      parameters: fn["parameters"] ?? fn["input_schema"] ?? null,
    });
  }
  return out;
}

/** 把一条 payload 记录整理成「客户端上下文」结构。 */
function toContext(record, date) {
  const bytes = bodyOf(record);
  const body = parseJsonBody(bytes);
  const base = {
    requestId: record.id,
    date,
    ts: record.ts,
    phase: record.phase,
    attempt: record.attempt ?? 0,
    cid: record.cid ?? null,
    model: record.model ?? null,
    stream: record.stream === true,
    bytes: record.bytes ?? bytes.length,
    truncated: record.truncated === true,
  };
  if (body === null) {
    return {
      ...base,
      parseFailed: true,
      // 解不开时给原文片段（渠道自定义编码体就是这一种），并明确说「不是 JSON」
      rawPreview: bytes.toString("utf8").slice(0, 2000),
    };
  }
  return {
    ...base,
    parseFailed: false,
    messages: normalizeMessages(body),
    tools: normalizeTools(body),
    systemCount: normalizeMessages(body).filter((m) => m.role === "system").length,
    // 请求体里其它值得记录的标量（不改写，只挑常用的）
    meta: {
      temperature: body["temperature"],
      maxTokens: body["max_tokens"] ?? body["max_completion_tokens"],
      toolChoice: body["tool_choice"],
      reasoningEffort: body["reasoning_effort"] ?? body["reasoning"]?.["effort"],
    },
  };
}

// ── 列表与筛选 ────────────────────────────────────────────────────────────────

function candidateDates() {
  return args.date !== undefined ? [args.date] : payloadDates().slice(0, 3);
}

/** 收集候选记录（新→旧），按过滤条件筛。 */
function collect() {
  const dates = candidateDates();
  const all = [];
  for (const date of dates) {
    for (const rec of readRecords(date)) all.push({ date, rec });
  }
  return all
    .filter(({ rec }) => (args.phase === undefined ? true : rec.phase === args.phase))
    .filter(({ rec }) => (args.model === undefined ? true : String(rec.model ?? "").includes(args.model)))
    .filter(({ rec }) => (args.cid === undefined ? true : rec.cid === args.cid))
    .sort((a, b) => String(b.rec.ts).localeCompare(String(a.rec.ts)));
}

if (args.list) {
  const rows = collect().slice(0, args.limit);
  if (rows.length === 0) {
    console.log(`没有找到 payload 记录（${payloadRoot}）`);
    process.exit(0);
  }
  console.log(`最近 ${rows.length} 条 payload 记录（${payloadRoot}）：\n`);
  for (const { date, rec } of rows) {
    console.log(
      `${rec.ts}  ${String(rec.id).padEnd(24)} ${String(rec.phase).padEnd(8)} ` +
        `${String(rec.cid ?? "-").padEnd(10)} ${String(rec.model ?? "-").padEnd(20)} ${rec.bytes ?? "?"}B  ${date}`,
    );
  }
  process.exit(0);
}

let target = null;
if (args.id !== undefined) {
  target = collect().find(({ rec }) => rec.id === args.id) ?? null;
} else if (args.latest) {
  target = collect()[0] ?? null;
}

if (target === null) {
  console.error(
    args.id !== undefined
      ? `没有找到请求 ${args.id} 的 payload 记录（扫了 ${candidateDates().join(", ") || "无日期"}）`
      : "需要 --id / --latest / --list 之一",
  );
  process.exit(1);
}

const context = toContext(target.rec, target.date);

if (args.format === "json") {
  console.log(JSON.stringify(context, null, 2));
  process.exit(0);
}

// ── 文本形态 ──────────────────────────────────────────────────────────────────

console.log(`请求 ${context.requestId}  ${context.ts}  [${context.phase}]`);
console.log(`模型 ${context.model ?? "-"}  渠道 ${context.cid ?? "-"}  ${context.bytes} 字节  stream=${context.stream}`);
if (context.truncated) console.log("（落盘时已截断：头尾保留、中间省略）");
if (context.parseFailed) {
  console.log("\n正文不是 JSON（渠道自定义编码体），原文前 2000 字符：\n");
  console.log(context.rawPreview);
  process.exit(0);
}

const section = (title) => console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);

const systems = context.messages.filter((m) => m.role === "system");
if (systems.length > 0) {
  section(`系统提示词（${systems.length} 段）`);
  for (const m of systems) {
    console.log(`\n--- [${m.source}] ${m.text.length} 字符 ---`);
    console.log(m.text);
  }
}

if (context.tools.length > 0) {
  section(`工具定义（${context.tools.length} 个）`);
  for (const t of context.tools) {
    console.log(`\n${t.name}${t.description ? ` — ${t.description.slice(0, 200)}` : ""}`);
  }
}

const dialogue = context.messages.filter((m) => m.role !== "system");
if (dialogue.length > 0) {
  section(`对话（${dialogue.length} 条）`);
  for (const [index, m] of dialogue.entries()) {
    const tag = `[${index + 1}] ${m.role}${m.toolCallId ? ` (${m.toolCallId})` : ""}`;
    console.log(`\n--- ${tag} ${m.text.length} 字符 ---`);
    if (m.reasoning) console.log(`[思考] ${m.reasoning.slice(0, 500)}\n`);
    if (m.text) console.log(m.text);
    for (const call of m.toolCalls ?? []) {
      console.log(`[调用 ${call.name}] ${String(call.arguments).slice(0, 300)}`);
    }
  }
}
