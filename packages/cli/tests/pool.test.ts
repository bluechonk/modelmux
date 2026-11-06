/**
 * 仓库级入口冒烟：注册全部渠道 → 一个网关对外暴露 **deepseek 家族**的裸模型名。
 *
 * 存储根指向临时目录：注册全部渠道后，任何 `paths.*` 调用都会解析到
 * `<root>/<cid>/`，本测试绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-all-selftest-"));
process.env["MODELMUX_HOME"] = HOME;

/**
 * 渠道清单的**来源真相**：`packages/core/channels/<cid>/package.json` 存在即算一个渠道
 * （与 `scripts/verify-contract.mjs` 同口径）。
 *
 * 刻意**不写死数量** —— 写死就要求「每加一个渠道都回来改测试」，而这里真正要
 * 断言的是「目录里的渠道都注册上了」，数量本身不是被测对象。
 *
 * 下架渠道（包保留、不再注册，见 `channels.ts` 的 `RETIRED_CIDS`）要从这条等式里减去：
 * 等式升级成「渠道目录 == 注册清单 ∪ 下架声明」，下架必须显式声明，不能悄悄不注册。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHANNELS_DIR = join(REPO_ROOT, "packages", "core", "channels");
const EXPECTED_CIDS = readdirSync(CHANNELS_DIR)
  .filter((name) => existsSync(join(CHANNELS_DIR, name, "package.json")))
  .sort();

const gw = await import("@modelmux/gateway");
const { RETIRED_CIDS } = await import("../dist/channels.js");

/** 目录里有包、且**在注册清单里**的渠道（下架的那些从等式里减去）。 */
const ACTIVE_CIDS = EXPECTED_CIDS.filter((cid) => !RETIRED_CIDS.includes(cid));

describe("仓库级模型池", () => {
  let running: Awaited<ReturnType<typeof gw.gateway.start>>;

  before(async () => {
    running = await gw.gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await running?.close().catch(() => {});
    rmSync(HOME, { recursive: true, force: true });
  });

  it("注册清单 == 渠道目录减去下架声明（下架必须显式登记）", () => {
    const cids = gw.channels().map((c) => c.config.cid).sort();
    assert.deepEqual(cids, ACTIVE_CIDS, "注册清单与 packages/core/channels/ 目录不一致");
    assert.deepEqual(
      RETIRED_CIDS.filter((cid) => !EXPECTED_CIDS.includes(cid)),
      [],
      "下架声明必须对应真实存在的渠道包（包删了就该从 RETIRED_CIDS 划掉）",
    );
    assert.deepEqual(
      RETIRED_CIDS.filter((cid) => cids.includes(cid)),
      [],
      "下架渠道不得仍在注册清单里",
    );
    assert.ok(!cids.includes("cline"), "cline 渠道已移除");
    assert.ok(!cids.includes("zcode"), "zcode 渠道已移除");
    assert.ok(!cids.includes("orcaterm"), "orcaterm 渠道已移除");
  });

  it("服务身份是仓库级 modelmux（不是某个渠道）", async () => {
    const health = (await (await fetch(`http://${running.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "modelmux");
    const per = health["channels"] as Array<{ cid: string }>;
    assert.equal(per.length, ACTIVE_CIDS.length, "逐渠道报告");
  });

  it("/v1/models 只返回对外家族的裸模型名", async () => {
    const resp = await fetch(`http://${running.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = payload.data.map((m) => m.id).sort();
    assert.ok(ids.includes("deepseek-v4.1-flash"), `应包含 deepseek-v4.1-flash（实际 ${ids.join(", ")}）`);
    assert.ok(ids.includes("glm-5.3-flash"), `应包含 glm-5.3-flash（实际 ${ids.join(", ")}）`);
    assert.ok(
      payload.data.every((m) => gw.isPoolModel(m.id)),
      "对外 id 全部属于对外家族",
    );
    assert.ok(
      payload.data.every((m) => gw.canonicalOf(m.id) === m.id),
      "对外只列 canonical（别名不单独出现）",
    );
    const ownerOf = (id: string): string => payload.data.find((m) => m.id === id)!.owned_by;
    assert.equal(ownerOf("deepseek-v4.1-flash"), "deepseek");
    assert.equal(ownerOf("glm-5.3-flash"), "zhipu");
  });

  it("同一个模型的候选是**多家**渠道（按剩余额度降序，渠道由网关挑）", () => {
    const candsOf = (model: string) => gw.poolCandidates(model).map((c) => c.cid);
    const ds = candsOf("deepseek-v4.1-flash");
    assert.ok(ds.includes("workbuddy"), `workbuddy 应能供给 deepseek-v4.1-flash（实际 ${ds.join(", ")}）`);
    assert.ok(ds.length >= 2, `同一模型应有多家候选（实际 ${ds.join(", ")}）`);
    // 别名请求命中同一批渠道
    assert.deepEqual(candsOf("deepseek-flash"), ds);
  });

  it("池 id 与候选渠道的一致性（家族内 / 有货 / 候选都是已注册渠道）", () => {
    const known = new Set(ACTIVE_CIDS);
    // POOL_MODELS 是 Proxy（每次属性访问都重建快照），先落一份本地快照再遍历
    const pooled = [...gw.POOL_MODELS];
    assert.ok(pooled.length > 0, "POOL_MODELS 不应为空");
    for (const id of pooled) {
      assert.ok(gw.isPoolModel(id), `池 id 必须是对外家族名：${id}`);
      assert.equal(gw.canonicalOf(id), id, `池 id 必须是 canonical：${id}`);
      const cands = gw.poolCandidates(id);
      assert.ok(cands.length > 0, `池 id 至少有一个候选渠道：${id}`);
      for (const c of cands) {
        assert.ok(known.has(c.cid), `候选渠道必须是已注册渠道：${id} → ${c.cid}`);
      }
    }
  });

  it("家族外模型名 → 400 unknown_model", async () => {
    const post = (model: string) =>
      fetch(`http://${running.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        headers: { "Content-Type": "application/json" },
      });
    const bare = await post("no-such-model-anywhere-xyz");
    assert.equal(bare.status, 400);
    assert.equal(((await bare.json()) as { error: { code: string } }).error.code, "unknown_model");
    // 非家族模型（网关不代理家族外的模型名）
    for (const model of ["qwen3.8-flash", "deepseek-v4-flash", "deepseek-v4-pro"]) {
      const other = await post(model);
      assert.equal(other.status, 400, model);
      assert.equal(((await other.json()) as { error: { code: string } }).error.code, "unknown_model");
    }
  });

  it("有效的家族名请求：测试环境无凭据 → 503 not_authenticated", async () => {
    const model = gw.POOL_MODELS[0];
    assert.ok(model, "池里有模型");
    const resp = await fetch(`http://${running.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 503);
  });
});
