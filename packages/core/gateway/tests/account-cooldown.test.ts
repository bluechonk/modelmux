/**
 * 账号级冷却：**额度耗尽 ≠ 故障**（2026-10-23 新增语义）。
 *
 * 背景（主人实测）：workbuddyai 的用量限额打满后上游回 429 + `code=6004`，旧实现把它
 * 和真故障一视同仁 —— 记连败、达 3 次标 `error`，Web 上显示「不可用」（截图里的
 * 「连续失败 12 次」）。可额度耗尽是**会自己好**的（上游窗口刷新），不该被永久跳过。
 *
 * 本用例覆盖四条判据：
 * 1. 额度耗尽 → `cooldown` + `cooldown_until`，**不动 `fail_streak`**；
 * 2. 冷却中 `activeAccountIsError()` 为 true（请求入口短路），但**不是** `error`；
 * 3. 冷却到期 → 惰性恢复 `ok` 并清零连败（放行）；
 * 4. 真故障（连败 3 次）仍照旧标 `error`，手动切号能同时清掉两种标记。
 *
 * 全程在 mkdtemp 的临时存储根下进行，绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  activateAccount,
  activeAccountCooldown,
  activeAccountIsError,
  noteAccountFailure,
  noteAccountQuotaExhausted,
  readIndex,
} from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "synthcool";
const KEY = "acct1";

/** 注册合成渠道：本用例只用到 `config`（路径解析）。 */
function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Synth Cool",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SYNTH_COOL_DUMP",
  };
  setChannel({
    config,
    cred: { NotLoggedInError: class NotLoggedInError extends Error {} },
  } as unknown as Channel);
}

/** 铺一个「已登录 + 池里只有一个生效账号」的现场。 */
function seedPool(health: string, cooldownUntil: string | null): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ uid: "u1", domain: "d", accessToken: "tok" }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: KEY,
      accounts: [
        {
          key: KEY,
          uid: "u1",
          domain: "d",
          label: "测试账号",
          added_at: "2026-10-23T00:00:00.000Z",
          last_used_at: "2026-10-23T00:00:00.000Z",
          expires_at: null,
          health,
          health_at: "2026-10-23T00:00:00.000Z",
          fail_streak: 0,
          cooldown_until: cooldownUntil,
          cooldown_reason: cooldownUntil ? "上游返回额度耗尽" : undefined,
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts", `${KEY}.json`),
    JSON.stringify({ uid: "u1", domain: "d", accessToken: "tok" }),
    "utf8",
  );
}

/** 取生效账号条目。 */
function active(): Record<string, unknown> {
  const index = readIndex(CID);
  return index.accounts.find((a) => a.key === index.active) as unknown as Record<string, unknown>;
}

describe("账号级冷却（额度耗尽 ≠ 故障）", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-acct-cool-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannel();
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("额度耗尽 → cooldown + 截止时间，且不吃连败", () => {
    seedPool("ok", null);
    const until = Date.now() + 3600_000;
    const written = noteAccountQuotaExhausted(CID, { until, reason: "上游 429 用量限额" });

    assert.equal(written, until, "渠道给的下次刷新时间应被采用");
    const hit = active();
    assert.equal(hit["health"], "cooldown", "额度耗尽应标 cooldown 而不是 error");
    assert.equal(hit["cooldown_until"], new Date(until).toISOString());
    assert.equal(hit["cooldown_reason"], "上游 429 用量限额");
    assert.equal(hit["fail_streak"], 0, "额度耗尽不该累积连败（否则会被 3 连败熔断误标不可用）");
  });

  it("冷却中：请求入口短路，但状态不是 error", () => {
    seedPool("cooldown", new Date(Date.now() + 600_000).toISOString());
    assert.equal(activeAccountIsError(CID), true, "冷却未到期时应短路");
    const info = activeAccountCooldown(CID);
    assert.ok(info, "应能拿到冷却信息给 UI 显示");
    assert.match(info.reason, /额度耗尽/);
  });

  it("冷却到期 → 惰性恢复 ok 并清零连败", () => {
    seedPool("cooldown", new Date(Date.now() - 60_000).toISOString());
    assert.equal(activeAccountIsError(CID), false, "过期后应放行");
    const hit = active();
    assert.equal(hit["health"], "ok", "过期后应自动恢复 ok");
    assert.equal(hit["cooldown_until"], null, "恢复后应清掉截止时间");
    assert.equal(activeAccountCooldown(CID), null);
  });

  it("未给截止时间 → 回落次日本地 0 点", () => {
    seedPool("ok", null);
    const before = Date.now();
    const written = noteAccountQuotaExhausted(CID);
    const d = new Date(written);
    assert.ok(written > before, "兜底时间应晚于现在");
    assert.equal(d.getHours(), 0, "兜底应为本地 0 点");
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
  });

  it("真故障仍走 error（连败 3 次），切号能同时清掉两种标记", () => {
    seedPool("ok", null);
    noteAccountFailure(CID);
    noteAccountFailure(CID);
    assert.equal(active()["health"], "ok", "未到 3 次不应标 error");
    noteAccountFailure(CID);
    assert.equal(active()["health"], "error", "连败 3 次应标 error");

    activateAccount(KEY, CID);
    const hit = active();
    assert.equal(hit["health"], "ok", "手动切号应清掉 error");
    assert.equal(hit["fail_streak"], 0);
  });
});
