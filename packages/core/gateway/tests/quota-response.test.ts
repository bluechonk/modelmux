/**
 * 额度耗尽时的**对外应答语义**：429 + `insufficient_quota`，并区分「整池耗尽」与「当前账号耗尽」。
 *
 * 背景（2026-11-02）：旧实现用 503 `quota_exhausted`。503 表示服务端故障，客户端会重试；
 * 而额度耗尽不是故障，重试永远无效 —— 应当按 OpenAI 惯例回 429 `insufficient_quota`，
 * 让客户端提示用户充值。整池都没钱时也不能再劝「换账号」（换也换不出来）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { hasUsableAccount, listAccounts } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "quota";
const NOW = new Date().toISOString();

function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Quota",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "QUOTA_DEBUG_DUMP",
  };
  return { config, cred: {}, upstream: {}, catalog: {}, billing: {} } as unknown as Channel;
}

describe("额度耗尽：可用账号判定", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mx-quota-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("空池 → 没有可用账号（应回「整池耗尽」措辞）", () => {
    assert.equal(hasUsableAccount(CID), false);
  });

  it("健康账号存在 → 有可用账号（可提示换号）", () => {
    writeFileSync(
      join(paths.channelDir(CID), "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "k1",
        accounts: [{ key: "k1", uid: "u1", domain: "", label: "131****0001", name: "131****0001", added_at: NOW, last_used_at: NOW, expires_at: null, health: "ok", health_at: NOW, fail_streak: 0, cooldown_until: null, cooldown_reason: "", trip_until: null, trip_backoff_ms: 0 }],
      }),
      "utf8",
    );
    assert.equal(hasUsableAccount(CID), true);
  });

  it("唯一账号冷却未到期 → 没有可用账号", () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(paths.channelDir(CID), "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "k1",
        accounts: [
          {
            key: "k1",
            uid: "u1",
            domain: "",
            label: "131****0001",
            name: "131****0001",
            added_at: NOW,
            last_used_at: NOW,
            health: "cooldown",
            health_at: NOW,
            cooldown_reason: "额度不足",
            trip_until: null,
            trip_backoff_ms: 0,
            cooldown_until: until,
            fail_streak: 0,
          },
        ],
      }),
      "utf8",
    );
    assert.equal(hasUsableAccount(CID), false);
  });

  it("冷却已到期 → 视为可用（不该说「整池耗尽」）", () => {
    const until = new Date(Date.now() - 60 * 1000).toISOString();
    writeFileSync(
      join(paths.channelDir(CID), "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "k1",
        accounts: [
          {
            key: "k1",
            uid: "u1",
            domain: "",
            label: "131****0001",
            name: "131****0001",
            added_at: NOW,
            last_used_at: NOW,
            health: "cooldown",
            health_at: NOW,
            cooldown_reason: "额度不足",
            trip_until: null,
            trip_backoff_ms: 0,
            cooldown_until: until,
            fail_streak: 0,
          },
        ],
      }),
      "utf8",
    );
    assert.equal(hasUsableAccount(CID), true);
  });

  it("账号被标 unauthorized / error（终态）→ 不算可用", () => {
    // `listAccounts` 会 prune 掉没有 `accounts/<key>.json` 的条目，故两条都要有实体文件
    const accountsDir = join(paths.channelDir(CID), "accounts");
    mkdirSync(accountsDir, { recursive: true });
    for (const key of ["k1", "k2"]) {
      writeFileSync(join(accountsDir, `${key}.json`), JSON.stringify({ key }), "utf8");
    }
    writeFileSync(
      join(paths.channelDir(CID), "accounts.json"),
      JSON.stringify({
        version: 1,
        active: "k1",
        accounts: [
          { key: "k1", uid: "u1", domain: "", label: "a", name: "a", added_at: NOW, last_used_at: NOW, health: "unauthorized", health_at: NOW, fail_streak: 3, cooldown_until: null, trip_until: null, trip_backoff_ms: 0 },
          { key: "k2", uid: "u2", domain: "", label: "b", name: "b", added_at: NOW, last_used_at: NOW, health: "error", health_at: NOW, fail_streak: 5, cooldown_until: null, trip_until: null, trip_backoff_ms: 0 },
        ],
      }),
      "utf8",
    );
    assert.equal(hasUsableAccount(CID), false);
    assert.equal(listAccounts(CID).accounts.length, 2, "两条都在台账里，只是都不可用");
  });
});
