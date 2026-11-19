/**
 * API key 管理：新建/校验/白名单/限流/删除闭环。
 *
 * 全程临时 MODELMUX_HOME（fs 形态），不碰真实存储；不 mock 任何 IO —— 落盘语义
 * （哈希不落明文）本身就是要验的部分。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  createApiKey,
  deleteApiKey,
  installApiKeyGuard,
  listApiKeys,
  updateApiKey,
} from "../dist/runtime/api-key-store.js";
import { apiKeyGuard } from "../dist/runtime/api-key.js";

let root = "";
let savedHome: string | undefined;

before(() => {
  savedHome = process.env["MODELMUX_HOME"];
  root = mkdtempSync(join(tmpdir(), "modelmux-apikeys-"));
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例从空表开始（文件与进程内计数都清）
  for (const k of listApiKeys()) deleteApiKey(k.id);
  installApiKeyGuard(false);
});

describe("API key 存储", () => {
  it("新建：明文一次性返回，落盘只有哈希与前缀", () => {
    const { record, plain } = createApiKey({ name: "ci", allowedModels: [], rpmLimit: 0 });
    assert.ok(plain.startsWith("mmx_"));
    assert.equal(record.prefix, plain.slice(0, 12));
    const raw = readFileSync(join(root, "api-keys.json"), "utf8");
    assert.ok(!raw.includes(plain), "明文不能出现在落盘文件里");
    assert.ok(raw.includes(record.keyHash));
  });

  it("白名单去重与去空；rpm 负数归零", () => {
    const { record } = createApiKey({
      name: "multi",
      allowedModels: ["a", "a", " ", "b"],
      rpmLimit: -5,
    });
    assert.deepEqual(record.allowedModels, ["a", "b"]);
    assert.equal(record.rpmLimit, 0);
  });

  it("更新与删除", () => {
    const { record } = createApiKey({ name: "tmp", allowedModels: [], rpmLimit: 0 });
    const next = updateApiKey(record.id, { name: "renamed", allowedModels: ["m"], rpmLimit: 7 });
    assert.equal(next?.name, "renamed");
    assert.deepEqual(next?.allowedModels, ["m"]);
    assert.equal(next?.rpmLimit, 7);
    assert.equal(deleteApiKey(record.id), true);
    assert.equal(deleteApiKey(record.id), false, "重复删除如实返回 false");
    assert.equal(listApiKeys().length, 0);
  });
});

describe("API key 校验", () => {
  it("未装配 guard → 不校验（本机默认形态）", async () => {
    installApiKeyGuard(false);
    assert.equal(apiKeyGuard(), null);
  });

  it("缺 key / 错 key → invalid", async () => {
    installApiKeyGuard(true);
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(null, "m")).ok, false);
    assert.equal((await guard.check("mmx_nope", "m")).ok, false);
  });

  it("白名单：空数组放行全部，非空只放行列出的", async () => {
    const all = createApiKey({ name: "all", allowedModels: [], rpmLimit: 0 });
    const one = createApiKey({ name: "one", allowedModels: ["m1"], rpmLimit: 0 });
    installApiKeyGuard(true);
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(all.plain, "anything")).ok, true);
    assert.equal((await guard.check(one.plain, "m1")).ok, true);
    const denied = await guard.check(one.plain, "m2");
    assert.equal(denied.ok, false);
    assert.equal(denied.ok === false ? denied.reason : "", "forbidden");
  });

  it("rpm 上限：第 N+1 次 rate_limited", async () => {
    const { plain } = createApiKey({ name: "rl", allowedModels: [], rpmLimit: 2 });
    installApiKeyGuard(true);
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(plain, "m")).ok, true);
    assert.equal((await guard.check(plain, "m")).ok, true);
    const third = await guard.check(plain, "m");
    assert.equal(third.ok, false);
    assert.equal(third.ok === false ? third.reason : "", "rate_limited");
  });

  it("模型未解析（null）时不因白名单拒绝", async () => {
    const { plain } = createApiKey({ name: "n", allowedModels: ["only"], rpmLimit: 0 });
    installApiKeyGuard(true);
    assert.equal((await apiKeyGuard()!.check(plain, null)).ok, true);
  });
});
