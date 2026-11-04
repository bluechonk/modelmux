// mx-panel MCP server: 零依赖裸协议实现,给 ZCode 面板提供 modelmux 网关数据。
// 约束:stdout 只出 JSON-RPC(日志一律走 stderr);数据来自本机网关 HTTP API(默认 127.0.0.1:4412,
//       可用 MODELMUX_BASE_URL 覆盖);只读,不碰写接口。
// 协议参考:MCP stdio 规范 + hello-panel 的 ndjson 实现。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(HERE, "ui", "panel.html");
const MX_BASE = process.env.MODELMUX_BASE_URL ?? "http://127.0.0.1:4412";

const SERVER_INFO = { name: "mx-panel", version: "0.3.0" };

// 宿主按 mimeType 的 profile 识别 MCP App(纯 text/html 不建桥,握手必超时)
const HTML_MIME = "text/html;profile=mcp-app";
// frameDomains: 面板要 iframe 内嵌完整控制台(http://127.0.0.1:4412/web/),
// 省略时 CSP frame-src='none' 会直接拦掉嵌套 iframe(官方 schema 实测)
const PANEL_META = { "zcode/csp": { wasmUnsafeEval: true, frameDomains: [new URL(MX_BASE).origin] } };

async function mxFetch(path) {
  const resp = await fetch(`${MX_BASE}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`gateway ${path} → HTTP ${resp.status}`);
  return resp.json();
}

// 写操作白名单:与网关 web-command-handler 支持的 action 一一对应,不在表内的直接拒绝
const COMMAND_ACTIONS = new Set([
  "login",
  "accounts",
  "activateAccount",
  "resetAccount",
  "removeAccount",
  "syncPool",
  "billing",
  "submitInput",
  "pasteCallback",
  "cancelInput",
]);

const TOOLS = [
  {
    name: "mx_status",
    description: "网关概览:运行状态 / 今日用量 KPI(请求数、成功率、token、缓存命中) / 渠道健康(模型数、账号登录态、状态分布)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mx_models",
    description: "模型清单:每个池 id 的上下文窗口 / 最大输出 token / 思考档位 / 文本·视觉模态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mx_command",
    description:
      "网关写操作与账号读(经网关 /web/api/commands 代发):action ∈ login / accounts / activateAccount / " +
      "resetAccount / removeAccount / syncPool / billing / submitInput / pasteCallback / cancelInput;" +
      "账号操作需 cid + args.key,登录输入需 args.value,粘贴回调需 args.url",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "动作名(见工具描述白名单)" },
        cid: { type: "string", description: "渠道 id(账号/登录类必填;accounts/billing 可不填=全部渠道)" },
        args: { type: "object", description: "动作参数(如 key/value/url/force)", additionalProperties: true },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "mx_logs",
    description: "最近请求日志:模型、渠道、结果、状态码、耗时、token(默认 20 条,可过滤)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "条数,默认 20,最大 200" },
        cid: { type: "string", description: "按渠道过滤(可选)" },
        outcome: { type: "string", description: "按结果过滤:success / failure(可选)" },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "mx_status": {
      const [overview, health, state] = await Promise.all([
        mxFetch("/web/api/overview"),
        mxFetch("/health"),
        mxFetch("/web/api/state"),
      ]);
      const login = new Map((health.channels ?? []).map((c) => [c.cid, c.logged_in]));
      // 登录流程的完成态在 state 上(授权链接/二维码/两步输入),有值才带出
      const auth = state.auth_url || state.qr_url || state.login_input
        ? { auth_url: state.auth_url ?? "", qr_url: state.qr_url ?? "", login_input: state.login_input ?? null }
        : null;
      return {
        gateway: { ui_state: overview.gateway?.ui_state ?? "unknown", error: overview.gateway?.gateway_error ?? "" },
        usage: overview.usage ?? null,
        channels: (overview.channels ?? []).map((c) => ({ ...c, logged_in: login.get(c.cid) ?? null })),
        auth,
        consoleUrl: `${MX_BASE}/web/`,
      };
    }
    case "mx_models": {
      const list = await mxFetch("/v1/models");
      return {
        models: (list.data ?? []).map((m) => ({
          id: m.id,
          context_window: m.context_window ?? null,
          max_output_tokens: m.max_output_tokens ?? null,
          effort: m.effort?.supported_levels ?? null,
          input_modalities: m.input_modalities ?? null,
          output_modalities: m.output_modalities ?? null,
        })),
      };
    }
    case "mx_command": {
      const action = typeof args?.action === "string" ? args.action : "";
      if (!COMMAND_ACTIONS.has(action)) throw new Error(`不支持的 action: ${action || "(空)"}`);
      const cid = typeof args?.cid === "string" && args.cid ? args.cid : null;
      const cmdArgs = args?.args && typeof args.args === "object" ? args.args : {};
      const resp = await fetch(`${MX_BASE}/web/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, cid, args: cmdArgs }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`gateway /web/api/commands → HTTP ${resp.status}`);
      return resp.json(); // { ok, data } 或 { ok:false, error } —— 原样回给面板,不吞错
    }
    case "mx_logs": {
      const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 200);
      const q = new URLSearchParams({ limit: String(limit) });
      if (args?.cid) q.set("cid", String(args.cid));
      if (args?.outcome) q.set("outcome", String(args.outcome));
      const data = await mxFetch(`/web/api/logs?${q}`);
      return {
        total: data.total ?? 0,
        entries: (data.entries ?? []).map((e) => ({
          ts: e.ts,
          cid: e.cid,
          model: e.model,
          outcome: e.outcome,
          status: e.status,
          durationMs: e.durationMs,
          ttfbMs: e.ttfbMs,
          messageCount: e.messageCount,
          tokens: e.tokens?.total ?? null,
          slow: e.slow === true,
        })),
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function panelResource() {
  return {
    uri: "ui://mx-panel/panel.html",
    name: "ModelMux 面板",
    description: "网关概览 / 模型清单 / 最近日志",
    mimeType: HTML_MIME,
    _meta: PANEL_META,
  };
}

function dispatch(method, params) {
  switch (method) {
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params?.name, params?.arguments ?? {}).then((result) => ({
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      }));
    case "resources/list":
      return { resources: [panelResource()] };
    case "resources/read": {
      const uri = params?.uri ?? "";
      if (uri !== "ui://mx-panel/panel.html") {
        throw Object.assign(new Error(`unknown resource: ${uri}`), { code: -32602 });
      }
      return { contents: [{ uri, mimeType: HTML_MIME, text: readFileSync(PANEL_HTML, "utf8"), _meta: PANEL_META }] };
    }
    case "resources/subscribe":
    case "resources/unsubscribe":
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, error) {
  write({
    jsonrpc: "2.0",
    id,
    error: { code: error.code ?? -32603, message: error.message ?? "internal error" },
  });
}

function handle(msg) {
  if (msg.jsonrpc !== "2.0") return;
  if (typeof msg.id !== "number" && typeof msg.id !== "string") return; // 通知不回包
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: true },
      },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  // tools/call 是异步取数:包成 Promise,出错按工具错误回(isError),不吞异常
  Promise.resolve()
    .then(() => dispatch(msg.method, msg.params))
    .then((result) => reply(msg.id, result))
    .catch((err) => {
      if (msg.method === "tools/call") {
        reply(msg.id, {
          content: [{ type: "text", text: JSON.stringify({ error: err.message ?? String(err) }) }],
          isError: true,
        });
      } else {
        fail(msg.id, err);
      }
    });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`[mx-panel] drop frame: ${err.message}\n`);
    }
  }
});
process.stdin.on("error", (err) => {
  process.stderr.write(`[mx-panel] stdin error: ${err.message}\n`);
  process.exit(1);
});
process.stderr.write("[mx-panel] server started\n");
