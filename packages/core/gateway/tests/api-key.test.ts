/**
 * API key 管理：新建/校验/白名单/限流/删除闭环。
 *
 * 全程临时 MODELMUX_HOME（fs 形态），不碰真实存储；不 mock 任何 IO —— 落盘语义
 * （哈希与明文同存）本身就是要验的部分。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  createApiKey,
  deleteApiKey,
  installApiKeyGuard,
  INTEGRATION_KEY_NAME,
  integrationKeySecret,
  listApiKeys,
  regenerateApiKey,
  updateApiKey,
  verifyApiKeyPlain,
} from "../dist/runtime/api-key-store.js";
import { apiKeyGuard, setApiKeyGuard } from "../dist/runtime/api-key.js";

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
  setApiKeyGuard(null);
});

describe("API key 存储", () => {
  it("新建：明文与哈希同存，前缀是明文前 12 位", () => {
    const { record, plain } = createApiKey({ name: "ci", allowedModels: [], rpmLimit: 0 });
    assert.ok(plain.startsWith("mmx_"));
    assert.equal(record.prefix, plain.slice(0, 12));
    // 明文可回读：列表复制与一键接入都要完整值（0600 文件，与哈希同一信任域）
    assert.equal(record.secret, plain);
    const raw = readFileSync(join(root, "api-keys.json"), "utf8");
    assert.ok(raw.includes(record.keyHash), "哈希必须落盘（校验走它）");
    assert.ok(raw.includes(plain), "明文也要落盘（否则复制与接入拿不到完整值）");
  });

  it("重建：换新明文与前缀，哈希随之更新，旧明文失效", () => {
    const { record } = createApiKey({ name: "rekey", allowedModels: [], rpmLimit: 0 });
    const oldPlain = record.secret!;
    const rebuilt = regenerateApiKey(record.id);
    assert.ok(rebuilt !== null);
    assert.notEqual(rebuilt!.plain, oldPlain);
    assert.equal(rebuilt!.record.secret, rebuilt!.plain);
    assert.equal(rebuilt!.record.prefix, rebuilt!.plain.slice(0, 12));
    assert.ok(verifyApiKeyPlain(rebuilt!.plain), "新明文必须能通过校验");
    assert.ok(!verifyApiKeyPlain(oldPlain), "旧明文必须失效");
  });

  it("一键接入取明文：旧记录（只有哈希）会被重建出可用的明文", () => {
    const { record } = createApiKey({ name: INTEGRATION_KEY_NAME, allowedModels: [], rpmLimit: 0 });
    // 模拟早期记录：抹掉 secret，只剩哈希（直接改落盘文件，走真实读取路径）
    const file = join(root, "api-keys.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { keys: Array<Record<string, unknown>> };
    for (const k of doc.keys) if (k["id"] === record.id) delete k["secret"];
    writeFileSync(file, JSON.stringify(doc));
    const secret = integrationKeySecret();
    assert.ok(secret !== null && secret.startsWith("mmx_"));
    assert.ok(verifyApiKeyPlain(secret!), "重建出的明文必须能通过校验");
  });

  it("每条 key 独立随机 salt（同明文两次新建哈希不同）", () => {
    const a = createApiKey({ name: "s1", allowedModels: [], rpmLimit: 0 });
    const b = createApiKey({ name: "s2", allowedModels: [], rpmLimit: 0 });
    const saltOf = (h: string) => h.slice(0, h.indexOf(":"));
    assert.notEqual(saltOf(a.record.keyHash), saltOf(b.record.keyHash));
    // 格式 <saltHex>:<hashHex>，两段都是偶数长度 hex
    for (const h of [a.record.keyHash, b.record.keyHash]) {
      const [salt, digest] = h.split(":");
      assert.equal(salt!.length, 32, "salt 16 字节 = 32 hex");
      assert.equal(digest!.length, 64, "scrypt 32 字节 = 64 hex");
    }
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
  it("未装配 guard → 不校验", async () => {
    setApiKeyGuard(null);
    assert.equal(apiKeyGuard(), null);
  });

  it("缺 key / 错 key → invalid", async () => {
    installApiKeyGuard();
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(null, "m")).ok, false);
    assert.equal((await guard.check("mmx_nope", "m")).ok, false);
  });

  it("白名单：空数组放行全部，非空只放行列出的", async () => {
    const all = createApiKey({ name: "all", allowedModels: [], rpmLimit: 0 });
    const one = createApiKey({ name: "one", allowedModels: ["m1"], rpmLimit: 0 });
    installApiKeyGuard();
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(all.plain, "anything")).ok, true);
    assert.equal((await guard.check(one.plain, "m1")).ok, true);
    const denied = await guard.check(one.plain, "m2");
    assert.equal(denied.ok, false);
    assert.equal(denied.ok === false ? denied.reason : "", "forbidden");
  });

  it("rpm 上限：第 N+1 次 rate_limited", async () => {
    const { plain } = createApiKey({ name: "rl", allowedModels: [], rpmLimit: 2 });
    installApiKeyGuard();
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(plain, "m")).ok, true);
    assert.equal((await guard.check(plain, "m")).ok, true);
    const third = await guard.check(plain, "m");
    assert.equal(third.ok, false);
    assert.equal(third.ok === false ? third.reason : "", "rate_limited");
  });

  it("旧格式（无 salt 裸摘要）仍可校验 —— 升级不作废已发出的 key", async () => {
    // 手工造一条旧格式记录：固定 salt + 16 字节摘要
    const { scryptSync } = await import("node:crypto");
    const plain = "mmx_legacykey0123456789abcdef";
    const legacy = scryptSync(plain, "modelmux-apikey", 16).toString("hex");
    const { writeApiKeys, readApiKeys } = await import("../dist/runtime/pool-store.js").then((m) => ({
      writeApiKeys: (v: unknown) => m.poolStore().writeApiKeys(v),
      readApiKeys: () => m.poolStore().readApiKeys(),
    }));
    writeApiKeys({
      version: 1,
      keys: [
        {
          id: "legacy1",
          name: "old",
          prefix: plain.slice(0, 12),
          keyHash: legacy,
          allowedModels: [],
          rpmLimit: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    assert.equal((readApiKeys() !== null), true);
    installApiKeyGuard();
    assert.equal((await apiKeyGuard()!.check(plain, "m")).ok, true, "旧格式必须继续通过");
    assert.equal((await apiKeyGuard()!.check("mmx_wrongkey0123456789abcdef", "m")).ok, false);
  });

  it("畸形记录一律拒绝（不把垃圾喂给 scrypt）", async () => {
    const { poolStore } = await import("../dist/runtime/pool-store.js");
    const plain = "mmx_malformed0123456789abcdef";
    const bad = [":abc", "abc:", ":", "zz:zz", "abc:def1", "a".repeat(31), "00:" + "gg".repeat(32)];
    for (const hash of bad) {
      poolStore().writeApiKeys({
        version: 1,
        keys: [{ id: "bad", name: "bad", prefix: plain.slice(0, 12), keyHash: hash, allowedModels: [], rpmLimit: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      installApiKeyGuard();
      const res = await apiKeyGuard()!.check(plain, "m");
      assert.equal(res.ok, false, `畸形哈希 ${JSON.stringify(hash)} 必须拒绝`);
    }
  });

  it("模型未解析（null）时不因白名单拒绝", async () => {
    const { plain } = createApiKey({ name: "n", allowedModels: ["only"], rpmLimit: 0 });
    installApiKeyGuard();
    assert.equal((await apiKeyGuard()!.check(plain, null)).ok, true);
  });
});
