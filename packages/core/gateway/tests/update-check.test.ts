/**
 * 版本更新检测：版本比较、每日一次的真请求、标签回落、跳过 / 稍后。
 *
 * `fetch` 用 node:test 的 mock 注入 —— 不联网也能跑（真实网络失败时是静默回落）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import {
  checkForUpdate,
  isNewer,
  refreshUpdateNotice,
  skipUpdate,
  snoozeUpdate,
  updateNotice,
} from "../dist/runtime/update-check.js";

const root = mkdtempSync(join(tmpdir(), "modelmux-update-"));
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

/** 注入 fetch：按 URL 命中返回 {status, body}。 */
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

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
}

const RELEASE = { tag_name: "v0.1.4", body: "新增 todayai 渠道", html_url: "https://example.com/r/v0.1.4" };

describe("版本比较", () => {
  it("严格新于才为真（含不带 v 的写法）", () => {
    assert.equal(isNewer("v0.1.4", "v0.1.3"), true);
    assert.equal(isNewer("0.1.4", "v0.1.3"), true);
    assert.equal(isNewer("v0.2.0", "v0.1.9"), true);
  });

  it("相同 / 更旧 / 不合规都为假", () => {
    assert.equal(isNewer("v0.1.3", "v0.1.3"), false);
    assert.equal(isNewer("v0.1.2", "v0.1.3"), false);
    assert.equal(isNewer("abc", "v0.1.3"), false);
    assert.equal(isNewer("v0.1.4", "abc"), false);
  });
});

describe("检测", () => {
  it("有新版本：返回提示并落盘检查时间", async () => {
    mockFetch([{ match: "/releases/latest", status: 200, body: RELEASE }]);
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice);
    assert.equal(notice.version, "v0.1.4");
    assert.equal(notice.notes, "新增 todayai 渠道");
    assert.equal(notice.url, "https://example.com/r/v0.1.4");
    assert.ok(readState()["lastCheckAt"], "检查时间要落盘");
  });

  it("上游版本不更新 → null", async () => {
    mockFetch([{ match: "/releases/latest", status: 200, body: { ...RELEASE, tag_name: "v0.1.3" } }]);
    assert.equal(await checkForUpdate("0.1.3"), null);
  });

  it("24 小时内用缓存，不重复请求", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify(RELEASE), { status: 200 });
    });
    assert.ok(await checkForUpdate("0.1.3"));
    assert.ok(await checkForUpdate("0.1.3"));
    assert.equal(calls, 1, "第二次应命中缓存");
  });

  it("没有 Release 时回落标签（只有版本号）", async () => {
    mockFetch([
      { match: "/releases/latest", status: 404 },
      { match: "/tags", status: 200, body: [{ name: "v0.1.4" }] },
    ]);
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice);
    assert.equal(notice.version, "v0.1.4");
    assert.equal(notice.notes, "");
  });

  it("网络失败 → null（不误报「没有更新」）", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    assert.equal(await checkForUpdate("0.1.3"), null);
  });
});

describe("跳过 / 稍后", () => {
  it("跳过该版本后不再提示", async () => {
    mockFetch([{ match: "/releases/latest", status: 200, body: RELEASE }]);
    assert.ok(await checkForUpdate("0.1.3"));
    skipUpdate("v0.1.4");
    assert.equal(await checkForUpdate("0.1.3"), null, "缓存期内直接被跳过");
    assert.equal(readState()["skippedVersion"], "v0.1.4");
  });

  it("稍后提醒 = 今天不再提示（snoozedUntil 在未来 24h 内）", async () => {
    mockFetch([{ match: "/releases/latest", status: 200, body: RELEASE }]);
    assert.ok(await checkForUpdate("0.1.3"));
    snoozeUpdate();
    assert.equal(await checkForUpdate("0.1.3"), null);
    const until = new Date(String(readState()["snoozedUntil"])).getTime();
    assert.ok(until > Date.now() && until - Date.now() <= 24 * 60 * 60 * 1000);
  });

  it("snooze 过期后恢复提示", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        lastCheckAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        latest: { version: "v0.1.4", notes: "", url: "u" },
        snoozedUntil: new Date(Date.now() - 1000).toISOString(),
        skippedVersion: null,
      }),
    );
    mockFetch([{ match: "/releases/latest", status: 200, body: RELEASE }]);
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice, "snooze 过期 + 缓存过期 → 重新提示");
  });
});

describe("后台缓存", () => {
  it("refreshUpdateNotice 填充 updateNotice，skip 后清空", async () => {
    mockFetch([{ match: "/releases/latest", status: 200, body: RELEASE }]);
    await refreshUpdateNotice("0.1.3", () => {});
    assert.ok(updateNotice());
    skipUpdate("v0.1.4");
    assert.equal(updateNotice(), null);
  });
});
