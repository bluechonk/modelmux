#!/usr/bin/env node
/**
 * AStudio 端点探测（零依赖，只用 Node 内置 fetch / fs）。
 *
 * 铁律：
 *   - 只发**正确形态**的请求（真实账号、真实上游），绝不发畸形载荷去「验证归一化」；
 *   - 令牌只打印指纹与长度，**永不打印原文**。
 *
 * 用法:
 *   node astudio-probe.mjs <命令> [参数...]
 *
 * 命令:
 *   session                    打印会话文件结构（值脱敏）
 *   models                     逐个探模型网关的模型，看哪些可用
 *   account                    打上游 /userInfo 与 /bot/models/configs（账号信息 + 模型倍率）
 *   usage                      读模型网关 /usage（额度与用量）
 *   chat                       验证流式 / 工具调用 / 思考档位
 *   local [端口...]            探本地 runtime server 的账号面
 *
 * 环境变量:
 *   ASTRON_SESSION   会话文件路径（默认取 Windows 标准位置）
 *   HTTPS_PROXY      走代理（如 http://127.0.0.1:7897）
 */
import { readFileSync } from "node:fs";

const DEFAULT_SESSION =
  "C:/Users/bluechonk/AppData/Local/Programs/AStudio Data/userdata/astron-session.json";
const SESSION_PATH = process.env.ASTRON_SESSION ?? DEFAULT_SESSION;

const GATEWAY = "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1";
const STUDIO = "https://agent.xfyun.cn/xingchen-studio";

const [cmd, ...rest] = process.argv.slice(2);

/** 读会话文件；字段值脱敏。 */
function loadSession() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
  } catch (err) {
    console.error(`读不到会话文件 ${SESSION_PATH}: ${String(err).slice(0, 80)}`);
    process.exit(1);
  }
  return {
    accountId: String(raw.accountId ?? ""),
    uid: String(raw.uid ?? ""),
    token: String(raw.token ?? ""),
    ssoSessionId: String(raw.ssoSessionId ?? ""),
    modelBearerToken: String(raw.modelBearerToken ?? ""),
    mobile: String(raw.mobile ?? ""),
    loginMethod: String(raw.loginMethod ?? ""),
    loggedInAt: String(raw.loggedInAt ?? ""),
    banned: Boolean(raw.banned),
  };
}

/** 短指纹：前 6 位 + 长度 + 弱哈希。**绝不返回原文**。 */
function fp(value) {
  const t = String(value ?? "");
  if (!t) return "(empty)";
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `${t.slice(0, 6)}…(len ${t.length}, fp ${h.toString(16)})`;
}

/** 会话 Cookie（源码 buildAstronCookieHeader 的形态）。 */
function cookie(s) {
  return [
    s.ssoSessionId ? `ssoSessionId=${s.ssoSessionId}` : null,
    s.ssoSessionId ? `sso_sessionid=${s.ssoSessionId}` : null,
    `account_id=${s.accountId}`,
    `token=${s.token}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** 极简 HTTP：支持 HTTPS_PROXY（Node 内置 fetch 不认代理，需手动走 CONNECT 太复杂，
 *  故这里只在明确给代理时用 undici 的 ProxyAgent —— 但为保持零依赖，改为提示用户用环境变量）。 */
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

/** 把响应摘要成一行（JSON 取关键字段，非 JSON 截断）。 */
function brief(text, len = 150) {
  const flat = text.replace(/\s+/g, " ").slice(0, len);
  try {
    const j = JSON.parse(text);
    if (j.error) return `error ${JSON.stringify(j.error).slice(0, 90)}`;
    if (j.code !== undefined) return `code=${j.code} flag=${j.flag} desc=${j.desc ?? ""}`;
    return flat;
  } catch {
    return flat;
  }
}

const s = loadSession();

switch (cmd) {
  case "session": {
    console.log(`会话文件: ${SESSION_PATH}`);
    for (const [k, v] of Object.entries(s)) {
      if (k === "token" || k === "ssoSessionId" || k === "modelBearerToken") {
        console.log(`  ${k.padEnd(18)} = ${fp(v)}`);
      } else {
        console.log(`  ${k.padEnd(18)} = ${JSON.stringify(v)}`);
      }
    }
    break;
  }

  case "models": {
    const ids = rest.length
      ? rest
      : [
          "astronclaw-auto",
          "spark-x2.6",
          "spark-x2.6-4b",
          "spark-x2.5",
          "xopglm52",
          "xopdeepseekv4pro",
          "xopdeepseekv4pro0813",
          "xopdsv4flash0731in",
        ];
    console.log(`bearer = ${fp(s.modelBearerToken)}\n`);
    for (const model of ids) {
      const { status, text } = await post(
        `${GATEWAY}/chat/completions`,
        { Authorization: `Bearer ${s.modelBearerToken}` },
        { model, messages: [{ role: "user", content: "回复OK" }], max_tokens: 8 },
      );
      let note = brief(text, 110);
      try {
        const j = JSON.parse(text);
        if (j.usage) note = `OK usage=${j.usage.total_tokens ?? "?"}`;
      } catch {
        /* keep brief */
      }
      console.log(`  ${String(status).padEnd(4)} ${model.padEnd(24)} ${note}`);
    }
    break;
  }

  case "account": {
    const ck = cookie(s);
    for (const path of ["/userInfo", "/bot/models/configs"]) {
      const { status, text } = await get(`${STUDIO}${path}`, { Cookie: ck });
      console.log(`\n${status} GET ${path}`);
      try {
        const j = JSON.parse(text);
        if (path === "/userInfo") {
          console.log(JSON.stringify(j.data?.userInfo ?? j, null, 2));
        } else {
          for (const m of j.data ?? []) {
            console.log(
              `  ${String(m.id).padEnd(22)} ${String(m.name).padEnd(20)} model=${m.model}` +
                ` provider=${m.provider} x${m.point_multiplier ?? "-"}` +
                ` default=${m.is_default} current=${m.is_current} key=${fp(m.api_key)}`,
            );
          }
        }
      } catch {
        console.log(`  ${brief(text, 300)}`);
      }
    }
    break;
  }

  case "usage": {
    const { status, text } = await get(`${GATEWAY}/usage`, {
      Authorization: `Bearer ${s.modelBearerToken}`,
    });
    console.log(`HTTP ${status}`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text.slice(0, 800));
    }
    break;
  }

  case "chat": {
    const h = { Authorization: `Bearer ${s.modelBearerToken}` };
    console.log("=== 流式 ===");
    {
      const r = await fetch(`${GATEWAY}/chat/completions`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "astronclaw-auto",
          messages: [{ role: "user", content: "从1数到5" }],
          max_tokens: 60,
          stream: true,
        }),
      });
      console.log(`HTTP ${r.status} ${r.headers.get("content-type")}`);
      const text = await r.text();
      const frames = text.split("\n").filter((l) => l.startsWith("data:"));
      console.log(`  SSE 帧数 ${frames.length}`);
      console.log(`  首帧 ${frames[0]?.slice(0, 130)}`);
      console.log(`  末帧 ${frames[frames.length - 1]?.slice(0, 130)}`);
    }
    console.log("\n=== 工具调用 ===");
    {
      const { status, text } = await post(
        `${GATEWAY}/chat/completions`,
        h,
        {
          model: "astronclaw-auto",
          messages: [{ role: "user", content: "北京天气怎么样？用工具查。" }],
          max_tokens: 120,
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "查询城市天气",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
        },
      );
      console.log(`HTTP ${status}`);
      try {
        const j = JSON.parse(text);
        console.log(`  finish_reason = ${j.choices?.[0]?.finish_reason}`);
        console.log(`  tool_calls = ${JSON.stringify(j.choices?.[0]?.message?.tool_calls)?.slice(0, 200)}`);
      } catch {
        console.log(`  ${brief(text, 200)}`);
      }
    }
    break;
  }

  case "local": {
    const ports = rest.length ? rest : ["16051", "16083", "16084"];
    for (const port of ports) {
      console.log(`\n########## 127.0.0.1:${port}`);
      for (const p of [
        "/health",
        "/api/auth/session",
        "/api/astron-auth/session?mode=local",
        "/api/astron-auth/points-balance",
      ]) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}${p}`, {
            headers: { Accept: "application/json", Authorization: `Bearer ${s.token}` },
          });
          console.log(`  ${r.status} ${p.padEnd(40)} ${brief(await r.text(), 120)}`);
        } catch (e) {
          console.log(`  ERR ${p.padEnd(40)} ${String(e).slice(0, 50)}`);
        }
      }
    }
    break;
  }

  default:
    console.error(`未知命令: ${cmd ?? "(空)"}`);
    console.error(
      "可用: session | models | account | usage | chat | local\n看脚本头部注释了解参数与铁律。",
    );
    process.exit(1);
}
