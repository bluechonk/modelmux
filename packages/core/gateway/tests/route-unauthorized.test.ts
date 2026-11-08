/**
 * 路由的两条「不该在这条候选上继续耗」的判据（合成渠道，完全离线）：
 *
 *  1. **凭据失效（unauthorized）是终态** —— token 已被上游撤销，换账号 / 重登之前
 *     重试永远不会成功。路由要提前剔除（`route.ts`），否则每次请求都先白跑一趟
 *     （实测 autoclaw：令牌失效后仍因「额度最多」排在候选首位）。
 *  2. **「本渠道承载不了这类输入」不是用户输入错误** —— 换一家渠道可能成功
 *     （catpaw 把请求体按纯文本渲染，图片进不去）。必须判**可重试**，
 *     而不是终局 400（实测 deepseek-v4.1-flash 的带图请求被 catpaw 守卫拦死，
 *     而 qodercn 等渠道本来能正常处理）。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { UnsupportedInputError } from "../dist/http/chat/errors.js";
import { activeAccountHealth, captureActive, markActiveHealth } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import { resolvePoolRoute } from "../dist/http/chat/route.js";
import { localDate } from "../dist/runtime/log-store.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

// ── 假上游 ────────────────────────────────────────────────────────────────────

/** 假上游：一律 200 SSE，只记录收到的 token。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; captured: string[] }> {
  const captured: string[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      captured.push(String(req.headers["authorization"] ?? ""));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, captured };
}

// ── 合成渠道 ──────────────────────────────────────────────────────────────────

class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

interface ChannelOpts {
  token: string;
  upstreamUrl: string;
  /** 带图片的请求抛 `UnsupportedInputError`（对齐 catpaw 的守卫）。 */
  refuseImages?: boolean;
  /** `prepareChat` 抛 `UpstreamUnauthorized`（对齐 autoclaw 的 11003）。 */
  unauthorizedOnPrepare?: boolean;
  /** 第一次 prepare 抛凭据失效，刷新后恢复（对齐「access_token 死了、refresh_token 还活着」）。 */
  recoverAfterRefresh?: boolean;
  /** 刷新本身抛 `UpstreamUnauthorized`（凭据真失效，与「网络失败」区分）。 */
  refreshUnauthorized?: boolean;
  /** 不声明 billing 模块 → 该渠道的模型按「免费（×0）」处理。 */
  noBilling?: boolean;
}

function makeChannel(cid: string, opts: ChannelOpts): Channel {
  // 候选渠道由统一注册表声明（与线上同口径）
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const load = (): Record<string, unknown> => {
    return JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
  };
  const save = async (c: Record<string, unknown>): Promise<void> => {
    mkdirSync(paths.channelDir(cid), { recursive: true });
    writeFileSync(paths.credentialsPath(cid), `${JSON.stringify(c, null, 2)}\n`, "utf8");
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: opts.upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save,
      login: async () => load(),
      // 刷新行为按选项分化：成功 / 鉴权失败（凭据真失效）/ 普通故障（网络等瞬时问题）
      refresh: async (c: Record<string, unknown>) => {
        if (opts.refreshUnauthorized) throw new UpstreamUnauthorized("refresh rejected the token");
        if (!opts.recoverAfterRefresh) throw new Error("no refresh endpoint");
        const next = { ...c, accessToken: `${String(c["accessToken"])}-refreshed` };
        await save(next);
        return next;
      },
      resolveBaseUrl: () => opts.upstreamUrl,
    },
    upstream: {
      DEFAULT_BASE_URL: opts.upstreamUrl,
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized,
      chatUrl: () => `${opts.upstreamUrl}/chat`,
      modelsUrl: () => `${opts.upstreamUrl}/models`,
      // 头取**当前凭据**（不是静态 token）：刷新后必须真的用上新 token
      buildHeaders: () => ({ Authorization: `Bearer ${String(load()["accessToken"])}` }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => {
        if (opts.refuseImages) {
          const messages = req["messages"];
          const hasImage = Array.isArray(messages) &&
            messages.some((m) => {
              const content = (m as Record<string, unknown>)?.["content"];
              return Array.isArray(content) &&
                content.some((part) => part && typeof part === "object" &&
                  ((part as Record<string, unknown>)["type"] === "image_url" ||
                    (part as Record<string, unknown>)["type"] === "image"));
            });
          if (hasImage) throw new UnsupportedInputError(`${cid} 不支持图片输入`);
        }
        return { ...req, model: upstreamModel };
      },
      prepareChat: (opts.unauthorizedOnPrepare || opts.recoverAfterRefresh)
        ? (() => {
            let calls = 0;
            return async (): Promise<void> => {
              calls += 1;
              // 「可救」渠道：刷新后（第二次调用起）恢复正常
              if (opts.recoverAfterRefresh && calls > 1) return;
              throw new UpstreamUnauthorized("invalid authorization token");
            };
          })()
        : undefined,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: opts.upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    // 不声明 billing → 渠道能力里没有额度概念 → 模型按免费（×0）处理
    ...(opts.noBilling ? {} : { billing: { fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) } }),
  } as unknown as Channel;
}

/** 写凭据文件并把账号收进池（`markActiveHealth` 需要有生效账号才有意义）。 */
function seedAccount(cid: string): void {
  mkdirSync(paths.channelDir(cid), { recursive: true });
  writeFileSync(
    paths.credentialsPath(cid),
    `${JSON.stringify({ accessToken: `tok-${cid}`, refreshToken: "r", uid: `u-${cid}`, domain: "d" }, null, 2)}\n`,
    "utf8",
  );
  captureActive(cid);
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

describe("路由剔除凭据失效（unauthorized）的渠道", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-unauth-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    clearChannels();
    setChannel(makeChannel("alpha", { token: "tok-alpha", upstreamUrl: upstream.url }));
    setChannel(makeChannel("beta", { token: "tok-beta", upstreamUrl: upstream.url }));
    seedAccount("alpha");
    seedAccount("beta");
    poolUsage.writeBilling("alpha", { total: { remain: 900, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 100, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("额度高的渠道被标 unauthorized 后不再进候选", () => {
    markActiveHealth("unauthorized", "alpha");
    assert.equal(activeAccountHealth("alpha"), "unauthorized");
    const route = resolvePoolRoute("deepseek-v4.1-flash", {} as ServerResponse, () => {});
    assert.ok(route !== null);
    assert.deepEqual(
      route.attempts.map((c) => c.cid),
      ["beta"],
      "alpha 凭据失效是终态，不该再被尝试",
    );
  });

  it("请求直接落到下一个候选（不白跑一趟坏渠道）", async () => {
    markActiveHealth("unauthorized", "alpha");
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(upstream.captured, ["Bearer tok-beta"], "alpha 被剔除，直接打 beta");
  });

  it("全被标 unauthorized 时回退完整候选（服务不能因此不可用）", () => {
    markActiveHealth("unauthorized", "alpha");
    markActiveHealth("unauthorized", "beta");
    const route = resolvePoolRoute("deepseek-v4.1-flash", {} as ServerResponse, () => {});
    assert.ok(route !== null);
    assert.deepEqual(
      route.attempts.map((c) => c.cid).sort(),
      ["alpha", "beta"],
      "全池终态时回退完整候选（与冷却同口径）",
    );
  });
});

/**
 * 前置阶段凭据失效后**刷新失败**的两种结局：
 * - 刷新被上游按鉴权拒绝 → 凭据真失效 → 标终态；
 * - 刷新只是网络 / 读盘失败（渠道普遍包成普通 Error）→ **不能**标终态，
 *   否则一次抖动就把健康账号永久踢出候选。
 */
function startRefreshCase(
  root: string,
  upstream: Awaited<ReturnType<typeof fakeUpstream>>,
  refreshUnauthorized: boolean,
): void {
  process.env["MODELMUX_HOME"] = root;
  clearChannels();
  setChannel(
    makeChannel("alpha", {
      token: "tok-alpha",
      upstreamUrl: upstream.url,
      unauthorizedOnPrepare: true,
      refreshUnauthorized,
    }),
  );
  setChannel(makeChannel("beta", { token: "tok-beta", upstreamUrl: upstream.url }));
  seedAccount("alpha");
  seedAccount("beta");
  poolUsage.writeBilling("alpha", { total: { remain: 900, unit: "credits" } });
  poolUsage.writeBilling("beta", { total: { remain: 100, unit: "credits" } });
}

describe("前置凭据失效：刷新被鉴权拒绝 → 标终态", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-unauth2-"));
    upstream = await fakeUpstream();
    startRefreshCase(root, upstream, true);
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("标 unauthorized 终态并换候选", async () => {
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200, "换候选后仍应成功");
    assert.deepEqual(upstream.captured, ["Bearer tok-beta"], "不再打 alpha 的上游");
    assert.equal(activeAccountHealth("alpha"), "unauthorized", "前置阶段的凭据失效也要标终态");
  });
});

describe("前置凭据失效：刷新只是网络失败 → 不标终态", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-unauth4-"));
    upstream = await fakeUpstream();
    startRefreshCase(root, upstream, false);
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("换候选但账号保持可用", async () => {
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(upstream.captured, ["Bearer tok-beta"]);
    assert.equal(
      activeAccountHealth("alpha"),
      "ok",
      "一次瞬时刷新失败就把健康账号永久踢出候选（还谎报未登录）是不可接受的",
    );
  });
});

describe("前置阶段凭据失效但 refresh_token 还活着 → 刷新后救回", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-unauth3-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    clearChannels();
    setChannel(
      makeChannel("alpha", { token: "tok-alpha", upstreamUrl: upstream.url, recoverAfterRefresh: true }),
    );
    setChannel(makeChannel("beta", { token: "tok-beta", upstreamUrl: upstream.url }));
    seedAccount("alpha");
    seedAccount("beta");
    poolUsage.writeBilling("alpha", { total: { remain: 900, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 100, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("刷新后仍由 alpha 服务，且把之前的 unauthorized 标记清掉", async () => {
    // 先把**两个**候选都标成终态（模拟「上一轮请求把 access_token 判死」）：
    // 全池终态时路由回退完整候选，alpha 才有机会用刷新自证凭据已活
    markActiveHealth("unauthorized", "alpha");
    markActiveHealth("unauthorized", "beta");
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(
      upstream.captured,
      ["Bearer tok-alpha-refreshed"],
      "刷新拿到新 token 后仍走额度最高的 alpha（不把它踢出候选）",
    );
    assert.equal(activeAccountHealth("alpha"), "ok", "刷新成功 = 凭据已活，该清掉终态标记");
  });
});

describe("「本渠道承载不了这类输入」→ 可重试，不是终局 400", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-unsupported-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    clearChannels();
    // alpha 额度更高但不收图片（对齐 catpaw 的纯文本渲染）
    setChannel(makeChannel("alpha", { token: "tok-alpha", upstreamUrl: upstream.url, refuseImages: true }));
    setChannel(makeChannel("beta", { token: "tok-beta", upstreamUrl: upstream.url }));
    seedAccount("alpha");
    seedAccount("beta");
    poolUsage.writeBilling("alpha", { total: { remain: 900, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 100, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("带图请求：先试 alpha（被守卫拦下），顺延到 beta 拿到 200", async () => {
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "这是什么？" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
          ],
        }],
      }),
    });
    assert.equal(resp.status, 200, "换一家能收图的渠道就该成功");
    assert.deepEqual(upstream.captured, ["Bearer tok-beta"], "alpha 构造阶段即被跳过");
  });

  it("纯文本请求：alpha 照常服务（守卫不该误伤正常请求）", async () => {
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(upstream.captured, ["Bearer tok-alpha"], "纯文本仍走额度最高的 alpha");
  });
});

/**
 * 流内业务错误帧（HTTP 200 + SSE 里投递业务错误）的记账。
 *
 * 在这之前网关对这类帧完全无感：访问日志记成功、账本不计失败、账号不冷却 ——
 * 同一个业务错误会一直重复（实测 qodercn `code=112` + `pricingUrl` 额度错误）。
 */
describe("流内业务错误帧：记失败 + 额度冷却", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  /** 读某个访问日志分桶（没有则空串）。日期用 log-store 的本地日期，不用 UTC。 */
  function bucket(name: string): string {
    const file = join(paths.logsDir(), "access", localDate(), `${name}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-streamerr-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    // 假上游改成回一个内嵌业务错误帧（qodercn 的 112 额度错误形态）
    upstream.server.removeAllListeners("request");
    upstream.server.on("request", (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ error: { code: "112", message: "{\"pricingUrl\":\"https://qoder.com.cn/pricing?client=qoder\"}" } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    clearChannels();
    registerErrorChannel("qoderish", true, ["deepseek-v4.1-flash"]);
    registerErrorChannel("freeish", false, ["glm-5.3-flash"]);
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  /**
   * 注册一个「上游只回 112 额度错误帧」的 custom 线型渠道。
   * `withBilling=false` 时渠道没有额度能力 → 模型按免费（×0）处理。
   */
  function registerErrorChannel(cid: string, withBilling: boolean, exposed: string[]): void {
    // 候选渠道由统一注册表声明（与线上同口径）
    registerChannelSupply(cid, exposed);
    const config: ChannelConfig = {
      cid,
      display: `Synth ${cid}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
      // 免费渠道 = 显式声明没有额度能力（`channelCapabilities` 缺省 true）
      ...(withBilling ? {} : { capabilities: { billing: false } }),
    };
    const load = (): Record<string, unknown> =>
      JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
    setChannel({
      config,
      cred: {
        DEFAULT_BASE_URL: upstream.url,
        NotLoggedInError: class NotLoggedInError extends Error {},
        load,
        save: async () => {},
        login: async () => load(),
        refresh: async () => { throw new Error("no refresh"); },
        resolveBaseUrl: () => upstream.url,
      },
      upstream: {
        DEFAULT_BASE_URL: upstream.url,
        WIRE: "custom" as const,
        DISPLAY_NAME: `Synth ${cid}`,
        UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
        chatUrl: () => `${upstream.url}/chat`,
        modelsUrl: () => `${upstream.url}/models`,
        buildHeaders: () => ({}),
        buildChatBody: (req: Record<string, unknown>) => req,
        fetchModels: async () => ({}),
        resolveConfig: () => ({ baseUrl: upstream.url }),
        // 渠道上报额度判据（对齐 qodercn 的 quotaSignal）
        quotaSignal: (_status: number, body: string) =>
          /pricingUrl|"code"\s*:\s*"?(?:110|112)\b/.test(body) ? "balance" : null,
        newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
      },
      catalog: { exposedIds: () => exposed, resolveModel: (n: string) => n },
      ...(withBilling ? { billing: { fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) } } : {}),
    } as unknown as Channel);
    seedAccount(cid);
    if (withBilling) poolUsage.writeBilling(cid, { total: { remain: 500, unit: "credits" } });
  }

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("流式：访问日志记 failure（不再是 success），且账号被冷却", async () => {
    const before = bucket("failure");
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(resp.status, 200, "SSE 响应头早已发出，状态码仍是 200");
    await resp.text();

    const after = bucket("failure");
    assert.notEqual(after, before, "应新落一条失败记录");
    assert.ok(after.includes("pricingUrl"), "失败记录带上游业务错误原文");
    assert.equal(activeAccountHealth("qoderish"), "cooldown", "额度类业务错误要冷却账号");
    // 账本也要记一笔失败：attempt 层在上游收下请求（HTTP 200）时就记过 ok，
    // 不补的话可靠性系数会被这类业务失败反向抬高
    assert.ok(
      (poolUsage.ledgerSnapshot().channels["qoderish"]?.fail ?? 0) > 0,
      "账本 fail 应 +1（与访问日志同结论）",
    );
  });

  it("免费（×0）模型：只记账不冷却账号（与既有铁律同口径）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(resp.status, 200);
    await resp.text();
    assert.equal(
      activeAccountHealth("freeish"),
      "ok",
      "免费模型不吃额度，不该因为额度样式的错误帧把账号锁死",
    );
    assert.ok(
      (poolUsage.ledgerSnapshot().channels["freeish"]?.fail ?? 0) > 0,
      "但失败仍要记账",
    );
  });

  it("非流式：同一条判据也要冷却账号（不能只修流式那条路）", async () => {
    // 上一条已把账号打进冷却 → 先恢复，否则这里会先被 429 短路
    markActiveHealth("ok", "qoderish");
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(resp.status, 502, "空聚合 + 上游错误帧 → 502 透传");
    const payload = (await resp.json()) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "112", "保真上游业务码");
    assert.ok(payload.error.message.includes("pricingUrl"), "保真上游原文");
    assert.equal(activeAccountHealth("qoderish"), "cooldown", "非流式同样冷却账号");
  });
});
