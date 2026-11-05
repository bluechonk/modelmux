/**
 * 自定义提供商多 key 回归：注册表旧格式迁移、key → 账号池同步（新增/移除/换生效 key）、
 * key 身份稳定性（改备注名不改账号身份）、validateProvider 的 key 校验。
 * 全部走注入的临时存储根，不碰真实注册表。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readIndex, syncKeyAccounts } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import {
  keyFingerprint,
  readCustomProviders,
  validateProvider,
  type CustomProvider,
} from "../dist/runtime/custom-providers.js";
import * as paths from "../dist/runtime/paths.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mx-custom-keys-"));
  process.env["MODELMUX_HOME"] = root;
  // 落点按 cid 解析需要渠道已注册（生产路径由 reloadCustomProviders 保证先后）
  clearChannels();
  setChannel({ config: { cid: "longcat" } } as unknown as Channel);
});

afterEach(() => {
  clearChannels();
  delete process.env["MODELMUX_HOME"];
  rmSync(root, { recursive: true, force: true });
});

function writeRegistry(doc: unknown): void {
  const dir = join(root, "custom");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "providers.json"), JSON.stringify(doc), "utf8");
}

function providerDoc(apiKeys: Array<{ key: string; label?: string }>): CustomProvider {
  return {
    id: "longcat",
    display: "LongCat",
    baseUrl: "https://api.longcat.chat/openai",
    protocol: "openai",
    apiKeys,
    models: [{ id: "LongCat-2.0" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("注册表旧格式迁移", () => {
  it("单值 apiKey 自动迁移成 apiKeys 一项（不落旧字段）", () => {
    writeRegistry([
      {
        id: "xfyun",
        display: "xfyun",
        baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v1",
        protocol: "openai",
        apiKey: "ak-legacy-1234567890",
        models: [{ id: "m1" }],
      },
    ]);
    const list = readCustomProviders();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.apiKeys, [{ key: "ak-legacy-1234567890" }]);
    assert.equal((list[0] as unknown as Record<string, unknown>)["apiKey"], undefined, "旧字段不残留");
  });
});

describe("syncKeyAccounts：一个 key = 一个账号", () => {
  it("两个 key → 池里两个账号 + 生效凭据指向第一个", () => {
    syncKeyAccounts("longcat", [{ key: "ak-aaa-1111111111", label: "主号" }, { key: "ak-bbb-2222222222" }]);
    const index = readIndex("longcat");
    assert.equal(index.accounts.length, 2);
    assert.equal(index.accounts[0]!.label, "主号");
    assert.equal(index.accounts[0]!.domain, "longcat");
    const active = index.accounts.find((a) => a.key === index.active)!;
    assert.equal(active.key, index.accounts[0]!.key, "生效账号是第一个 key");
    const cred = JSON.parse(readFileSync(paths.credentialsPath("longcat"), "utf8")) as Record<string, unknown>;
    assert.equal(cred["accessToken"], "ak-aaa-1111111111");
  });

  it("删一个 key → 该账号移除；改备注名后账号身份（key）不变", () => {
    syncKeyAccounts("longcat", [{ key: "ak-aaa-1111111111" }, { key: "ak-bbb-2222222222" }]);
    const before = readIndex("longcat");
    const bKey = before.accounts.find((a) => a.label === "ak-bbb-2222222222")!.key;

    // 只改备注名：账号 key（身份）必须不变
    syncKeyAccounts("longcat", [{ key: "ak-aaa-1111111111" }, { key: "ak-bbb-2222222222", label: "备用" }]);
    const renamed = readIndex("longcat");
    const bAfter = renamed.accounts.find((a) => a.key === bKey);
    assert.ok(bAfter, "身份键不变");
    assert.equal(bAfter!.label, "备用");

    // 删掉 a：只剩 b，生效指向 b
    syncKeyAccounts("longcat", [{ key: "ak-bbb-2222222222", label: "备用" }]);
    const after = readIndex("longcat");
    assert.equal(after.accounts.length, 1);
    assert.equal(after.active, bKey);
    const cred = JSON.parse(readFileSync(paths.credentialsPath("longcat"), "utf8")) as Record<string, unknown>;
    assert.equal(cred["accessToken"], "ak-bbb-2222222222", "生效凭据跟着换");
  });

  it("空列表 → 清空池并删生效凭据（提供商被删的场景）", () => {
    syncKeyAccounts("longcat", [{ key: "ak-aaa-1111111111" }]);
    assert.ok(existsSync(paths.credentialsPath("longcat")));
    syncKeyAccounts("longcat", []);
    const index = readIndex("longcat");
    assert.equal(index.accounts.length, 0);
    assert.equal(index.active, null);
    assert.ok(!existsSync(paths.credentialsPath("longcat")), "生效凭据清除");
  });

  it("幂等：重复同步不重复建账号", () => {
    syncKeyAccounts("longcat", [{ key: "ak-aaa-1111111111" }]);
    syncKeyAccounts("longcat", [{ key: "ak-aaa-1111111111" }]);
    assert.equal(readIndex("longcat").accounts.length, 1);
  });
});

describe("validateProvider 与指纹", () => {
  it("重复 key 报错；key 为空报错", () => {
    assert.match(validateProvider(providerDoc([{ key: "same-key-123456" }, { key: "same-key-123456" }])) ?? "", /重复/);
    assert.match(validateProvider(providerDoc([{ key: "   " }])) ?? "", /空 API Key/);
    assert.equal(validateProvider(providerDoc([{ key: "ak-111-222222" }, { key: "ak-333-444444" }])), null);
  });

  it("指纹形态：首尾保留、中间省略；短 key 全掩", () => {
    assert.equal(keyFingerprint("ak_25f12345678j7h"), "ak_25f…8j7h");
    assert.equal(keyFingerprint("short"), "****");
  });
});
