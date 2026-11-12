/**
 * Marvis 上游：REST 业务接口 + 本地 gateway WebSocket。
 *
 * 关键约束（端点/字段/实测见 docs/marvis/PROTOCOL.md）：
 *   - REST 走 `yybadaccess.3g.qq.com`，签名见 `cred.sign`；日常接口只需凭据。
 *   - gateway 走 `ws://127.0.0.1:<port>/?token=<token>`，帧是**纯 JSON**
 *     （`{type:"request", event, payload, requestId}`），不是二进制。
 *   - gateway 端口与 token 由客户端动态下发；本模块只接受调用方传入的地址。
 *
 * 铁律：accessToken 不进日志。
 */

import { readFileSync } from "node:fs";

import {
  ensureDir,
  login as sharedLogin,
  upstreamPath,
  writeJsonFile,
  type StreamTranslator,
} from "@modelmux/gateway";

import { DEFAULT_BASE_URL, type Credentials, apiCall } from "./cred.js";

export { DEFAULT_BASE_URL };

/** 展示名。 */
export const DISPLAY_NAME = "Marvis";

/**
 * 线型。
 *
 * Marvis 的模型对话不在可复用的 HTTP 端点上（走客户端内部通道），
 * 本渠道对外只提供账号 / 额度 / 工具类接口，故声明 `custom` 并给出
 * 不支持的翻译器，由共享层按「本渠道不承载对话」处理。
 */
export const WIRE: "openai" | "custom" = "custom";

/** 上游拒绝访问。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

// ── 配置 ────────────────────────────────────────────────────────────────────

interface Config {
  baseUrl: string;
  /** 本地 gateway 地址（形如 `127.0.0.1:10123`），未配置为空。 */
  gatewayAddr: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, gatewayAddr: "" };
}

export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const fallback = defaultConfig();
    return [
      {
        baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : fallback.baseUrl,
        gatewayAddr: typeof parsed.gatewayAddr === "string" ? parsed.gatewayAddr : fallback.gatewayAddr,
      },
      true,
    ];
  } catch {
    return [defaultConfig(), false];
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

/** 对话端点占位：Marvis 不承载对话，返回一个必然失败的地址供共享层判空。 */
export function chatUrl(cfg?: Config): string {
  const base = (cfg?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/v3/marvis_capabilities`;
}

/** 模型列表端点（Marvis 无独立模型端点，用自定义 provider 列表）。 */
export function modelsUrl(cfg?: Config): string {
  const base = (cfg?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/v3/marvis_list_custom_llm_provider`;
}

export function buildHeaders(credential: Credentials): Record<string, string> {
  return {
    Cookie: credential.cookie,
    "Ual-Access-Access-Token": credential.token,
    "Ual-Access-Login-Type": credential.loginType,
    "Ual-Access-Openid": credential.openId,
  };
}

/** 4xx 是否为鉴权失败。 */
export function isAuthFailure(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return /RC_NO_AUTH_ERR|no_auth|login required/i.test(body);
}

export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const base = fallback ?? defaultConfig();
  return {
    baseUrl: typeof data["baseUrl"] === "string" && data["baseUrl"] ? data["baseUrl"] : base.baseUrl,
    gatewayAddr:
      typeof data["gatewayAddr"] === "string" && data["gatewayAddr"] ? data["gatewayAddr"] : base.gatewayAddr,
  };
}

// ── 业务读取 ────────────────────────────────────────────────────────────────

/** 账号信息（`isMainChat` 式探测：用 `marvis_check_login`）。 */
export async function fetchAccount(credential: Credentials): Promise<Record<string, unknown>> {
  const r = await apiCall(credential, "/marvis_client/marvis_check_login", {
    userInfo: {
      openId: credential.openId,
      accessToken: credential.token,
      refreshToken: credential.refreshToken,
      loginType: credential.loginType,
    },
  });
  return (r.body["user_info"] as Record<string, unknown>) ?? r.body;
}

/** 自定义 LLM 供应商（Marvis 没有自带模型，模型来自用户自配的第三方）。 */
export async function fetchProviders(credential: Credentials): Promise<Record<string, unknown>[]> {
  const r = await apiCall(credential, "/v3/marvis_list_custom_llm_provider", {});
  const list = r.body["providers"];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** token 用量明细（逐日）。 */
export async function fetchUsageLogs(credential: Credentials): Promise<Record<string, unknown>[]> {
  const r = await apiCall(credential, "/v3/marvis_list_agent_token_stats", {});
  const data = r.body["data"] as Record<string, unknown> | undefined;
  const records = data?.["records"];
  return Array.isArray(records) ? (records as Record<string, unknown>[]) : [];
}

/** 兼容共享层契约的模型列表。 */
export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const providers = await fetchProviders(credential);
  return { providers };
}

// ── 本地 gateway（WebSocket，JSON 帧） ──────────────────────────────────────

/** gateway 应答。 */
export interface GatewayReply {
  readonly type: string;
  readonly event: string;
  readonly data?: unknown;
}

/** 已知的 gateway action（服务端错误信息中提取，见 PROTOCOL §15.3）。 */
export const GATEWAY_ACTIONS = [
  "blocking.resolve",
  "browser.list",
  "browser.login.open",
  "browser.status",
  "device.notify",
  "feature.get",
  "mcp.list",
  "persona.get",
  "product.get",
  "token.wallet",
  "token.usage_logs",
  "user.get_credentials",
  "user.login",
  "user.logout",
] as const;

/**
 * 调一次 gateway action。
 *
 * 帧格式：`{ type: "request", event: <action>, payload, requestId }`。
 * 应答：`{ type: "ack", event, requestId, data: { ok, data | error } }`。
 */
export async function gatewayCall(
  addr: string,
  token: string,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<GatewayReply> {
  if (!addr) throw new Error("Marvis gateway 地址未配置（upstream.json 的 gatewayAddr）");
  const url = `ws://${addr}/?token=${encodeURIComponent(token)}`;
  return new Promise<GatewayReply>((resolve, reject) => {
    const socket = new WebSocket(url);
    const requestId = `mx-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      reject(new Error(`Marvis gateway 超时（action=${action}）`));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "request", event: action, payload, requestId }));
    });
    socket.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      // 只认自己那次请求的应答；gateway.connected 等事件忽略
      if (msg["requestId"] !== requestId && msg["type"] !== "ack") return;
      if (msg["requestId"] !== requestId) return;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve({
        type: String(msg["type"] ?? ""),
        event: String(msg["event"] ?? ""),
        data: msg["data"],
      });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Marvis gateway 连接失败（客户端未运行？）"));
    });
  });
}

/** 额度（`token.wallet`）。 */
export async function gatewayWallet(
  addr: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const reply = await gatewayCall(addr, token, "token.wallet");
  const d = reply.data as Record<string, unknown> | undefined;
  const inner = d?.["data"];
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

/**
 * 构造上游请求体：本渠道**不承载对话**，显式拒绝。
 *
 * Marvis 的模型对话走客户端内部通道（未对外暴露可复用端点），
 * catalog 也不暴露任何池模型，所以共享层不应把对话请求派到这里。
 * 抛错比返回一个假 body 更诚实 —— 后者会被上游当参数错误，误导排查。
 */
export function buildChatBody(): Record<string, unknown> {
  throw new Error("Marvis 渠道不承载模型对话（其模型来自用户自配的第三方 provider）");
}

/** 翻译器（本渠道不承载对话，给出空的实现）。 */
export function newTranslator(): StreamTranslator {
  return {
    feed(): Array<Buffer | string> {
      return [];
    },
    finish(): Array<Buffer | string> {
      return [];
    },
  };
}

/** 供 CLI 展示：凭据可用性摘要。 */
export async function probeUpstream(credential: Credentials): Promise<string> {
  const account = await fetchAccount(credential);
  const name = String(account["nick_name"] ?? account["nickname"] ?? "");
  const openId = String(account["open_id"] ?? "");
  return `${name || "(unnamed)"} openid=${openId || "-"}`;
}

/** 转发共享层原语，避免直接 import 共享层内部路径。 */
export const loginPrimitives = { fetchWithTimeout: sharedLogin.fetchWithTimeout };
