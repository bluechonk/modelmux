#!/usr/bin/env node
/**
 * Comate Cloud API 端点探测（零依赖，只用 Node 内置 fetch / fs）。
 *
 * 铁律：
 *   - 只发**正确形态**的请求（真实账号、真实上游），绝不发畸形载荷去「验证归一化」；
 *   - 令牌只打印指纹与长度，**永不打印原文**；
 *   - Comate 走百度 SSO Cookie 认证，本脚本从 settings.json 读账号标识，Cookie 需运行时从浏览器态拿。
 *
 * 用法:
 *   node comate-probe.mjs <命令> [参数...]
 *
 * 命令:
 *   token [machineId]           轮询 /api/client/generate/token?clientId=<machineId>（登录状态，无需 Cookie）
 *   models                     打 /api/claudeCode/openapi/v2/models/all（模型列表，需 Cookie）
 *   available-models           打 /api/v2/api/models/available?key=<license>（主模型列表，需 Cookie）
 *   account                    打 /comateplus/users/get（用户信息，需 Cookie）
 *   config                     打 /comateplus/configSets/config/enabled（配置集，需 Cookie）
 *   banner                     打 /api/activity/plugin/banner（活动横幅，无需认证）
 *   chat                       验证 /api/chat/stream 流式对话（需 Cookie）
 *
 * 认证头（部分端点需要特定 header 而非 Cookie）:
 *   COMATE_AUTH        Authorization 头的值（Bearer <token>）
 *   COMATE_USERNAME    用户名（部分端点用 login-name header）
 *
 * 环境变量:
 *   COMATE_COOKIE    百度 SSO Cookie（baidu.com 域名下）
 *   HTTPS_PROXY      走代理（如 http://127.0.0.1:7897）
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const COMATE = "https://comate.baidu.com";
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const [, , cmd, ...rest] = process.argv;

/** 走 Clash 代理的 HTTP 请求（通过 Bash curl 脚本）。 */
function viaProxy(method, path, body = "", extraHeaders = "") {
  const script = `${SCRIPT_DIR}/comate-curl.sh`;
  const args = `"${method}" "${path}"`;
  if (body) args += ` '${JSON.stringify(body)}'`;
  if (extraHeaders) args += ` "${extraHeaders}"`;
  try {
    const out = execSync(`bash "${script}" ${args}`, { encoding: "utf8", timeout: 25000 });
    return out;
  } catch (e) {
    return e.stdout?.toString() ?? "";
  }
}

/** 短指纹：前 6 位 + 长度 + 弱哈希。**绝不返回原文**。 */
function fp(value) {
  const t = String(value ?? "");
  if (!t) return "(empty)";
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `${t.slice(0, 6)}…(len ${t.length}, fp ${h.toString(16)})`;
}

function cookieHeader() {
  const ck = process.env.COMATE_COOKIE;
  if (!ck) {
    console.error("缺少 COMATE_COOKIE 环境变量（百度 SSO Cookie）");
    console.error("从运行中的 Comate 开发者工具或浏览器导出 baidu.com Cookie");
    process.exit(1);
  }
  return ck;
}

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  return { status: r.status, text: await r.text() };
}

async function post(url, headers = {}, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

function brief(text, len = 150) {
  const flat = text.replace(/\s+/g, " ").slice(0, len);
  try {
    const j = JSON.parse(text);
    if (j.error) return `error ${JSON.stringify(j.error).slice(0, 90)}`;
    if (j.code !== undefined) return `code=${j.code} desc=${j.desc ?? j.message ?? ""}`;
    return flat;
  } catch {
    return flat;
  }
}

switch (cmd) {
  case "token": {
    const machineId =
      rest[0] ?? readFileSync(`${process.env.APPDATA}/Comate/machineid`, "utf8").trim();
    const { status, text } = await get(
      `${COMATE}/api/client/generate/token?clientId=${encodeURIComponent(machineId)}`,
    );
    console.log(`HTTP ${status} GET /api/client/generate/token?clientId=${machineId}`);
    try {
      const j = JSON.parse(text);
      const loggedIn = j.status === "OK" && !!j.data;
      console.log(`登录状态: ${loggedIn ? "已登录" : "未登录"}`);
      if (loggedIn) console.log(`token = ${fp(j.data)}`);
      else console.log(JSON.stringify(j, null, 2));
    } catch {
      console.log(brief(text, 300));
    }
    break;
  }

  case "available-models": {
    // ⚠ 此端点仅需 License Key，不需要 Cookie
    const license = rest[0] ?? readFileSync(`${process.env.APPDATA}/Comate/User/settings.json`, "utf8");
    const key = typeof license === "string" && license.startsWith("{")
      ? JSON.parse(license)["baidu.comate.license"] ?? ""
      : license;
    const type = rest[1] ?? "INDIVIDUAL";
    const url = `${COMATE}/api/v2/api/models/available?key=${encodeURIComponent(key)}&type=${type}&source=plugin`;
    const { status, text } = await get(url, { "X-Source": "COMATE" });
    console.log(`HTTP ${status} GET /api/v2/api/models/available?key=***&type=${type}`);
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) {
        for (const m of j) {
          const effort = m.effortConfig
            ? `efforts=[${(m.effortConfig.levels || []).map((l) => l.value).join(",")}] default=${m.effortConfig.defaultLevel}`
            : "";
          const ctx = m.capability?.context_window ? `ctx=${m.capability.context_window}` : "";
          const maxOut = m.capability?.max_output_tokens ? `maxOut=${m.capability.max_output_tokens}` : "";
          console.log(
            `  ${String(m.model ?? m.id ?? "?").padEnd(28)} ${m.name ?? ""} ${ctx} ${maxOut} ${effort}`,
          );
        }
        console.log(`  共 ${j.length} 个模型`);
      } else {
        console.log(JSON.stringify(j, null, 2));
      }
    } catch {
      console.log(brief(text, 800));
    }
    break;
  }

  case "models": {
    const ck = cookieHeader();
    const { status, text } = await get(`${COMATE}/api/claudeCode/openapi/v2/models/all`, {
      Cookie: ck,
    });
    console.log(`HTTP ${status} GET /api/claudeCode/openapi/v2/models/all`);
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) {
        for (const m of j)
          console.log(
            `  ${String(m.id ?? m.model ?? "?").padEnd(32)} ${m.name ?? ""} ${m.status ?? ""}`,
          );
      } else {
        console.log(JSON.stringify(j, null, 2));
      }
    } catch {
      console.log(brief(text, 800));
    }
    break;
  }

  case "account": {
    const ck = cookieHeader();
    const { status, text } = await get(`${COMATE}/comateplus/users/get`, { Cookie: ck });
    console.log(`HTTP ${status} GET /comateplus/users/get`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(brief(text, 500));
    }
    break;
  }

  case "config": {
    const ck = cookieHeader();
    const { status, text } = await get(`${COMATE}/comateplus/configSets/config/enabled`, {
      Cookie: ck,
    });
    console.log(`HTTP ${status} GET /comateplus/configSets/config/enabled`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(brief(text, 500));
    }
    break;
  }

  case "banner": {
    const { status, text } = await get(`${COMATE}/api/activity/plugin/banner`);
    console.log(`HTTP ${status} GET /api/activity/plugin/banner`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(brief(text, 500));
    }
    break;
  }

  case "chat": {
    const ck = cookieHeader();
    const model = rest[0] || "auto";
    console.log(`=== 流式对话 POST ${COMATE}/api/chat/stream (model=${model}) ===`);
    const r = await fetch(`${COMATE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: ck },
      body: JSON.stringify({
        messages: [{ role: "user", content: "回复OK" }],
        model,
        stream: true,
      }),
    });
    console.log(`HTTP ${r.status} ${r.headers.get("content-type")}`);
    const text = await r.text();
    const frames = text.split("\n").filter((l) => l.startsWith("data:"));
    console.log(`SSE 帧数 ${frames.length}`);
    if (frames[0]) console.log(`首帧 ${frames[0].slice(0, 130)}`);
    if (frames.length > 1) console.log(`末帧 ${frames[frames.length - 1].slice(0, 130)}`);
    if (frames.length === 0) console.log(`原始响应: ${text.slice(0, 300)}`);
    break;
  }

  default:
    console.error(`未知命令: ${cmd ?? "(空)"}`);
    console.error("可用: token | available-models | models | account | config | banner | chat\n看脚本头部注释了解参数与铁律。");
    process.exit(1);
}
