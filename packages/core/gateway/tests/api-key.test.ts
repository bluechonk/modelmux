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
  integrationKeySecret,
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
  it("新建：哈希落盘、明文只以密文落盘，前缀是明文前 12 位", () => {
    const { record, plain } = createApiKey({ name: "ci" });
    assert.ok(plain.startsWith("mmx_"));
    assert.equal(record.prefix, plain.slice(0, 12));
    const raw = readFileSync(join(root, "api-keys.json"), "utf8");
    assert.ok(raw.includes(record.keyHash), "哈希必须落盘（校验走它）");
    // 明文绝不落盘（备份 / 日志会带走数据文件）；只存 AES-GCM 密文
    assert.ok(!raw.includes(plain), "明文不能出现在数据文件里");
    assert.ok(raw.includes("secretSealed"), "密文要落盘（复制与接入要回读）");
    // 但能回读出来
    assert.equal(revealApiKeyPlain(record.id), plain);
  });

  it("重建：换新明文与前缀，哈希随之更新，旧明文失效", () => {
    const { record } = createApiKey({ name: "rekey" });
    const oldPlain = revealApiKeyPlain(record.id)!;
    const rebuilt = regenerateApiKey(record.id);
    assert.ok(rebuilt !== null);
    assert.notEqual(rebuilt!.plain, oldPlain);
    assert.equal(revealApiKeyPlain(rebuilt!.record.id), rebuilt!.plain);
    assert.equal(rebuilt!.record.prefix, rebuilt!.plain.slice(0, 12));
    assert.ok(verifyApiKeyPlain(rebuilt!.plain), "新明文必须能通过校验");
    assert.ok(!verifyApiKeyPlain(oldPlain), "旧明文必须失效");
  });

  it("一键接入取明文：旧记录（只有哈希）会被重建出可用的明文", () => {
    const { record } = createApiKey({ name: INTEGRATION_KEY_NAME });
    // 模拟早期记录：抹掉密文，只剩哈希（直接改落盘文件，走真实读取路径）
    const file = join(root, "api-keys.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { keys: Array<Record<string, unknown>> };
    for (const k of doc.keys) if (k["id"] === record.id) delete k["secretSealed"];
    writeFileSync(file, JSON.stringify(doc));
    const secret = integrationKeySecret();
    assert.ok(secret !== null && secret.startsWith("mmx_"));
    assert.ok(verifyApiKeyPlain(secret!), "重建出的明文必须能通过校验");
  });

  it("旧版明文 secret 读到就迁成密文并**立即落盘**（不等下次写操作）", () => {
    const { record, plain } = createApiKey({ name: "legacy" });
    const file = join(root, "api-keys.json");
    // 造一条中间版本的记录：明文 secret，无密文
    const doc = JSON.parse(readFileSync(file, "utf8")) as { keys: Array<Record<string, unknown>> };
    for (const k of doc.keys) {
      if (k["id"] === record.id) {
        k["secret"] = plain;
        delete k["secretSealed"];
      }
    }
    writeFileSync(file, JSON.stringify(doc));
    assert.ok(readFileSync(file, "utf8").includes(plain), "前置：磁盘上确实有明文");

    // 只读一次（不做任何创建 / 更新）：必须把明文洗掉
    const keys = listApiKeys();
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes(plain), "读到旧明文后必须立即从磁盘移除");
    assert.ok(raw.includes("secretSealed"), "应改写为密文");
    // 迁移后仍可回读
    assert.equal(revealApiKeyPlain(record.id), plain);
    assert.equal(keys.length, 1);
  });

  it("密钥文件损坏：sealSecret/openSecret 返回 null，不抛错", () => {
    const { record } = createApiKey({ name: "corrupt" });
    const keyFile = join(keyring, "api-key.key");
    // 截断密钥文件（模拟写入中断）
    writeFileSync(keyFile, Buffer.from("short"));
    // 读路径不抛错，只是取不到明文
    assert.equal(revealApiKeyPlain(record.id), null);
    assert.equal(integrationKeySecret() === null || typeof integrationKeySecret() === "string", true);
    assert.doesNotThrow(() => listApiKeys());
  });

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
