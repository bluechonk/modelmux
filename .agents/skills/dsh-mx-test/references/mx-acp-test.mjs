// 干什么：用 ACP 协议驱动 dsh（DeepSeek Harness）对 modelmux 网关做端到端测试。
//   流程：spawn `dsh --profile acp` → initialize → session/new（固定 cwd）
//         → session/prompt（发任务）→ 收敛 session/update → session/close。
// 怎么跑：从仓库根执行
//   node .agents/skills/dsh-mx-test/references/mx-acp-test.mjs "<任务文本>" [--model <deepseek 模型名>] [--cwd <目录>] [--timeout <毫秒>]
//   overlay **每次都现生成**（默认 deepseek-v4.1-flash）；**不按渠道选模型** ——
//   网关只对外暴露 deepseek 家族裸名，落点渠道由网关按账号池剩余额度自动挑。
//   环境变量：MODELMUX_API_KEY 必须非空（网关不校验，占位 test 即可）；
//             DSH_ACP_CMD 可覆盖启动命令（覆盖后按 `<cmd> --profile acp --patch <overlay>` 调用，
//             命令需自行包好 Electron 与 cli.js；默认用 DeepSeek Harness.exe + cli.js 直调，
//             Git Bash 里别用 dsh.cmd——引号会被吃）。
// 依赖什么：无 npm 依赖；ACP 用 ndjson over stdio（newline-delimited JSON-RPC）；
//   生成的临时 overlay 落 <仓库根>/.tmp/dsh-mx-overlays/generated-acp-overlay.yml。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const taskParts = [];
let cwd = resolve(".tmp/dsh-acp-e2e");
let timeoutMs = 180000; // 默认与 SKILL.md 示例一致：慢上游单轮可超 90s，120s 太紧
let model = "deepseek-v4.1-flash"; // 网关对外只做 deepseek 家族裸名
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cwd") cwd = resolve(args[++i]);
  else if (args[i] === "--timeout") timeoutMs = Number(args[++i]);
  else if (args[i] === "--model") model = args[++i];
  else taskParts.push(args[i]);
}
const task = taskParts.join(" ").trim();
if (!task) {
  console.error("usage: node mx-acp-test.mjs \"<任务>\" [--model <deepseek 模型名>] [--cwd <dir>] [--timeout ms]");
  process.exit(1);
}

const OVERLAY_DIR = resolve(".tmp/dsh-mx-overlays");
mkdirSync(OVERLAY_DIR, { recursive: true });
const OVERLAY = join(OVERLAY_DIR, "generated-acp-overlay.yml");
{
  // 模型条目省略 contextWindow，走路由级 defaultContextWindow 兜底（llm-pi-ai 契约）
  writeFileSync(OVERLAY, `# 由 mx-acp-test.mjs 生成：acp 路由 → ${model}
- id: llm-pi-ai
  config:
    providers:
      modelmux:
        displayName: modelmux
        apiKeyEnv: MODELMUX_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:4412/v1
        defaultContextWindow: 1000000
        retryPolicy:
          mode: normal
          maxRetries: 3
          retryableCodes:
            - SERVER
            - TIMEOUT
            - TRANSPORT
          backoff:
            initialDelayMs: 1000
            maxDelayMs: 10000
            jitterRatio: 0.2
        models:
          - id: ${model}
            name: ${model}
            input:
              - text
- id: acp
  config:
    provider: modelmux
    model: ${model}
`, "utf8");
}
console.log(`[harness] overlay generated for ${model}`);

// 桌面版路径从 LOCALAPPDATA 推导（换机 / 换用户不坏）；DSH_ACP_CMD 覆盖为已包好的启动命令
const DSH_ROOT = join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness");
const DSH_EXE = join(DSH_ROOT, "DeepSeek Harness.exe");
const CLI_JS = join(DSH_ROOT, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");

// ── ACP ndjson 帧协议 ──
let nextId = 1;
const pending = new Map(); // id → {resolve, reject}

function send(method, params) {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(line + "\n");
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

let buffer = "";
let updates = [];
function onData(chunk) {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    } else if (msg.method !== undefined && msg.id !== undefined) {
      // 服务端反向请求：session/request_permission 自动放行第一个选项；未知方法回 -32601 防挂起
      const respond = (result) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      if (msg.method === "session/request_permission") {
        const opt = msg.params?.options?.[0];
        respond({ outcome: { outcome: opt ? "selected" : "cancelled", ...(opt ? { optionId: opt.optionId } : {}) } });
      } else {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } }) + "\n");
      }
    } else if (msg.method === "session/update") {
      updates.push(msg.params);
    }
  }
}

// ── 启动 dsh acp 服务器 ──
mkdirSync(cwd, { recursive: true });
console.log(`[harness] spawning dsh --profile acp (overlay: ${OVERLAY})`);
const customCmd = process.env.DSH_ACP_CMD;
const child = spawn(customCmd ?? DSH_EXE, customCmd
  ? ["--profile", "acp", "--patch", OVERLAY]
  : ["--expose-internals", CLI_JS, "--profile", "acp", "--patch", OVERLAY], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MODELMUX_API_KEY: process.env.MODELMUX_API_KEY ?? "test" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", onData);
child.stderr.on("data", (d) => {
  const s = d.toString();
  // Electron 缓存噪音过滤，其余透传（诊断用）
  if (!/cache_util_win|disk_cache|Gpu Cache/.test(s)) process.stderr.write(`[dsh] ${s}`);
});

let exited = null;
child.on("exit", (code) => {
  exited = code;
  for (const p of pending.values()) p.rej(new Error(`dsh exited (${code})`));
  pending.clear();
});

const timeout = setTimeout(() => {
  console.error(`[harness] timeout after ${timeoutMs}ms`);
  child.kill();
}, timeoutMs);

try {
  // 1) initialize
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  console.log(`[harness] initialized, protocolVersion=${init.protocolVersion} agentCapabilities=${JSON.stringify(init.agentCapabilities ?? {})}`);

  // 2) session/new（固定 cwd）；configOptions.currentValue 直接印出本会话固定到哪个模型
  const sess = await send("session/new", { cwd, mcpServers: [] });
  const sessionId = sess.sessionId;
  console.log(`[harness] session=${sessionId}`);
  if (sess.configOptions) {
    for (const co of sess.configOptions) {
      console.log(`[harness] configOptions: ${JSON.stringify(co).slice(0, 400)}`);
    }
  } else {
    console.log(`[harness] configOptions absent: ${JSON.stringify(sess).slice(0, 300)}`);
  }

  // 3) prompt + 等收敛
  updates = [];
  console.log(`[harness] prompting: ${task.slice(0, 80)}`);
  const promptPromise = send("session/prompt", { sessionId, prompt: [{ type: "text", text: task }] });

  const result = await Promise.race([
    promptPromise.catch((e) => ({ error: String(e) })),
    new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
  ]);
  if (result?.timeout) console.error("[harness] prompt did not settle before timeout");
  else if (result?.error) console.error(`[harness] prompt error: ${result.error}`);
  else console.log(`[harness] prompt settled: stopReason=${result?.stopReason}`);

  // 4) 输出收集到的助手文本与工具调用统计
  let text = "";
  const kinds = {};
  for (const u of updates) {
    const upd = u.update ?? u;
    const k = upd.sessionUpdate ?? "raw";
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (upd.sessionUpdate === "agent_message_chunk" && upd.content?.type === "text") text += upd.content.text;
  }
  console.log("=== 助手回复 ===");
  console.log(text.trim() || "(空)");
  console.log("=== updates 统计 ===");
  console.log(JSON.stringify(kinds));

  // 5) 关会话
  await send("session/close", { sessionId }).catch((e) => console.error(`close: ${e.message}`));
  console.log("[harness] session closed");
} catch (error) {
  console.error(`[harness] FAILED: ${error.message}`);
} finally {
  clearTimeout(timeout);
  child.kill();
  setTimeout(() => process.exit(0), 500);
}
