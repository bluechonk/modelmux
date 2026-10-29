/**
 * `/jailbreak` 的**全链路**实证：请求从 relay 进来 → 裁剪 → `buildChatBody` →
 * 假上游实际收到的 body。锁死三条：
 *
 *  1. 带标记的请求：上游收到的 messages 第一条就是**标记后面的内容**，
 *     且 system / 历史 / 标记本身都不在；
 *  2. 对照请求（无标记）：system 原样在上游收到的 body 里；
 *  3. 两条请求的 access 日志分别带 / 不带 `jailbreak: true`。
 *
 * 全程离线：合成渠道（custom 线型、翻译器原样透传）+ 假上游 HTTP server + 临时存储根。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

const savedHome = process.env["MODELMUX_HOME"];
let root = "";
let upstream: Server | undefined;
let gw: { addr: string; close: () => Promise<void> } | undefined;
/** 假上游最近一次收到的 body。 */
let lastUpstreamBody: Record<string, unknown> | null = null;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "modelmux-jailbreak-e2e-"));
  process.env["MODELMUX_HOME"] = root;

  // 假上游：记录收到的 body，回 OpenAI 非流式应答
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      lastUpstreamBody = JSON.parse(raw || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as { port: number }).port;

  // 合成渠道：custom 线型 + 原样透传翻译器；buildChatBody 不做任何 messages 重组
  //（隔离渠道行为，验证的是**转发链**本身）
  const channel: Channel = {
    config: {
      cid: "jbsynth",
      display: "Jailbreak E2E",
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      debugDumpEnv: "JBSYNTH_DUMP",
    } as ChannelConfig,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: "t" }),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => `http://127.0.0.1:${upstreamPort}`,
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: "Jailbreak E2E",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }),
      loadConfig: () => [{ baseUrl: `http://127.0.0.1:${upstreamPort}` }, false],
      saveConfig: async () => {},
      chatUrl: () => `http://127.0.0.1:${upstreamPort}/chat`,
      modelsUrl: () => `http://127.0.0.1:${upstreamPort}/models`,
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }),
      idleTimeoutMs: () => 5_000,
      newTranslator: () => ({
        feed: (chunk: Buffer) => [chunk],
        finish: () => [],
        idleCutoffAfterContentMs: () => 5_000,
      }),
    },
    catalog: { exposedIds: () => ["test-model"], resolveModel: (n: string) => n },
    billing: { CreditsError: class CreditsError extends Error {}, fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) },
  } as unknown as Channel;
  setChannel(channel);

  gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
});

after(async () => {
  await gw?.close().catch(() => {});
  upstream?.close();
  if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedHome;
  clearChannels();
  rmSync(root, { recursive: true, force: true });
});

const SYSTEM = "你是测试助手，回答保持简短。";

const send = async (userText: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`http://${gw!.addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jbsynth/test-model",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "assistant", content: "（上一轮回答）" },
        { role: "user", content: userText },
      ],
      // 工具声明随请求一起发：带标记时应随上下文一起被裁掉
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
      tool_choice: "auto",
      stream: false,
    }),
  });
  return { status: res.status, body: await res.text() };
};

const accessRows = (): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = [];
  const access = join(paths.logsDir(), "access");
  let dates: string[];
  try {
    dates = readdirSync(access);
  } catch {
    return out;
  }
  for (const date of dates) {
    for (const outcome of ["success", "failure", "other"]) {
      let text: string;
      try {
        text = readFileSync(join(access, date, `${outcome}.log`), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
};

describe("/jailbreak 全链路（relay → buildChatBody → 上游 body）", () => {
  it("带标记：上游收到的 messages 第一条就是标记后面的内容，system 与历史不在", async () => {
    lastUpstreamBody = null;
    const { status } = await send("/jailbreak 请只回复：OK");
    assert.equal(status, 200);
    assert.ok(lastUpstreamBody !== null, "假上游应收到 body");

    const messages = lastUpstreamBody!["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1, `应只剩 1 条，实得 ${JSON.stringify(messages)}`);
    assert.equal(messages[0]!["role"], "user");
    assert.equal(messages[0]!["content"], "请只回复：OK", "第一条 = 标记后面的内容");
    assert.ok(!JSON.stringify(messages).includes(SYSTEM), "system 不得出现在上游收到的 body 里");
    assert.ok(!JSON.stringify(messages).includes("（上一轮回答）"), "历史不得出现");
    assert.ok(!JSON.stringify(messages).includes("/jailbreak"), "标记本身也不发上游");
    // tools 等前置能力声明随上下文一起裁掉
    assert.equal("tools" in lastUpstreamBody!, false, "tools 应被裁剪");
    assert.equal("tool_choice" in lastUpstreamBody!, false, "tool_choice 应被裁剪");

    const row = accessRows().find((r) => r["path"] === "/v1/chat/completions" && r["jailbreak"] === true);
    assert.ok(row, "access 日志应带 jailbreak: true");
  });

  it("对照：无标记时 system 原样发上游，日志不带 jailbreak", async () => {
    lastUpstreamBody = null;
    const { status } = await send("请只回复：OK");
    assert.equal(status, 200);
    const messages = lastUpstreamBody!["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages[0]!["role"], "system");
    assert.equal(messages[0]!["content"], SYSTEM);
    assert.equal(messages.length, 3, "无标记时三条都在");

    const rows = accessRows().filter((r) => r["path"] === "/v1/chat/completions");
    const flagged = rows.filter((r) => r["jailbreak"] === true);
    assert.equal(flagged.length, 1, "只有带标记的那一条被标记");
  });
});
