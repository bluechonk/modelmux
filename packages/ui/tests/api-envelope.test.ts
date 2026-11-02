/**
 * 命令信封解包（`api.command`）的回归网。
 *
 * 后端统一信封是 `{ ok, data?, message?, error? }`，调用方拿到的必须是解包后的
 * 扁平对象 —— 早期把整个信封返回，页面按 `res.channels` 读而实际在
 * `res.data.channels`，全页面显示「（无渠道）」（实测踩过）。
 *
 * `command` 走全局 `fetch`（node:test 里桩掉），`IS_DEMO` 在 node 环境未定义 → 走真实分支。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { api } from "../src/lib/api.ts";

type FetchCall = { url: string; body: Record<string, unknown> };

const calls: FetchCall[] = [];
let respond: (url: string, body: Record<string, unknown>) => unknown = () => ({ ok: true });

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, body });
    return {
      ok: true,
      json: async () => respond(url, body),
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  calls.length = 0;
});

describe("command 信封解包", () => {
  it("data 摊平到顶层：res.channels 直接可读（旧 bug 的回归网）", async () => {
    install();
    respond = () => ({ ok: true, data: { channels: [{ cid: "raccoon" }], total: 1 } });
    const res = (await api.commands.status("raccoon")) as Record<string, unknown>;
    assert.deepEqual(res.channels, [{ cid: "raccoon" }]);
    assert.equal(res.total, 1);
    assert.equal(res.ok, true);
  });

  it("ok / message / error 与 data 字段平级保留", async () => {
    install();
    respond = () => ({ ok: false, data: { done: 1 }, error: "boom" });
    const res = (await api.commands.billing("raccoon")) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, "boom");
    assert.equal(res.done, 1);
  });

  it("请求体形态：action/args 独立字段，cid 在顶层（扁平拼参会被后端静默丢弃）", async () => {
    install();
    respond = () => ({ ok: true, data: {} });
    await api.commands.login("loomy", true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/web/api/commands");
    const body = calls[0]!.body;
    assert.equal(body["action"], "login");
    assert.equal(body["cid"], "loomy");
    assert.deepEqual(body["args"], { force: true });
  });

  it("data 不是对象（数组 / null）时不炸，只保留信封字段", async () => {
    install();
    respond = () => ({ ok: true, data: [1, 2] });
    const res = (await api.commands.syncPool("raccoon")) as Record<string, unknown>;
    assert.equal(res.ok, true);
    assert.equal("channels" in res, false);
  });
});
