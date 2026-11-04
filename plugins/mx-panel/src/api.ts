// 宿主桥:MCP App 经 postMessage 与 ZCode 宿主通信(ui/initialize 握手 + tools/call)。
// 写操作与账号读统一经 mx_command 工具由 MCP server 代发网关 /web/api/commands
// —— webview 直连网关会被同源校验拦(浏览器必带 Origin),Node 侧无此限制。

const PROTOCOL = "2025-11-21";

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function send(msg: Record<string, unknown>) {
  window.parent.postMessage(msg, "*");
}

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 15000);
  });
}

window.addEventListener("message", (ev) => {
  const m = ev.data as { jsonrpc?: string; id?: number; result?: unknown; error?: { message?: string } };
  if (!m || m.jsonrpc !== "2.0" || typeof m.id !== "number") return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error.message ?? "宿主返回错误"));
  else p.resolve(m.result);
});

export async function handshake(): Promise<void> {
  await request("ui/initialize", {
    appInfo: { name: "mx-panel", version: "0.2.0" },
    appCapabilities: {},
    protocolVersion: PROTOCOL,
  });
  send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
}

export async function tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await request("tools/call", { name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (res?.isError) throw new Error(JSON.parse(res.content?.[0]?.text ?? "{}").error ?? "工具返回错误");
  return JSON.parse(res?.content?.[0]?.text ?? "null") as T;
}

export function command(action: string, cid?: string, args: Record<string, unknown> = {}) {
  return tool<{ ok: boolean; data?: unknown; error?: string }>("mx_command", { action, cid, args });
}
