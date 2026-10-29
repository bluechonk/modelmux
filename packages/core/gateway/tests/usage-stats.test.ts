/**
 * 「使用统计」聚合：只计模型请求、区间边界、峰值 / 连续天数 / 缓存口径。
 *
 * 全程在 mkdtemp 的临时存储根下进行，绝不碰真实主目录（与 access-query.test.ts 同）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import * as paths from "../dist/runtime/paths.js";
import { computeUsageStats, localDateOf, resetUsageCache } from "../dist/runtime/usage-stats.js";

const savedHome = process.env["MODELMUX_HOME"];
let dir = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "modelmux-usage-"));
  process.env["MODELMUX_HOME"] = dir;
});

/** 每个用例都从「磁盘无日志 + 缓存空」开始 —— 否则前一个用例写的日期目录会被读到。 */
beforeEach(() => {
  resetUsageCache();
  rmSync(join(paths.logsDir(), "access"), { recursive: true, force: true });
});

after(() => {
  if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

/** 相对今天偏移若干天（本地日期，与日志目录切分口径一致）。 */
function dateOffset(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return localDateOf(d);
}

/** 写某天的 access 日志（只写 success.log 够用；outcome 不影响聚合）。 */
function writeDay(date: string, records: Array<Record<string, unknown>>): void {
  const target = join(paths.logsDir(), "access", date);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "success.log"), records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

let seq = 0;
/** 一条模型请求；`usage` 传 null 表示上游没给用量。 */
function modelEntry(
  date: string,
  model: string,
  tokens: { prompt: number; completion: number; cache?: { hit: number; miss: number } } | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  seq += 1;
  return {
    id: `req_test${String(seq).padStart(4, "0")}`,
    ts: `${date}T02:00:00.000Z`,
    method: "POST",
    path: "/v1/chat/completions",
    cid: model.split("/")[0],
    model,
    messageCount: 2,
    durationMs: 1000,
    outcome: "success",
    ...(tokens === null
      ? {}
      : {
          usage: {
            prompt_tokens: tokens.prompt,
            completion_tokens: tokens.completion,
            total_tokens: tokens.prompt + tokens.completion,
            ...(tokens.cache === undefined
              ? {}
              : { prompt_tokens_details: { cached_tokens: tokens.cache.hit }, prompt_cache_miss_tokens: tokens.cache.miss }),
          },
        }),
    ...over,
  };
}

describe("computeUsageStats", () => {
  it("只统计模型请求：/health 与非模型路径不进聚合", () => {
    resetUsageCache();
    const today = dateOffset(0);
    writeDay(today, [
      modelEntry(today, "loomy/kimi-k2.6", { prompt: 100, completion: 50 }),
      // 非模型请求：同一天、同样有 usage 字段，但不该被计入
      { id: "req_health0000001", ts: `${today}T02:00:00.000Z`, method: "GET", path: "/health", outcome: "success" },
      {
        id: "req_models000001",
        ts: `${today}T02:00:00.000Z`,
        method: "GET",
        path: "/v1/models",
        outcome: "success",
      },
    ]);
    const stats = computeUsageStats("7d");
    assert.equal(stats.totals.requests, 1, "只有 1 条模型请求");
    assert.equal(stats.totals.tokens, 150);
  });

  it("累计 / 输入输出 / 模型占比 / 图例排序", () => {
    resetUsageCache();
    const today = dateOffset(0);
    writeDay(today, [
      modelEntry(today, "loomy/kimi-k2.6", { prompt: 300, completion: 100 }),
      modelEntry(today, "catpaw/glm-5.3-flash", { prompt: 100, completion: 100 }),
    ]);
    const stats = computeUsageStats("7d");
    assert.equal(stats.totals.tokens, 600);
    assert.equal(stats.totals.tokensIn, 400);
    assert.equal(stats.totals.tokensOut, 200);
    assert.equal(stats.models.length, 2);
    assert.equal(stats.models[0]?.id, "loomy/kimi-k2.6", "按 tokens 降序");
    assert.equal(stats.models[0]?.share, 400 / 600);
    assert.equal(stats.favorite?.id, "loomy/kimi-k2.6");
  });

  it("峰值日与峰值时段", () => {
    resetUsageCache();
    const d1 = dateOffset(2);
    const d2 = dateOffset(1);
    writeDay(d1, [modelEntry(d1, "loomy/kimi-k2.6", { prompt: 100, completion: 0 })]);
    // 峰值日：03:00 UTC 的请求更多
    writeDay(d2, [
      modelEntry(d2, "loomy/kimi-k2.6", { prompt: 900, completion: 0 }),
      modelEntry(d2, "loomy/kimi-k2.6", { prompt: 10, completion: 0 }, { ts: `${d2}T23:00:00.000Z` }),
    ]);
    const stats = computeUsageStats("7d");
    assert.equal(stats.peak?.date, d2);
    assert.equal(stats.peak?.tokens, 910);
  });

  it("连续天数：中间断一天则分成两段", () => {
    resetUsageCache();
    writeDay(dateOffset(0), [modelEntry(dateOffset(0), "a/b", { prompt: 1, completion: 1 })]);
    writeDay(dateOffset(1), [modelEntry(dateOffset(1), "a/b", { prompt: 1, completion: 1 })]);
    // 缺 dateOffset(2)
    writeDay(dateOffset(3), [modelEntry(dateOffset(3), "a/b", { prompt: 1, completion: 1 })]);
    const stats = computeUsageStats("7d");
    assert.equal(stats.streak.current, 2, "今天 + 昨天连续");
    assert.equal(stats.streak.longest, 2);
  });

  it("区间边界：7d 不含第 8 天", () => {
    resetUsageCache();
    writeDay(dateOffset(0), [modelEntry(dateOffset(0), "a/b", { prompt: 100, completion: 0 })]);
    writeDay(dateOffset(8), [modelEntry(dateOffset(8), "a/b", { prompt: 999, completion: 0 })]);
    const stats = computeUsageStats("7d");
    assert.equal(stats.totals.tokens, 100, "第 8 天在区间外");
  });

  it("缓存命中率：无缓存字段的请求不进分母（全无字段时为 null）", () => {
    resetUsageCache();
    const today = dateOffset(0);
    writeDay(today, [
      modelEntry(today, "a/b", { prompt: 100, completion: 0, cache: { hit: 80, miss: 20 } }),
      modelEntry(today, "a/b", { prompt: 100, completion: 0 }),
    ]);
    const stats = computeUsageStats("7d");
    assert.equal(stats.totals.cacheHitRate, 0.8, "只按带缓存字段的那条算");
  });

  it("没有任何日志时返回空结构而不是报错", () => {
    resetUsageCache();
    const stats = computeUsageStats("7d");
    assert.equal(stats.daily.length, 0);
    assert.equal(stats.totals.tokens, 0);
    assert.equal(stats.peak, null);
    assert.equal(stats.favorite, null);
    assert.equal(stats.totals.cacheHitRate, null);
  });
});
