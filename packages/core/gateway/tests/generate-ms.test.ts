/**
 * 生成窗口 `generateMs` 的打点与落盘（TPS 分母的口径保障）。
 *
 * 回归（2026-10-30）：非流式的 `ttfbMs` 是「聚合完成」时刻、≈ `durationMs`，旧 TPS 公式
 * 把 76 tokens/1309ms 算成 76000 t/s。本文件锁两条：① `generateMs` = 首帧→末帧，只有一个
 * 内容帧时不落该字段（测不到 ≠ 0）；② 非流式走完转发层后 `generateMs` 显著小于 `durationMs`。
 *
 * 全程离线：合成渠道 + 假上游流 + 假响应对象，落盘到 mkdtemp 临时存储根。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  attachRequestLog,
  finishRequestLog,
  noteFirstFrame,
  noteLastFrame,
} from "../dist/runtime/log-store.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { relayUpstream } from "../dist/http/chat/forward.js";
import type { UpstreamCall } from "../dist/http/chat/upstream.js";
import * as paths from "../dist/runtime/paths.js";

const savedHome = process.env["MODELMUX_HOME"];
let dir = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "modelmux-generate-ms-"));
  process.env["MODELMUX_HOME"] = dir;
});

after(() => {
  if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedHome;
  clearChannels();
  rmSync(dir, { recursive: true, force: true });
});

/** 假响应：转发层用到的接口 + `attachRequestLog` 需要的 EventEmitter 能力。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  headersSent = false;
  readonly chunks: string[] = [];

  setHeader(): void {
    this.headersSent = true;
  }

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  get body(): string {
    return this.chunks.join("");
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 合成渠道：custom 线型 + 把每个上游块原样当一帧（够验证打点）。 */
function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: "Generate Ms Test",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "GENERATE_MS_DUMP",
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: "t" }),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: "Generate Ms Test",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({ Authorization: "Bearer t" }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      idleTimeoutMs: () => 5_000,
      // 每块原样产出为一个帧（带 usage 的那块由用例自己构造）
      newTranslator: () => ({
        feed: (chunk: Buffer) => [chunk],
        finish: () => [],
        idleCutoffAfterContentMs: () => 5_000,
      }),
    },
    catalog: { exposedIds: () => ["test-model"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 上游流：每 `gapMs` 吐一块，共 `count` 块。 */
function trickle(count: number, gapMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i >= count) {
        ctrl.close();
        return;
      }
      i += 1;
      await sleep(gapMs);
      ctrl.enqueue(encoder.encode(`data: {"i":${i}}\n\n`));
    },
  });
}

/** 读某日 access 日志里的全部记录。 */
function readAccess(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let dates: string[];
  try {
    dates = readdirSync(join(paths.logsDir(), "access"));
  } catch {
    return out;
  }
  for (const date of dates) {
    for (const outcome of ["success", "failure", "other"]) {
      let text: string;
      try {
        text = readFileSync(join(paths.logsDir(), "access", date, `${outcome}.log`), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return out;
}

describe("generateMs 打点", () => {
  it("首帧→末帧的差值落盘；两个中间时刻不落盘", async () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    log.model = "test/generate-ms";
    noteFirstFrame(res as never);
    await sleep(40);
    noteLastFrame(res as never);
    noteLastFrame(res as never); // 覆盖式：多次调用取最后一次
    finishRequestLog(log, 200);

    const rows = readAccess().filter((r) => r["model"] === "test/generate-ms");
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.ok(typeof row["generateMs"] === "number", "generateMs 必须落盘");
    assert.ok((row["generateMs"] as number) >= 30, `窗口应约 40ms，实测 ${row["generateMs"]}ms`);
    assert.equal(row["firstFrameAt"], undefined, "中间时刻不落盘");
    assert.equal(row["lastFrameAt"], undefined, "中间时刻不落盘");
  });

  it("只有一个内容帧时不落 generateMs（测不到 ≠ 0 毫秒）", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    log.model = "test/single-frame";
    noteFirstFrame(res as never);
    // 不打末帧
    finishRequestLog(log, 200);

    const rows = readAccess().filter((r) => r["model"] === "test/single-frame");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["generateMs"], undefined);
  });

  it("非流式请求走完转发层：generateMs 显著小于 durationMs（旧 ttfb 打点会等于它）", async () => {
    const cid = "gentest";
    const channel = makeChannel(cid);
    setChannel(channel);

    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    log.model = `${cid}/test-model`;
    log.cid = cid;
    log.stream = false;

    const call: UpstreamCall = {
      url: "http://127.0.0.1:1/chat",
      init: {},
      // 8 块 × 30ms ≈ 240ms 的吐字窗口
      body: trickle(8, 30),
    } as unknown as UpstreamCall;

    await relayUpstream(res as never, channel, cid, call, {
      wantStream: false,
      logger: () => {},
    });
    finishRequestLog(log, res.statusCode);

    const rows = readAccess().filter((r) => r["model"] === `${cid}/test-model`);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    const generateMs = row["generateMs"] as number | undefined;
    const durationMs = row["durationMs"] as number;
    assert.ok(typeof generateMs === "number", "非流式也要有 generateMs（否则 TPS 只能显示 —）");
    // 吐字窗口 ~240ms；总耗时至少也含它，但关键判据是「不再等于总耗时」
    assert.ok(generateMs >= 150, `生成窗口应接近吐字时长（实测 ${generateMs}ms）`);
    assert.ok(
      generateMs < durationMs,
      `generateMs(${generateMs}) 必须小于 durationMs(${durationMs}) —— 相等说明打点退化成了聚合完成时刻`,
    );
  });
});
