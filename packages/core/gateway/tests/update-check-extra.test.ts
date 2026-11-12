/**
 * 版本更新检测的失败分支与后台调度。
 *
 * 只补既有 update-check.test.ts 未覆盖的行：tags 失败、tags 无有效版本、
 * release 地址查询失败、以及 startUpdateChecks 的启动即跑 + 定时器 unref。
 *
 * fetch 用 node:test 的 mock 注入，不联网。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import {
  checkForUpdate,
  startUpdateChecks,
  updateNotice,
} from "../dist/runtime/update-check.js";

const root = mkdtempSync(join(tmpdir(), "modelmux-update-extra-"));
const stateFile = join(root, "update.json");

before(() => {
  process.env["MODELMUX_HOME"] = root;
});
after(() => {
  delete process.env["MODELMUX_HOME"];
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(stateFile, { force: true });
});

/** 注入 fetch：按 URL 命中返回 {status, body}，未命中 404。 */
function mockFetch(routes: Array<{ match: string; status: number; body?: unknown }>): void {
  mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return new Response("", { status: 404 });
    return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** 轮询等条件成立（后台调度是异步的）。 */
async function waitFor(ok: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("更新检测的失败分支", () => {
  it("tags 非 200：记录原因并返回 null", async () => {
    mockFetch([{ match: "modelmux/tags", status: 500 }]);
    const logs: string[] = [];
    const notice = await checkForUpdate("0.1.3", (m) => logs.push(m));
    assert.equal(notice, null);
    assert.ok(logs.some((m) => m.includes("tags 请求失败")), "失败原因要留痕");
  });

  it("tags 返回空列表 / 项无 name：返回 null", async () => {
    mockFetch([{ match: "modelmux/tags", status: 200, body: [] }]);
    assert.equal(await checkForUpdate("0.1.3"), null);

    mockFetch([{ match: "modelmux/tags", status: 200, body: [{ notName: "v0.1.4" }, { name: "" }] }]);
    assert.equal(await checkForUpdate("0.1.3"), null);
  });

  it("release 地址查询非 404 失败：记录原因，仍返回版本 + 列表页地址", async () => {
    mockFetch([
      { match: "modelmux/tags", status: 200, body: [{ name: "v0.1.4" }] },
      { match: "/releases/tags/v0.1.4", status: 500 },
    ]);
    const logs: string[] = [];
    const notice = await checkForUpdate("0.1.3", (m) => logs.push(m));
    assert.ok(notice);
    assert.equal(notice.version, "v0.1.4");
    assert.equal(notice.url, "https://github.com/bluechonk/modelmux/releases");
    assert.ok(logs.some((m) => m.includes("release 请求失败")), "失败原因要留痕");
  });

  it("release 地址查询抛错：回落列表页，不中断检测", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("modelmux/tags")) {
        return new Response(JSON.stringify([{ name: "v0.1.4" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("dns");
    });
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice);
    assert.equal(notice.version, "v0.1.4");
    assert.equal(notice.url, "https://github.com/bluechonk/modelmux/releases");
  });
});

describe("后台调度", () => {
  it("startUpdateChecks 启动即跑一轮并填充缓存", async () => {
    mockFetch([
      { match: "modelmux/tags", status: 200, body: [{ name: "v0.1.4" }] },
      { match: "/releases/tags/v0.1.4", status: 200, body: { html_url: "https://example.com/r/v0.1.4" } },
    ]);
    startUpdateChecks(() => "0.1.3", () => {});
    await waitFor(() => updateNotice() !== null, 3_000, "updateNotice to be filled");
    assert.equal(updateNotice()?.["version"], "v0.1.4");
  });
});
