/**
 * 演示模式数据完整性：demo api 与真实后端同形，这里钉死「演示的是交互流程」——
 * 登录 / 切换 / 删除 / 日志筛选 / 用量区间都要真实改内存状态并返回合法形状。
 *
 * 演示数据本身（渠道清单、种子日志）是展示资产：形状漂移会让 Pages 上的演示页
 * 看起来「坏了」，所以对形状做冒烟级断言，不逐字段卡死。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDemoState,
  demoActivate,
  demoAccountPools,
  demoBilling,
  demoCompleteLogin,
  demoEndLogin,
  demoLogPayload,
  demoLogin,
  demoLogs,
  demoModels,
  demoOverview,
  demoRemove,
  demoReset,
  demoSettings,
  demoStatus,
  demoSubmitLoginInput,
  demoUsage,
} from "../src/lib/demo.ts";

describe("演示快照与模型清单", () => {
  it("createDemoState → 快照形状齐全（ui_state / endpoints / channel_caps）", () => {
    const snap = demoSettings(createDemoState());
    assert.equal(snap.ui_state, "running");
    assert.ok(Array.isArray(snap.endpoints) && snap.endpoints.length > 0);
    assert.ok(snap.base_url.length > 0);
    assert.equal(typeof snap.channel_caps, "object");
    assert.ok(Array.isArray(snap.models) && snap.models.length > 0, "演示模式必须有模型可展示");
  });

  it("demoModels 与快照 models 的模型集合一致，且只含已登录渠道", () => {
    const state = createDemoState();
    const ids = new Set(demoModels(state).map((m) => m.model));
    assert.ok(ids.size > 0);
    for (const row of demoSettings(state).models) {
      assert.ok(ids.has(row.model), `快照模型 ${row.model} 必须在 demoModels 里`);
    }
    // 种子里 workbuddy 未登录，它的模型不能出现在池里
    for (const row of demoModels(state)) {
      assert.notEqual(row.cid, "workbuddy");
    }
  });

  it("初始状态：部分渠道已登录（演示的是「在用」的看板）", () => {
    const channels = demoStatus(createDemoState()).channels;
    assert.ok(channels.some((c) => c.present));
    assert.ok(channels.some((c) => !c.present), "保留未登录渠道，登录流程才有演示对象");
  });
});

describe("登录流程（演示的是两步交互）", () => {
  it("loomy：登录 → 手机号 → 验证码 → 入池 present", () => {
    const state = createDemoState();
    assert.equal(demoLogin(state, "loomy").started, true);
    // 第一步输入是手机号（login_input.kind = phone）
    assert.equal(demoSettings(state).login_input?.kind, "phone");
    demoSubmitLoginInput(state, "13800000000");
    assert.equal(demoSettings(state).login_input?.kind, "code", "手机号之后进入验证码步骤");
    demoSubmitLoginInput(state, "123456");
    demoCompleteLogin(state);
    assert.equal(demoStatus(state).channels.find((c) => c.cid === "loomy")?.present, true);
  });

  it("code 型渠道：无输入卡，直接完成授权", () => {
    const state = createDemoState();
    demoLogin(state, "raccoon");
    const snap = demoSettings(state);
    assert.equal(snap.ui_state, "login");
    assert.ok(snap.auth_url.length > 0, "code 型给授权链接");
    assert.equal(snap.login_input, null);
    demoCompleteLogin(state);
    assert.equal(demoStatus(state).channels.find((c) => c.cid === "raccoon")?.present, true);
  });

  it("没有进行中的登录时 submitInput 是空操作；cancelInput 收尾", () => {
    const state = createDemoState();
    assert.match(demoSubmitLoginInput(state, "x").message, /没有进行中的登录/);
    demoLogin(state, "raccoon");
    demoEndLogin(state);
    assert.equal(demoSettings(state).ui_state, "running");
  });
});

describe("账号池动作", () => {
  it("activate / reset / remove 真实改内存池", () => {
    const state = createDemoState();
    const poolOf = (cid: string): Array<{ key: string; health: string }> =>
      ((demoAccountPools(state).channels as Array<{ cid: string; index: { accounts: Array<{ key: string; health: string }> } }>).find(
        (c) => c.cid === cid,
      )?.index.accounts ?? []);

    const key = poolOf("catpaw")[0]?.key;
    assert.ok(key, "已登录渠道的池里必须有账号");
    assert.equal(demoActivate(state, "catpaw", key!), true);
    assert.equal(demoActivate(state, "catpaw", "ghost"), false);
    const reset = demoReset(state, "catpaw", key!);
    assert.equal(typeof reset.cleared, "boolean");
    assert.equal(demoReset(state, "catpaw", "ghost").cleared, false);
    assert.equal(demoRemove(state, "catpaw", "ghost"), false);
    const beforeRemove = poolOf("catpaw").length;
    assert.equal(demoRemove(state, "catpaw", key!), true);
    assert.equal(poolOf("catpaw").length, beforeRemove - 1, "删除后池里少一个账号");
  });
});

describe("账单与总览", () => {
  it("demoBilling 的行结构与真实命令同形（candidates 内嵌）", () => {
    const { rows, models } = demoBilling(createDemoState());
    assert.ok(models.length > 0);
    assert.ok(rows.length > 0);
    for (const row of rows as Array<{ model: string; candidates: Array<{ cid: string; used: number }> }>) {
      assert.equal(typeof row.model, "string");
      for (const candidate of row.candidates) {
        assert.equal(typeof candidate.used, "number");
      }
    }
  });

  it("demoOverview 聚合：KPI / 渠道 / 最近请求齐全", () => {
    const overview = demoOverview(createDemoState());
    assert.ok(overview.usage.requests >= 0);
    assert.ok(Array.isArray(overview.channels));
    assert.ok(Array.isArray(overview.recent));
    assert.ok(overview.gateway.ui_state.length > 0);
  });
});

describe("日志与用量（演示种子数据的读路径）", () => {
  it("demoLogs 返回种子条目；outcome 筛选生效", () => {
    const state = createDemoState();
    const page = demoLogs(state, {});
    assert.ok(page.entries.length > 0, "演示种子必须有日志");
    assert.ok(page.date.length === 10, "页脚日期是本地 YYYY-MM-DD");
    const failures = demoLogs(state, { outcome: "failure" });
    assert.ok(failures.entries.length > 0, "种子里必须有失败行");
    for (const entry of failures.entries) assert.equal(entry.outcome, "failure");
    assert.ok(failures.total <= page.total);
  });

  it("种子里的慢判定与后端口径一致（首字慢 / 速率慢两个归因都有样本）", () => {
    const entries = demoLogs(createDemoState(), { slow: true }).entries;
    assert.ok(entries.length >= 2, "两个归因维度各至少一条，否则演示页像没有这个功能");
    assert.ok(entries.some((e) => e.slowTtfb), "必须有首字慢样本");
    assert.ok(entries.some((e) => e.slowTps), "必须有速率慢样本");
    for (const entry of entries) {
      assert.equal(entry.slow, true);
      assert.ok(entry.slowTtfb || entry.slowTps, "慢行必须能归因到至少一个维度");
    }
  });

  it("demoUsage 六个区间都返回合法聚合（daily + totals）", () => {
    for (const range of ["today", "7d", "30d", "90d", "365d", "all"] as const) {
      const stats = demoUsage(range);
      assert.ok(Array.isArray(stats.daily));
      assert.ok(stats.totals.tokens >= 0);
      assert.equal(stats.range, range);
      // 仪表盘的「平均 TPS」格读它：演示值也必须在可展示区间（不是 0 / NaN）
      assert.ok(stats.totals.avgTps !== null && stats.totals.avgTps > 0, "演示必须有可展示的平均速率");
    }
  });

  it("demoLogs 的统计条带平均 TPS（演示页要有可展示的样本）", () => {
    const page = demoLogs(createDemoState(), {});
    // 口径的正确性由网关侧用例钉死；这里只要求演示数据不是 null / 0（否则页面显示 `—`）
    assert.ok(page.stats.avgTps !== null && page.stats.avgTps > 0);
  });

  it("demoLogPayload：正文抓取记录可读回（演示对任意 id 回同一份夹具正文）", () => {
    const state = createDemoState();
    const page = demoLogs(state, {});
    const payload = demoLogPayload(page.entries[0]!.id);
    assert.ok(Array.isArray(payload.records) && payload.records.length > 0);
    for (const record of payload.records) {
      assert.equal(typeof record.body, "string");
    }
  });
});
