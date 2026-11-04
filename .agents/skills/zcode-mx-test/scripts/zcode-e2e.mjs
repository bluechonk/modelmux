// 干什么：zcode app-server 端到端测试底座 —— 建会话 → setModel(按会话选 modelmux 模型) →
//        （工具模式再 setMode yolo）→ 发任务 → 等回合结束 → 核对落盘，末尾打一行 RESULT JSON 供脚本汇总。
// 怎么跑：node scripts/zcode-e2e.mjs <cid>/<模型> [--level <档位>] [--smoke] [--timeout <秒>] [--workspace <目录>]
//        --smoke 只跑单轮文本回复（最省）；默认跑多步工具任务（写文件/读回/bash）。
//        档位缺省时自动选：优先 disabled，其次 low，再取模型档位表第一项（成本最省口径）。
// 依赖什么：node >=18；modelmux 网关 127.0.0.1:4412；目标模型已在 zcode 供应商清单里；
//          网关侧证据用 mx log / mx bill 另行核对；工具模式产物落 .tmp/zcode-e2e/<cid>/。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// ---- 参数 ----
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const has = (name) => args.includes(name);
const modelId = args.find((a) => !a.startsWith("--"));
if (!modelId || !modelId.includes("/")) {
  console.error("用法: node scripts/zcode-e2e.mjs <cid>/<模型> [--level <档位>] [--smoke] [--timeout <秒>] [--workspace <目录>]");
  process.exit(2);
}
const cid = modelId.split("/")[0];
const smoke = has("--smoke");
const timeoutSec = Number(flag("--timeout") ?? (smoke ? 180 : 600));
const ZC = path.join(process.env.LOCALAPPDATA, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
if (!fs.existsSync(ZC)) {
  console.error(`找不到 zcode.cjs: ${ZC}`);
  process.exit(2);
}
// 工作区默认落仓库 .tmp/zcode-e2e/<cid>/（从仓库任意位置跑都对：用脚本自身定位仓库根）
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
const workspace = flag("--workspace") ?? path.join(repoRoot, ".tmp", "zcode-e2e", cid);
fs.mkdirSync(workspace, { recursive: true });

console.log(`== 目标: model=${modelId} 模式=${smoke ? "smoke" : "tool"} 超时=${timeoutSec}s 工作区=${workspace}`);

// ---- app-server 进程与协议 ----
const child = spawn(process.execPath, [ZC, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 100;
const pending = new Map();
let sessionId = null;
let lifecycleState = null;
let status = null;
let textBuf = "";
let modelRequestCount = 0;
let levels = null; // setModel 后 state.updated 带出的档位表
let turnEnd = null;
const NOISE = new Set(["process/mcpTelemetry", "process/resourceSample", "process/mcpResourceSamples", "computer-use/operation-event"]);

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (NOISE.has(msg.method)) continue;
    if (msg.method === "session/lifecycle/changed") {
      if (msg.params?.sessionId) sessionId = msg.params.sessionId;
      lifecycleState = msg.params?.state ?? lifecycleState;
      if (msg.params?.lastError) console.log("  [lifecycle错误]", JSON.stringify(msg.params.lastError).slice(0, 300));
      continue;
    }
    if (msg.method === "state.updated") {
      const p = msg.params?.patch ?? {};
      if (p.status) {
        status = p.status;
        if (status === "idle" && turnEnd) { turnEnd(); turnEnd = null; }
      }
      const avail = p.model?.available;
      if (Array.isArray(avail)) {
        const hit = avail.find((m) => m.ref?.modelId === modelId);
        if (hit?.reasoning?.levels) levels = hit.reasoning.levels.map((l) => l.value ?? l);
      }
      continue;
    }
    if (msg.method === "v4/telemetry/event") {
      const k = msg.params?.kind;
      if (k === "model.request.status" && msg.params?.status === "model_request_started") modelRequestCount++;
      if (k === "stream.chunk" && msg.params?.channel === "text")
        textBuf += typeof msg.params.chunk === "string" ? msg.params.chunk : "?";
      if ((k === "turn.completed" || k === "turn.failed") && turnEnd) {
        console.log(`  [telemetry] ${k}`);
        turnEnd(); turnEnd = null;
      }
      continue;
    }
    // 服务端反向请求：requestRuntimePreferences 用服务端回退形状应答；其余回空 result
    if (msg.id !== undefined && msg.method) {
      const result = msg.method === "session/requestRuntimePreferences"
        ? {
            askUserQuestionAutoResolutionEnabled: true,
            memoryEnabled: false,
            modelContextBudgetStrategy: "preflight-v1",
            nativeSearchEnhancementsEnabled: true,
            toolSearchMode: "off",
          }
        : {};
      child.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
      continue;
    }
    if (msg.id !== undefined && (msg.error || msg.result !== undefined)) {
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); continue; }
    }
  }
});
child.stderr.on("data", (d) => console.log("  [stderr]", d.toString().trim().slice(0, 200)));

// ---- 会话库（结束判据的权威路）：事件流的结束信号形态多样，last_outcome 由运行时直接写库最可靠 ----
const dbPath = path.join(process.env.USERPROFILE ?? os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const waitOutcome = (sid, timeoutMs) =>
  new Promise((resolve) => {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return resolve(null); }
    const t0 = Date.now();
    const timer = setInterval(() => {
      try {
        const row = db.prepare("SELECT last_outcome FROM session WHERE id=?").get(sid);
        if (row?.last_outcome) { clearInterval(timer); db.close(); resolve(row.last_outcome); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); db.close(); resolve(null); }
      } catch { /* WAL 偶发忙，继续轮询 */ }
    }, 2000);
  });
const lastAssistantText = (sid) => {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT data FROM part WHERE session_id=? ORDER BY rowid DESC LIMIT 30").all(sid);
    db.close();
    for (const r of rows) {
      try { const j = JSON.parse(r.data); if (j.type === "text") return j.text; } catch {}
    }
  } catch { /* 库不可读时放弃文本证据 */ }
  return null;
};

const call = (method, params, timeoutMs = 120000) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, timeoutMs);
  });

const waitLifecycle = (want, timeoutMs) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (want.includes(lifecycleState) || Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(lifecycleState);
      }
    }, 250);
  });

const t0 = Date.now();
const result = {
  ok: false, model: modelId, mode: smoke ? "smoke" : "tool", sessionId: null,
  level: null, modelRequestCount: 0, textTail: null, fileOk: null, fileContent: null,
  outcome: "unknown", elapsedMs: 0,
};

try {
  // 1. 建会话（不带 model：档位校验在 ensureReady，先到 ready 再 setModel）
  call("session/create", { workspace: { workspacePath: workspace, workspaceKey: workspace } });
  const st = await waitLifecycle(["ready", "stopping", "unloaded", "faulted"], 120000);
  result.sessionId = sessionId;
  if (st !== "ready" || !sessionId) {
    result.outcome = `lifecycle=${st}`;
    throw new Error("会话未就绪");
  }
  console.log(`  [会话] ${sessionId} ready`);

  // 2. setModel（档位：显式 > 候选探测。服务端校验档位是本地操作，探测零网关成本；
  //    档位表只在 setModel 成功后的 state.updated 里广播，失败路径拿不到，所以不能依赖它）
  let level = flag("--level");
  const setModel = async (lv) =>
    call("session/setModel", {
      sessionId,
      model: { providerId: "new-provider", modelId, ...(lv ? { options: { reasoningLevel: lv } } : {}) },
    }, 30000);
  const LEVEL_CANDIDATES = ["disabled", "low", "high", "medium", "auto", "enabled", "off", "max", "standard", "minimal", "none"];
  let sm = level ? await setModel(level) : await setModel(undefined);
  if (sm.error && /Reasoning level/i.test(String(sm.error.message))) {
    for (const cand of LEVEL_CANDIDATES) {
      sm = await setModel(cand);
      if (!sm.error && !sm.timeout) { level = cand; break; }
      if (/not supported/i.test(String(sm.error?.message))) continue; // 该档位不合法，试下一个
      break; // 其它错误（网络/参数）不值得继续探测
    }
    if (sm.error || sm.timeout) throw new Error("全部候选档位均被拒绝: " + JSON.stringify(sm.error ?? "timeout").slice(0, 160));
    console.log(`  [档位] 探测命中 ${level}`);
  }
  if (sm.error || sm.timeout) throw new Error("setModel 失败: " + JSON.stringify(sm.error ?? "timeout").slice(0, 200));
  result.level = level ?? "(供应商默认)";
  result.levelsAvailable = levels; // setModel 成功后 state.updated 广播的完整档位表（如可用）
  console.log(`  [setModel] 成功 档位=${result.level}`);

  // 3. 工具模式切 yolo（build 会卡权限；smoke 不发工具可省）
  if (!smoke) {
    const smode = await call("session/setMode", { sessionId, mode: "yolo" }, 15000);
    if (smode.error || smode.timeout) throw new Error("setMode yolo 失败");
    console.log("  [setMode] yolo");
  }

  // 4. 发任务
  const sentinel = path.join(workspace, `${cid}-e2e.txt`);
  const content = smoke
    ? "Reply with exactly: OK"
    : `在当前目录创建 ${cid}-e2e.txt，写入内容 ${modelId.split("/")[1]} ok；然后读取该文件确认内容；再用 bash 执行 pwd 和 ls；最后用一句话总结你执行了哪些操作。`;
  const done = new Promise((r) => { turnEnd = r; });
  const sent = await call("session/send", { sessionId, content }, 30000);
  if (sent.error || sent.timeout) throw new Error("session/send 失败: " + JSON.stringify(sent.error ?? "timeout").slice(0, 150));
  console.log("  [send] accepted");

  const outcome = await Promise.race([
    done.then(() => "completed"),
    waitOutcome(sessionId, timeoutSec * 1000).then((v) => (v ? `db:${v}` : null)),
    new Promise((r) => setTimeout(() => r("timeout"), timeoutSec * 1000)),
  ]);
  result.outcome = outcome ?? "timeout";
  result.modelRequestCount = modelRequestCount;
  const dbText = lastAssistantText(sessionId);
  result.textTail = (dbText ?? textBuf ?? "").slice(-120) || null;
  console.log(`  [回合] ${result.outcome} 模型请求=${modelRequestCount} 次 回复=${JSON.stringify(result.textTail)}`);

  // 5. 工具模式核对落盘
  if (!smoke) {
    try {
      result.fileContent = fs.readFileSync(sentinel, "utf8").trim();
      result.fileOk = result.fileContent === `${modelId.split("/")[1]} ok`;
    } catch {
      result.fileOk = false;
    }
  }
  const completed = result.outcome === "completed" || result.outcome.startsWith("db:");
  result.ok = smoke
    ? completed && /OK/.test(result.textTail ?? "")
    : completed && result.fileOk === true;
} catch (e) {
  result.error = String(e.message ?? e).slice(0, 300);
} finally {
  result.elapsedMs = Date.now() - t0;
  console.log("RESULT " + JSON.stringify(result));
  setTimeout(() => { child.kill(); process.exit(result.ok ? 0 : 1); }, 2000);
}
