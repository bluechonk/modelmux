#!/usr/bin/env node
/**
 * ZCode 会话考古：按 session id 还原一个会话做了什么。
 *
 * 只读脚本：不修改任何会话数据。
 *
 * 用法：
 *   node session-digest.mjs --list [--project <path>] [--limit 20]
 *   node session-digest.mjs --summary <session-id>
 *   node session-digest.mjs --tail <session-id> [N]
 *   node session-digest.mjs --tools <session-id>
 *
 * session-id 可带 `session_` / `sess_` 前缀，也可只给 uuid。
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

const zcodeHome = process.env["ZCODE_HOME"] || join(homedir(), ".zcode");
const rolloutDir = join(zcodeHome, "cli", "rollout");
const artifactsDir = join(zcodeHome, "cli", "artifacts");
const tasksDb = join(zcodeHome, "v2", "tasks-index.sqlite");

const args = process.argv.slice(2);
const mode = args[0] || "--help";

/** Node 22+ 才有 node:sqlite；没有时仅失去 --list，其余模式不受影响。 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/** 去掉 `session_` / `sess_` 前缀，返回裸 id。 */
const bareId = (raw) => String(raw || "").replace(/^(session_|sess_)/, "");

/** 本地时间（epoch ms → YYYY-MM-DD HH:mm:ss）。 */
const localTime = (ms) => {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return String(ms ?? "");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 找到某个会话的 model-io 文件（两种命名前缀）。 */
function rolloutFile(id) {
  const bare = bareId(id);
  if (!existsSync(rolloutDir)) return null;
  for (const name of readdirSync(rolloutDir)) {
    if (!name.startsWith("model-io-") || !name.endsWith(".jsonl")) continue;
    if (!name.includes(bare)) continue;
    return join(rolloutDir, name);
  }
  return null;
}

/** 流式遍历记录。 */
async function eachRecord(file, fn) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    fn(o);
  }
}

/** 取请求里最后一条真实用户消息（跳过 system-reminder 注入）。 */
function lastUserText(o) {
  const msgs = o?.request?.body?.messages;
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text || text.startsWith("<system-reminder>")) continue;
    return text;
  }
  return "";
}

const short = (s, n = 160) => String(s || "").replace(/\s+/g, " ").slice(0, n);

function listSessions(project, limit) {
  if (!existsSync(tasksDb) || !DatabaseSync) {
    console.log("未找到 tasks-index.sqlite（或当前 Node 无 node:sqlite）；改列 rollout 文件：");
    for (const name of readdirSync(rolloutDir).filter((n) => n.startsWith("model-io-")).slice(-limit)) {
      const st = statSync(join(rolloutDir, name));
      console.log(`${localTime(st.mtimeMs)}  ${name}`);
    }
    return;
  }
  const db = new DatabaseSync(tasksDb, { readOnly: true });
  const like = project ? `%${project.replace(/\\/g, "/")}%` : "%";
  const rows = db.prepare(
    "SELECT task_id, cli_title, model, cli_last_outcome, cli_updated_at, archived, workspace_path " +
      "FROM tasks WHERE workspace_path LIKE ? ORDER BY cli_updated_at DESC LIMIT ?",
  ).all(like, limit);
  db.close();
  if (rows.length === 0) {
    console.log("没有匹配的会话。");
    return;
  }
  for (const r of rows) {
    console.log(
      [
        r.task_id,
        localTime(r.cli_updated_at),
        r.cli_last_outcome,
        r.archived ? "archived" : "active",
        short(r.model, 40),
        short(r.cli_title, 50),
      ].join("  "),
    );
  }
}

async function summary(id) {
  const file = rolloutFile(id);
  if (!file) {
    console.error(`未找到会话 ${id} 的 model-io 文件（目录 ${rolloutDir}）`);
    process.exit(1);
  }
  const models = new Map();
  const tools = new Map();
  let count = 0;
  let first = "";
  let last = "";
  let lastUser = "";
  let lastFinish = "";
  let lastAt = "";
  let errors = 0;
  const errorSamples = [];

  await eachRecord(file, (o) => {
    count += 1;
    const mid = o?.model?.modelId ?? "?";
    const rec = models.get(mid) ?? { ok: 0, err: 0 };
    if (o.error) {
      rec.err += 1;
      errors += 1;
      if (errorSamples.length < 5) {
        errorSamples.push(`${o.completedAt ?? "?"} [${mid}] ${short(o.error.message, 100)}`);
      }
    } else rec.ok += 1;
    models.set(mid, rec);

    for (const c of o?.response?.toolCalls ?? []) {
      const name = c?.name ?? c?.function?.name ?? "?";
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
    if (!first && o.completedAt) first = o.completedAt;
    if (o.completedAt) lastAt = o.completedAt;
    if (typeof o?.response?.text === "string" && o.response.text.trim()) last = o.response.text;
    if (o?.response?.finishReason) lastFinish = o.response.finishReason;
    const u = lastUserText(o);
    if (u) lastUser = u;
  });

  console.log(`会话 ${bareId(id)}`);
  console.log(`文件 ${file}`);
  console.log(`请求 ${count} 次，时间 ${first || "-"} → ${lastAt || "-"}，错误 ${errors} 条`);
  console.log("模型：" + [...models.entries()].map(([m, r]) => `${m} (ok=${r.ok}, err=${r.err})`).join("；"));
  console.log("工具调用：" + ([...tools.entries()].map(([n, c]) => `${n}×${c}`).join("、") || "无"));
  console.log(`最后一条用户消息：${short(lastUser, 300) || "-"}`);
  console.log(`最后一轮 finishReason：${lastFinish || "-"}`);
  console.log(`最后一条助手回复：${short(last, 500) || "-"}`);
  if (errorSamples.length) {
    console.log("错误样本：");
    for (const e of errorSamples) console.log("  " + e);
  }
}

async function tail(id, n) {
  const file = rolloutFile(id);
  if (!file) {
    console.error(`未找到会话 ${id} 的 model-io 文件`);
    process.exit(1);
  }
  const keep = [];
  await eachRecord(file, (o) => {
    keep.push(o);
    if (keep.length > n) keep.shift();
  });
  for (const o of keep) {
    const msgs = o?.request?.body?.messages ?? [];
    const calls = (o?.response?.toolCalls ?? []).map((c) => c?.name ?? c?.function?.name ?? "?");
    console.log(`\n--- ${o.completedAt ?? "?"} msgs=${msgs.length} finish=${o.response?.finishReason ?? "-"} ${o.error ? "ERR:" + short(o.error.message, 100) : "OK"}`);
    console.log("用户: " + (short(lastUserText(o), 200) || "-"));
    if (calls.length) console.log("工具: " + calls.join(", "));
    console.log("助手: " + (short(o.response?.text, 300) || "-"));
  }
}

async function toolStats(id) {
  const file = rolloutFile(id);
  if (!file) {
    console.error(`未找到会话 ${id} 的 model-io 文件`);
    process.exit(1);
  }
  const tools = new Map();
  let declared = [];
  await eachRecord(file, (o) => {
    if (declared.length === 0 && Array.isArray(o?.request?.toolNames)) declared = o.request.toolNames;
    for (const c of o?.response?.toolCalls ?? []) {
      const name = c?.name ?? c?.function?.name ?? "?";
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  });
  console.log("客户端声明工具：" + (declared.join(", ") || "-"));
  console.log("实际调用：" + ([...tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join("、") || "无"));
  const art = join(artifactsDir, `${id}`);
  if (existsSync(art)) {
    const files = readdirSync(art).map((f) => ({ f, t: statSync(join(art, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    console.log(`工具产物 ${files.length} 个（最近 5 个）：`);
    for (const { f, t } of files.slice(0, 5)) console.log(`  ${localTime(t)}  ${f}`);
  }
}

switch (mode) {
  case "--list": {
    const pi = args.indexOf("--project");
    const project = pi >= 0 ? args[pi + 1] : "";
    const li = args.indexOf("--limit");
    const limit = li >= 0 ? Number(args[li + 1]) || 20 : 20;
    listSessions(project, limit);
    break;
  }
  case "--summary":
    await summary(args[1]);
    break;
  case "--tail":
    await tail(args[1], Number(args[2]) || 6);
    break;
  case "--tools":
    await toolStats(args[1]);
    break;
  default:
    console.log("用法：");
    console.log("  node session-digest.mjs --list [--project <path>] [--limit 20]");
    console.log("  node session-digest.mjs --summary <session-id>");
    console.log("  node session-digest.mjs --tail <session-id> [N]");
    console.log("  node session-digest.mjs --tools <session-id>");
}
