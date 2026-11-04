// mx-panel MCP server: 零依赖裸协议实现,给 ZCode 侧栏提供「内嵌的 modelmux 控制台」。
// 约束:stdout 只出 JSON-RPC(日志一律走 stderr);只读,不碰写接口。
// 面板就是网关 /web/ 的 iframe —— 地址由本服务在 resources/read 时注入,
// 因为面板 HTML 是 MCP 资源,网关地址只有服务端知道(MODELMUX_BASE_URL 可覆盖)。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(HERE, "..", "panel.html");
const MX_BASE = process.env.MODELMUX_BASE_URL ?? "http://127.0.0.1:4412";

const SERVER_INFO = { name: "mx-panel", version: "0.4.0" };

// 宿主按 mimeType 的 profile 识别 MCP App(纯 text/html 不建桥,握手必超时)
const HTML_MIME = "text/html;profile=mcp-app";
// frameDomains: 面板要 iframe 内嵌完整控制台,省略时 CSP frame-src='none' 会直接拦掉
const PANEL_META = { "zcode/csp": { wasmUnsafeEval: true, frameDomains: [new URL(MX_BASE).origin] } };

/** 面板 HTML:注入控制台地址(用函数替换,避免 `$` 被当成替换模式;`g` 覆盖注释与 iframe 两处)。 */
function renderPanel() {
  return readFileSync(PANEL_HTML, "utf8").replace(/__MX_CONSOLE_URL__/g, () => `${MX_BASE}/web/`);
}

function panelResource() {
  return {
    uri: "ui://mx-panel/panel.html",
    name: "ModelMux 控制台",
    description: "内嵌的 modelmux Web 控制台(/web/)",
    mimeType: HTML_MIME,
    _meta: PANEL_META,
  };
}

function dispatch(method, params) {
  switch (method) {
    case "ping":
      return {};
    case "resources/list":
      return { resources: [panelResource()] };
    case "resources/read": {
      const uri = params?.uri ?? "";
      if (uri !== "ui://mx-panel/panel.html") {
        throw Object.assign(new Error(`unknown resource: ${uri}`), { code: -32602 });
      }
      return {
        contents: [{ uri, mimeType: HTML_MIME, text: renderPanel(), _meta: PANEL_META }],
      };
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

async function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) void handleLine(line);
    }
  });
  process.stdin.on("error", (err) => {
    process.stderr.write(`[mx-panel] stdin error: ${err.message}\n`);
  });
  process.stderr.write("[mx-panel] server started\n");
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${err.message}` } });
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { resources: { subscribe: true }, tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === "notifications/initialized") return;
    const result = dispatch(method, params);
    write({ jsonrpc: "2.0", id, result });
  } catch (err) {
    const code = typeof err?.code === "number" ? err.code : -32603;
    write({ jsonrpc: "2.0", id, error: { code, message: err.message } });
  }
}

void main();
