// hello-panel MCP server:零依赖裸协议实现,验证 ZCode ui.surfaces 面板通道。
// 约束:stdout 只出 JSON-RPC(日志一律走 stderr);HTML 相对自身路径读取,不猜安装缓存位置。
// 协议参考:MCP stdio 规范 + 官方插件 excalidraw/documents 的 ui:// 资源形态。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(HERE, "ui", "panel.html");

const SERVER_INFO = { name: "hello-panel", version: "0.1.3" };

// 宿主按 mimeType 的 profile 识别 MCP App(纯 text/html 不建桥,握手必超时);
// zcode/csp meta 为宿主私有 CSP 授权,参照 documents 插件抄录
const HTML_MIME = "text/html;profile=mcp-app";
const PANEL_META = { "zcode/csp": { wasmUnsafeEval: true } };

function readPanelHtml() {
  return readFileSync(PANEL_HTML, "utf8");
}

function panelResource() {
  return {
    uri: "ui://hello-panel/panel.html",
    name: "Hello Panel 页面",
    description: "最小测试面板页面",
    mimeType: HTML_MIME,
    _meta: PANEL_META,
  };
}

function greetTool() {
  return {
    name: "panel_greet",
    description: "返回问候与服务器当前时间,用于从对话侧验证插件 server 存活",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function handleToolCall(params) {
  if (params.name !== "panel_greet") {
    throw new Error(`unknown tool: ${params.name}`);
  }
  const text = `Hello Panel server 存活,当前时间 ${new Date().toLocaleString("zh-CN")}`;
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

function dispatch(method, params) {
  switch (method) {
    case "ping":
      return {};
    case "tools/list":
      return { tools: [greetTool()] };
    case "tools/call":
      return handleToolCall(params ?? {});
    case "resources/list":
      return { resources: [panelResource()] };
    case "resources/read": {
      const uri = params?.uri ?? "";
      if (uri !== "ui://hello-panel/panel.html") {
        throw Object.assign(new Error(`unknown resource: ${uri}`), { code: -32602 });
      }
      return {
        contents: [{ uri, mimeType: HTML_MIME, text: readPanelHtml(), _meta: PANEL_META }],
      };
    }
    case "resources/subscribe":
    case "resources/unsubscribe":
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
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

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// protocolVersion 回显请求值:宿主 SDK 校验自身版本,硬编码某版本反而易被判不兼容
function handle(msg) {
  if (msg.jsonrpc !== "2.0") return;
  if (typeof msg.id !== "number" && typeof msg.id !== "string") {
    return; // 通知与非法帧不回包,避免污染宿主会话
  }
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
  try {
    reply(msg.id, dispatch(msg.method, msg.params));
  } catch (err) {
    fail(msg.id, err);
  }
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
      process.stderr.write(`[hello-panel] drop frame: ${err.message}\n`);
    }
  }
});
process.stdin.on("error", (err) => {
  process.stderr.write(`[hello-panel] stdin error: ${err.message}\n`);
  process.exit(1);
});
process.stderr.write("[hello-panel] server started\n");
