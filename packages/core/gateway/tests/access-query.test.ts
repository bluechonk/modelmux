/**
 * 控制台日志页的读回与请求正文抓取：读窗口边界、过滤/分页/统计口径、
 * 以及抓包开关的开与关。
 *
 * 全程在 mkdtemp 的临时存储根下进行，绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  attachRequestLog,
  localDate,
  noteClientPayload,
  noteUpstreamPayload,
  payloadCaptureEnabled,
  queryAccessLogs,
  readPayloads,
  setPayloadCaptureEnabled,
} from "../dist/runtime/log-store.js";
import * as paths from "../dist/runtime/paths.js";

/** 假响应：访问日志上下文只需要 `once` / `statusCode` / `setHeader`。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  setHeader(): void {
    this.headersSent = true;
  }
}

/** 挂在假响应上的请求日志（抓取与查询都以它的 `id` 为钥匙）。 */
function attach(path = "/v1/chat/completions"): { res: FakeRes; id: string } {
  const res = new FakeRes();
  const log = attachRequestLog("POST", path, res as never);
  return { res, id: log.id };
}

/**
 * 写一条访问日志夹具。
 *
 * ⚠ 日期必须取 log-store 导出的 `localDate()`（**本地时区**）：用
 * `toISOString().slice(0,10)`（UTC）会在 UTC+8 的凌晨差一天，测试去读前一天的目录。
 */
function writeAccess(
  outcome: "success" | "failure" | "other" | "slow",
  records: Array<Record<string, unknown>>,
  rotated = 0,
): void {
  const dir = join(paths.logsDir(), "access", localDate());
  mkdirSync(dir, { recursive: true });
  const suffix = rotated > 0 ? `.${rotated}.log` : "";
  const file = join(dir, `${outcome}.log${suffix}`);
  writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-10-28T04:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    startAt: 1,
    id: `req_${Math.random().toString(16).slice(2, 18)}`,
    model: "loomy/kimi-k2.6",
    cid: "loomy",
    stream: true,
    status: 200,
    outcome: "success",
    durationMs: 1200,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    ...over,
  };
}

describe("访问日志读回", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-logs-"));
    process.env["MODELMUX_HOME"] = root;
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(join(paths.logsDir(), "access"), { recursive: true, force: true });
  });

  it("无任何日志时返回空页，且不编造日期", () => {
    const page = queryAccessLogs();
    assert.equal(page.date, "");
    assert.equal(page.total, 0);
    assert.deepEqual(page.entries, []);
    assert.deepEqual(page.dates, []);
  });

  it("指定一个没有数据的日期时回落到最新有数据的日期", () => {
    writeAccess("success", [entry()]);
    const page = queryAccessLogs({ date: "1999-01-01" });
    assert.equal(page.date, localDate());
    assert.equal(page.total, 1);
  });

  it("slow.log 是并行副本，不能造成重复行", () => {
    const slow = entry({ durationMs: 40_000, status: 200 });
    writeAccess("success", [slow]);
    writeAccess("slow", [slow]);
    const page = queryAccessLogs();
    assert.equal(page.entries.length, 1, "同一请求只应出现一次");
    assert.equal(page.entries[0]?.slow, true, "慢请求要按 durationMs 判定并打标");
    assert.equal(page.stats.slow, 1);
  });

  it("轮转文件（当天前半段）也要读到，并按时间倒序", () => {
    writeAccess("success", [entry({ ts: "2026-10-28T01:00:00.000Z", id: "req_oldest" })], 2);
    writeAccess("success", [entry({ ts: "2026-10-28T02:00:00.000Z", id: "req_middle" })], 1);
    writeAccess("success", [entry({ ts: "2026-10-28T03:00:00.000Z", id: "req_newest" })]);
    const ids = queryAccessLogs().entries.map((e) => e.id);
    assert.deepEqual(ids, ["req_newest", "req_middle", "req_oldest"]);
  });

  it("坏行（并发追加导致的半行）被跳过，不影响其余行", () => {
    const dir = join(paths.logsDir(), "access", localDate());
    writeAccess("success", [entry({ id: "req_good" })]);
    writeFileSync(join(dir, "success.log"), `${JSON.stringify(entry({ id: "req_good" }))}\n{"broken":\n`, "utf8");
    const page = queryAccessLogs();
    assert.equal(page.total, 1);
    assert.equal(page.entries[0]?.id, "req_good");
  });

  it("失败镜像（error.log）不参与列表，避免与 failure.log 重复", () => {
    writeAccess("failure", [entry({ status: 502, outcome: "failure", error: "upstream_error" })]);
    const dir = join(paths.logsDir(), "error", localDate());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "error.log"), `${JSON.stringify({ request_id: "req_x" })}\n`, "utf8");
    const page = queryAccessLogs();
    assert.equal(page.total, 1);
    assert.equal(page.entries[0]?.outcome, "failure");
  });

  it("过滤：结果 / 渠道 / 模型子串 / 流式 / 慢 / 关键词", () => {
    writeAccess("success", [
      entry({ id: "req_a", cid: "loomy", model: "loomy/kimi-k2.6", stream: true }),
    ]);
    writeAccess("failure", [
      entry({
        id: "req_b",
        cid: "catpaw",
        model: "catpaw/glm-5.3-flash",
        stream: false,
        status: 502,
        outage: true,
        error: "upstream_error",
      }),
    ]);
    assert.deepEqual(queryAccessLogs({ outcome: "failure" }).entries.map((e) => e.id), ["req_b"]);
    assert.deepEqual(queryAccessLogs({ cid: "loomy" }).entries.map((e) => e.id), ["req_a"]);
    // 模型子串不区分大小写
    assert.deepEqual(queryAccessLogs({ model: "GLM-5.3" }).entries.map((e) => e.id), ["req_b"]);
    assert.deepEqual(queryAccessLogs({ stream: true }).entries.map((e) => e.id), ["req_a"]);
    // 关键词命中 id / error
    assert.deepEqual(queryAccessLogs({ q: "upstream_error" }).entries.map((e) => e.id), ["req_b"]);
    assert.deepEqual(queryAccessLogs({ q: "req_a" }).entries.map((e) => e.id), ["req_a"]);
  });

  it("统计基于未过滤窗口，total 才是筛选后的条数", () => {
    writeAccess("success", [entry({ id: "req_s1" }), entry({ id: "req_s2" })]);
    writeAccess("failure", [entry({ id: "req_f1", status: 500, outcome: "failure" })]);
    const page = queryAccessLogs({ outcome: "failure" });
    assert.equal(page.total, 1, "total 是命中筛选的条数");
    assert.equal(page.stats.requests, 3, "统计描述当天窗口，不随筛选变化");
    assert.equal(page.stats.success, 2);
    assert.equal(page.stats.failure, 1);
    assert.equal(page.stats.tokens.total, 90, "三条各 30");
  });

  it("渠道下拉数据来自未过滤窗口，不随筛选消失", () => {
    writeAccess("success", [entry({ id: "req_a", cid: "loomy" })]);
    writeAccess("failure", [entry({ id: "req_b", cid: "catpaw", status: 500, outcome: "failure" })]);
    const page = queryAccessLogs({ cid: "loomy" });
    assert.deepEqual(page.cids, ["catpaw", "loomy"]);
  });

  it("分页：limit / offset", () => {
    writeAccess(
      "success",
      [0, 1, 2, 3, 4].map((i) =>
        entry({ id: `req_${i}`, ts: `2026-10-28T0${i}:00:00.000Z` }),
      ),
    );
    const first = queryAccessLogs({ limit: 2 });
    assert.deepEqual(first.entries.map((e) => e.id), ["req_4", "req_3"]);
    const second = queryAccessLogs({ limit: 2, offset: 2 });
    assert.deepEqual(second.entries.map((e) => e.id), ["req_2", "req_1"]);
    assert.equal(second.total, 5);
  });

  it("缺 model / usage 的行照样能读（400/404 类请求只有路径）", () => {
    writeAccess("failure", [
      { ts: "2026-10-28T05:00:00.000Z", id: "req_plain", method: "GET", path: "/favicon.ico", status: 404, outcome: "failure" },
    ]);
    const page = queryAccessLogs();
    const row = page.entries[0];
    assert.equal(row?.id, "req_plain");
    assert.equal(row?.path, "/favicon.ico", "缺 model 时靠 path 兜底展示");
    assert.equal(row?.method, "GET");
    assert.equal(row?.model, undefined);
    assert.equal(row?.tokens, null);
    assert.equal(page.stats.noUsage, 1);
  });

  it("usage 键名兼容 input/output 命名", () => {
    writeAccess("success", [
      entry({ id: "req_alt", usage: { input_tokens: 7, output_tokens: 3 } }),
    ]);
    const tokens = queryAccessLogs().entries[0]?.tokens;
    assert.deepEqual(tokens, { prompt: 7, completion: 3, total: 10 });
  });

  it("单文件超出尾部字节上限时回报 truncated", () => {
    const filler = (i: number): Record<string, unknown> =>
      entry({ id: `req_pad${i}`, message: "x".repeat(900) });
    writeAccess("success", Array.from({ length: 1500 }, (_, i) => filler(i)));
    const page = queryAccessLogs({ limit: 1 });
    assert.equal(page.truncated, true, "超出窗口必须如实标注，不能假装是全量");
    assert.equal(page.entries.length, 1);
  });
});

describe("请求正文抓取（默认开启，偏好落盘）", () => {
  let root: string;
  let saved: string | undefined;
  let savedMax: string | undefined;
  let savedCids: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-payload-"));
    process.env["MODELMUX_HOME"] = root;
    savedMax = process.env["MODELMUX_LOG_PAYLOAD_MAX_BYTES"];
    savedCids = process.env["MODELMUX_LOG_PAYLOAD_CIDS"];
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    restoreEnv("MODELMUX_LOG_PAYLOAD_MAX_BYTES", savedMax);
    restoreEnv("MODELMUX_LOG_PAYLOAD_CIDS", savedCids);
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    // 开关走**偏好文件**（不是环境变量）：每个用例先把开关与上限/白名单复位到默认。
    setPayloadCaptureEnabled(true);
    delete process.env["MODELMUX_LOG_PAYLOAD_MAX_BYTES"];
    delete process.env["MODELMUX_LOG_PAYLOAD_CIDS"];
  });

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it("默认开启：不配置就抓，读回能拿到记录", () => {
    assert.equal(payloadCaptureEnabled(), true, "默认开启");
    const { res, id } = attach();
    noteClientPayload(res as never, Buffer.from('{"messages":[]}', "utf8"));
    const result = readPayloads(id);
    assert.equal(result.enabled, true);
    assert.equal(result.records.length, 1);
  });

  it("开关落盘：写盘后重读一致（重启保持的前提）", () => {
    setPayloadCaptureEnabled(false);
    assert.equal(payloadCaptureEnabled(), false);
    setPayloadCaptureEnabled(true);
    assert.equal(payloadCaptureEnabled(), true);
  });

  it("关掉开关：不再新增，已落盘的记录仍能读回", () => {
    const { res, id } = attach();
    noteUpstreamPayload(res as never, { cid: "loomy", model: "m", stream: false, attempt: 0 }, "kept");
    setPayloadCaptureEnabled(false);
    const { res: resOff, id: idOff } = attach();
    noteClientPayload(resOff as never, Buffer.from("{}", "utf8"));
    assert.deepEqual(readPayloads(idOff).records, [], "关闭后不再新增");
    const kept = readPayloads(id);
    assert.equal(kept.enabled, false, "开关状态如实回报");
    assert.deepEqual(kept.records.map((r) => r.body), ["kept"], "已落盘的记录不该被藏起来");
  });

  it("开启后按 id 读回客户端原样体与每次尝试的上行体，顺序稳定", () => {
    setPayloadCaptureEnabled(true);
    const { res, id } = attach();
    noteClientPayload(res as never, Buffer.from('{"model":"loomy/kimi-k2.6","messages":[]}', "utf8"));
    noteUpstreamPayload(res as never, { cid: "loomy", model: "loomy/kimi-k2.6", stream: true, attempt: 0 }, Buffer.from("{\"up\":1}", "utf8"));
    noteUpstreamPayload(res as never, { cid: "catpaw", model: "catpaw/glm-5.3-flash", stream: true, attempt: 1 }, Buffer.from("{\"up\":2}", "utf8"));
    const result = readPayloads(id);
    assert.equal(result.enabled, true);
    assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map((r) => r.phase), ["client", "upstream", "upstream"]);
    assert.deepEqual(result.records.map((r) => r.attempt), [undefined, 0, 1]);
    assert.equal(result.records[0]?.body, '{"model":"loomy/kimi-k2.6","messages":[]}');
    assert.equal(result.records[2]?.cid, "catpaw");
  });

  it("上游还没回就失败时，正文照样读得到（写盘在 fetch 之前）", () => {
    setPayloadCaptureEnabled(true);
    const { res, id } = attach();
    noteUpstreamPayload(res as never, { cid: "traecn", model: "traecn/kimi-k2.6", stream: false, attempt: 0 }, "encoded-body");
    const result = readPayloads(id);
    assert.equal(result.records[0]?.body, "encoded-body", "字符串体（自编码渠道）原样可读");
    assert.equal(result.records[0]?.bytes, 12);
  });

  it("超出单条上限时截断并打标，bytes 仍是原始长度", () => {
    setPayloadCaptureEnabled(true);
    process.env["MODELMUX_LOG_PAYLOAD_MAX_BYTES"] = "16";
    const { res, id } = attach();
    noteClientPayload(res as never, Buffer.from("0123456789abcdefghij", "utf8"));
    const rec = readPayloads(id).records[0];
    assert.equal(rec?.truncated, true);
    assert.equal(rec?.bytes, 20, "bytes 记录原始长度，不是截断后的长度");
    assert.equal(rec?.body.length, 16);
  });

  it("渠道白名单：未列入的渠道不落盘", () => {
    setPayloadCaptureEnabled(true);
    process.env["MODELMUX_LOG_PAYLOAD_CIDS"] = "loomy";
    const { res, id } = attach();
    noteUpstreamPayload(res as never, { cid: "catpaw", model: "m", stream: false, attempt: 0 }, "nope");
    assert.deepEqual(readPayloads(id).records, []);
    noteUpstreamPayload(res as never, { cid: "loomy", model: "m", stream: false, attempt: 0 }, "yes");
    assert.deepEqual(readPayloads(id).records.map((r) => r.body), ["yes"]);
  });

  it("未挂访问日志上下文的响应不会写（没有 id 就没有可对齐的钥匙）", () => {
    setPayloadCaptureEnabled(true);
    const bare = new FakeRes();
    noteClientPayload(bare as never, Buffer.from("{}", "utf8"));
    // 没有 id 时无从查询，只要不抛异常即可
    assert.deepEqual(readPayloads("req_missing").records, []);
  });
});
