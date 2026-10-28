/**
 * 账号池的渠道展示排序：**用得多在前，同频按 cid 字典序**。
 *
 * 规则见 docs/POOL-ARCHITECTURE.md §2.2（频率 = 账本 `ok + fail`）与 docs/WEB-CONSOLE.md 的账号池行。
 * 全程离线：只用临时存储根里的账本，不注册渠道、不发任何请求 —— 排序是纯展示逻辑，
 * 与路由无关（路由仍由池 id 的 `<cid>/` 前缀决定）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  noteFailure,
  noteSuccess,
  resetPoolLedgerForTest,
  sortChannelsByUsage,
  usageOf,
} from "../dist/pool/pool-usage.js";

/** 造一批渠道对象（排序只看 cid，其余字段原样带回）。 */
const pools = (...cids: string[]): Array<{ cid: string; display: string }> =>
  cids.map((cid) => ({ cid, display: cid.toUpperCase() }));

const orderOf = (items: Array<{ cid: string }>): string[] => items.map((i) => i.cid);

describe("渠道展示排序（账号池）", () => {
  let root = "";
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-channel-order-"));
    process.env["MODELMUX_HOME"] = root;
    resetPoolLedgerForTest();
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    resetPoolLedgerForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("一次都没调用过 → 纯 cid 字典序（不是注册顺序）", () => {
    resetPoolLedgerForTest();
    // 入参故意乱序：结果必须是字典序，说明排序真生效（而不是「恰好等于入参顺序」）
    assert.deepEqual(
      orderOf(sortChannelsByUsage(pools("workbuddy", "astudio", "qoder", "catpaw"))),
      ["astudio", "catpaw", "qoder", "workbuddy"],
    );
  });

  it("有调用 → 使用频率降序", () => {
    resetPoolLedgerForTest();
    for (let i = 0; i < 3; i += 1) noteSuccess("catpaw");
    for (let i = 0; i < 9; i += 1) noteSuccess("qoder");
    assert.equal(usageOf("catpaw"), 3);
    assert.equal(usageOf("qoder"), 9);
    assert.deepEqual(
      orderOf(sortChannelsByUsage(pools("astudio", "catpaw", "qoder"))),
      ["qoder", "catpaw", "astudio"],
      "用得多的在前，没用过的（0 次）沉到后面",
    );
  });

  it("频率相同 → 回到 cid 字典序", () => {
    resetPoolLedgerForTest();
    for (let i = 0; i < 5; i += 1) noteSuccess("traecn");
    for (let i = 0; i < 5; i += 1) noteSuccess("loomy");
    for (let i = 0; i < 5; i += 1) noteSuccess("astudio");
    assert.deepEqual(
      orderOf(sortChannelsByUsage(pools("traecn", "loomy", "astudio"))),
      ["astudio", "loomy", "traecn"],
      "三者同频（各 5 次）→ 纯字母序",
    );
  });

  it("使用过的渠道排在没用过的前面（0 次沉底）", () => {
    resetPoolLedgerForTest();
    noteSuccess("traecn");
    assert.deepEqual(
      orderOf(sortChannelsByUsage(pools("astudio", "qoder", "traecn"))),
      ["traecn", "astudio", "qoder"],
      "traecn 用过一次 → 置顶；其余 0 次按字母",
    );
  });

  it("失败也计入频率（失败的请求同样是「用过这个渠道」）", () => {
    resetPoolLedgerForTest();
    noteSuccess("astudio");
    for (let i = 0; i < 4; i += 1) noteFailure("workbuddy");
    assert.equal(usageOf("workbuddy"), 4, "ok + fail");
    assert.deepEqual(
      orderOf(sortChannelsByUsage(pools("astudio", "workbuddy"))),
      ["workbuddy", "astudio"],
    );
  });

  it("不改动入参数组（返回副本；UI 可能持有原引用）", () => {
    resetPoolLedgerForTest();
    noteSuccess("qoder");
    const input = pools("astudio", "qoder");
    const sorted = sortChannelsByUsage(input);
    assert.deepEqual(orderOf(input), ["astudio", "qoder"], "原数组顺序不变");
    assert.deepEqual(orderOf(sorted), ["qoder", "astudio"]);
  });

  it("账本里没有该渠道时按 0 次处理（不抛错）", () => {
    resetPoolLedgerForTest();
    assert.equal(usageOf("never-used"), 0);
    assert.deepEqual(orderOf(sortChannelsByUsage(pools("zzz", "aaa"))), ["aaa", "zzz"]);
  });
});
