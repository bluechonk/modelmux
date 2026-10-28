/**
 * 账号级冷却：**额度耗尽 ≠ 故障**。
 *
 * 背景：workbuddyai 用量限额打满后上游回 429 + `code=6004`，与真故障一视同仁
 * 会把会自愈的账号永久跳过。四条判据：① 额度耗尽 → `cooldown` 且不动
 * `fail_streak`；② 冷却中入口短路但非 `error`；③ 到期惰性恢复并清零连败；
 * ④ 真故障照旧标 `error`。全程 mkdtemp 临时存储根，不碰真实主目录。
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
  noteAccountSuccess,
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
function seedPool(
  health: string,
  cooldownUntil: string | null,
  tripUntil: string | null = null,
  failStreak = 0,
): void {
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
          fail_streak: failStreak,
          cooldown_until: cooldownUntil,
          cooldown_reason: cooldownUntil ? "上游返回额度耗尽" : undefined,
          trip_until: tripUntil,
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

  it("冷却中：不算 error（按模型放行），冷却信息可读", () => {
    seedPool("cooldown", new Date(Date.now() + 600_000).toISOString());
    // ⚠ 冷却**不算** error：免费模型（倍率 0）冷却期必须照常可路由，
    // 「要不要挡」由调用方按模型倍率决定（见 http/chat/auth.ts 的 freeModel 参数）。
    assert.equal(activeAccountIsError(CID), false, "冷却不是真故障，不能整体短路");
    const info = activeAccountCooldown(CID);
    assert.ok(info, "应能拿到冷却信息给 UI / 付费模型短路用");
    assert.match(info.reason, /额度耗尽/);
  });

  it("熔断未到期 → 短路；到期 → 放行一次（half-open）", () => {
    seedPool("error", null, new Date(Date.now() + 60_000).toISOString());
    assert.equal(activeAccountIsError(CID), true, "未到试探时刻必须短路");
    assert.equal(activeAccountCooldown(CID), null, "error 不是冷却");

    seedPool("error", null, new Date(Date.now() - 1_000).toISOString());
    assert.equal(activeAccountIsError(CID), false, "到期后应放行一次做半开试探");

    // 旧数据没有 trip_until：视作早已到期（升级后自动自检，不再永久卡死）
    seedPool("error", null);
    assert.equal(activeAccountIsError(CID), false);
  });

  it("连败 3 次 → 熔断并写入退避；半开再失败则翻倍", () => {
    seedPool("ok", null);
    for (let i = 0; i < 2; i++) noteAccountFailure(CID);
    assert.equal(active()["health"], "ok", "未达阈值不熔断");
    noteAccountFailure(CID);
    const hit = active();
    assert.equal(hit["health"], "error");
    const first = Date.parse(String(hit["trip_until"]));
    assert.ok(first > Date.now(), "首次熔断应写入未来的试探时刻");
    assert.equal(hit["trip_backoff_ms"], 30_000, "首次退避 30s");

    // 模拟半开试探再失败：退避翻倍
    noteAccountFailure(CID);
    assert.ok(Number(active()["trip_backoff_ms"]) >= 60_000, "退避应翻倍");
  });

  it("熔断后成功 → 恢复 ok 并清掉退避字段", () => {
    seedPool("error", null, new Date(Date.now() + 60_000).toISOString(), 3);
    noteAccountSuccess(CID);
    const hit = active();
    assert.equal(hit["fail_streak"], 0);
    assert.equal(hit["trip_until"], null);
    assert.equal(hit["trip_backoff_ms"], 0);
  });

  it("冷却到期 → 惰性恢复 ok 并清零连败", () => {
    seedPool("cooldown", new Date(Date.now() - 60_000).toISOString());
    // 惰性过期发生在读冷却的时候（`activeAccountCooldown`）；不是 error 那条路径
    assert.equal(activeAccountCooldown(CID), null, "过期后应放行");
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
