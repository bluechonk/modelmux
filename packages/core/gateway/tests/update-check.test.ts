/**
 * 版本更新检测：版本比较、每日一次的真请求、tags 取最大版本、Latest 下载入口。
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

/** tags 列表路由（只匹配 tags，不误命中 release 路径）。 */
const tagsOk = (names: string[]) => ({
  match: "modelmux/tags",
  status: 200,
  body: names.map((name) => ({ name })),
});

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
  it("有新版本：取版本与 Latest 下载入口并落盘检查时间", async () => {
    mockFetch([tagsOk(["v0.1.3", "v0.1.4"])]);
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice);
    assert.equal(notice.version, "v0.1.4");
    assert.equal(notice.url, "https://github.com/bluechonk/modelmux/releases/latest");
    assert.equal("notes" in notice, false, "小卡只报版本号与入口，不抓发布说明");
    assert.ok(readState()["lastCheckAt"], "检查时间要落盘");
  });

  it("取语义版本最大者，而不是 tags 的第一项", async () => {
    // tags 的默认顺序是推送时间，先 v0.1.4 后 v0.1.5 是常见情形
    mockFetch([tagsOk(["v0.1.4", "v0.1.5"])]);
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice);
    assert.equal(notice.version, "v0.1.5");
    assert.equal(notice.url, "https://github.com/bluechonk/modelmux/releases/latest");
  });

  it("上游版本不更新 → null", async () => {
    mockFetch([tagsOk(["v0.1.3"])]);
    assert.equal(await checkForUpdate("0.1.3"), null);
  });

  it("24 小时内用缓存，不重复请求", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify([{ name: "v0.1.4" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    assert.ok(await checkForUpdate("0.1.3"));
    assert.ok(await checkForUpdate("0.1.3"));
    assert.equal(calls, 1, "只查 tags 一次；第二轮命中缓存不再请求");
  });

  it("网络失败不误报「没有更新」：保留上次检测到的新版本", async () => {
    mockFetch([tagsOk(["v0.1.4"])]);
    assert.ok(await checkForUpdate("0.1.3"), "先成功检出 v0.1.4");
    // 让缓存过期后断网：失败必须回落上次结果，而不是抹掉它
    const state = readState();
    state["lastCheckAt"] = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    writeFileSync(stateFile, JSON.stringify(state));
    mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice, "网络失败不得把已检测到的新版本抹掉（那是「误报没有更新」）");
    assert.equal(notice.version, "v0.1.4");
    assert.equal((readState()["latest"] as { version?: string }).version, "v0.1.4", "latest 要保留");
  });

  it("旧状态文件里的 snoozedUntil / skippedVersion 遗留字段被忽略", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        lastCheckAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
        latest: { version: "v0.1.4", url: "u" },
        snoozedUntil: new Date(Date.now() + 86400 * 1000).toISOString(),
        skippedVersion: "v0.1.4",
      }),
    );
    mockFetch([tagsOk(["v0.1.4"])]);
    const notice = await checkForUpdate("0.1.3");
    assert.ok(notice, "跳过 / 稍后已下线：遗留字段不得再压制提示");
    const state = readState();
    assert.equal(state["snoozedUntil"], undefined, "重新落盘后遗留字段消失");
    assert.equal(state["skippedVersion"], undefined);
  });
});

describe("后台缓存", () => {
  it("refreshUpdateNotice 填充 updateNotice", async () => {
    mockFetch([tagsOk(["v0.1.4"])]);
    await refreshUpdateNotice("0.1.3", () => {});
    assert.ok(updateNotice());
  });
});
