/**
 * API key 管理：新建/校验/删除闭环。
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
  listApiKeys,
  regenerateApiKey,
  revealApiKeyPlain,
  updateApiKey,
  verifyApiKeyPlain,
} from "../dist/runtime/api-key-store.js";
import { apiKeyGuard, setApiKeyGuard } from "../dist/runtime/api-key.js";

let root = "";
let savedHome: string | undefined;
let savedKeyring: string | undefined;
let keyring = "";

before(() => {
  savedHome = process.env["MODELMUX_HOME"];
  savedKeyring = process.env["MODELMUX_KEYRING"];
  root = mkdtempSync(join(tmpdir(), "modelmux-apikeys-"));
  // 加密密钥目录与存储根分离（生产默认在 OS 配置目录）：测试同样分开，
  // 既验证「不同目录」这条设计，也不污染真实的 OS keyring
  keyring = mkdtempSync(join(tmpdir(), "modelmux-keyring-"));
  process.env["MODELMUX_HOME"] = root;
  process.env["MODELMUX_KEYRING"] = keyring;
});

after(() => {
  if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedHome;
  if (savedKeyring === undefined) delete process.env["MODELMUX_KEYRING"];
  else process.env["MODELMUX_KEYRING"] = savedKeyring;
  rmSync(root, { recursive: true, force: true });
  rmSync(keyring, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例从空表开始
  for (const k of listApiKeys()) deleteApiKey(k.id);
  setApiKeyGuard(null);
});

describe("API key 存储", () => {
  it("密钥不可用时旧明文留在磁盘，但**不从 listApiKeys 返回**（曾随列表下发的漏洞）", () => {
    const { record, plain } = createApiKey({ name: "legacy-leak" });
    const file = join(root, "api-keys.json");
    // 造一条旧版记录：明文 secret、无密文
    const doc = JSON.parse(readFileSync(file, "utf8")) as { keys: Array<Record<string, unknown>> };
    for (const k of doc.keys) {
      if (k["id"] === record.id) {
        k["secret"] = plain;
        delete k["secretSealed"];
      }
    }
    writeFileSync(file, JSON.stringify(doc));
    // 截断密钥：迁移必然失败，明文只能留在磁盘上（下次启动再试）
    writeFileSync(join(keyring, "api-key.key"), Buffer.from("short"));

    const keys = listApiKeys();
    // 磁盘上仍保留明文（迁移待重试）
    assert.ok(readFileSync(file, "utf8").includes(plain), "磁盘应保留明文等待下次迁移");
    // 但返回值里不许有 —— 任何调用方把它序列化下发就等于交出可用凭据
    for (const k of keys) {
      assert.equal(
        (k as unknown as Record<string, unknown>)["secret"],
        undefined,
        "listApiKeys 不得返回旧版明文",
      );
    }
    // 序列化后也不许出现
    assert.ok(!JSON.stringify(keys).includes(plain), "序列化结果不得含明文");
  });

  it("每条 key 独立随机 salt（同明文两次新建哈希不同）", () => {
    const a = createApiKey({ name: "s1" });
    const b = createApiKey({ name: "s2" });
    const saltOf = (h: string) => h.slice(0, h.indexOf(":"));
    assert.notEqual(saltOf(a.record.keyHash), saltOf(b.record.keyHash));
    // 格式 <saltHex>:<hashHex>，两段都是偶数长度 hex
    for (const h of [a.record.keyHash, b.record.keyHash]) {
      const [salt, digest] = h.split(":");
      assert.equal(salt!.length, 32, "salt 16 字节 = 32 hex");
      assert.equal(digest!.length, 64, "scrypt 32 字节 = 64 hex");
    }
  });

  it("更新备注名与删除", () => {
    const { record } = createApiKey({ name: "tmp" });
    const next = updateApiKey(record.id, { name: "renamed" });
    assert.equal(next?.name, "renamed");
    assert.equal(deleteApiKey(record.id), true);
    assert.equal(deleteApiKey(record.id), false, "重复删除如实返回 false");
    assert.equal(listApiKeys().length, 0);
  });

  it("校验缓存不延长吊销窗口：删除后立即失效", () => {
    const { record, plain } = createApiKey({ name: "cached" });
    // 先校验一次把结果放进缓存
    assert.equal(verifyApiKeyPlain(plain), true);
    assert.equal(verifyApiKeyPlain(plain), true, "第二次走缓存仍应通过");
    // 删除后必须立刻失效 —— 缓存 TTL 30s，但写操作会 bump epoch
    assert.equal(deleteApiKey(record.id), true);
    assert.equal(verifyApiKeyPlain(plain), false, "删除后不得因缓存仍通过");
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
    assert.equal((await guard.check(null)).ok, false);
    assert.equal((await guard.check("mmx_nope")).ok, false);
  });

  it("有效 key → 放行（key 只承担准入，无白名单与限流）", async () => {
    const { plain } = createApiKey({ name: "ok" });
    installApiKeyGuard();
    const guard = apiKeyGuard()!;
    assert.equal((await guard.check(plain)).ok, true);
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
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    assert.equal((readApiKeys() !== null), true);
    installApiKeyGuard();
    assert.equal((await apiKeyGuard()!.check(plain)).ok, true, "旧格式必须继续通过");
    assert.equal((await apiKeyGuard()!.check("mmx_wrongkey0123456789abcdef")).ok, false);
  });

  it("畸形记录一律拒绝（不把垃圾喂给 scrypt）", async () => {
    const { poolStore } = await import("../dist/runtime/pool-store.js");
    const plain = "mmx_malformed0123456789abcdef";
    const bad = [":abc", "abc:", ":", "zz:zz", "abc:def1", "a".repeat(31), "00:" + "gg".repeat(32)];
    for (const hash of bad) {
      poolStore().writeApiKeys({
        version: 1,
        keys: [{ id: "bad", name: "bad", prefix: plain.slice(0, 12), keyHash: hash, createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      installApiKeyGuard();
      const res = await apiKeyGuard()!.check(plain);
      assert.equal(res.ok, false, `畸形哈希 ${JSON.stringify(hash)} 必须拒绝`);
    }
  });
});
