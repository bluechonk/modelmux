/**
 * 额度耗尽自动换号（判据与边界见 docs/ACCOUNT-ROTATION.md）。
 *
 * 只测**决策层**：`rotateExhaustedAccount` 的两段式账单判据（本地快照 → 实时重查）、
 * 挑替代账号的取舍、以及各种「证据不足就不动账号」的边界。全程只读临时存储根，
 * 不发起任何上游请求（额度查询是注入的测试替身）。
 *
 * ⚠ 刻意**不搭假上游**做 relay 级端到端：按仓库测试红线，测试不得把渠道的上游
 * 地址指向本机假服务（那证明的不是真实行为，误配还会撞真上游触发风控）。
 * relay 那层「失败 → 换号 → 同候选重试一次」的接线由**代码审查 + 真机请求**核验。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { accountKey, readIndex } from "../dist/runtime/account-pool.js";
import { LOW_CREDIT_THRESHOLD, rotateExhaustedAccount, switchOffCoolingAccount } from "../dist/pool/account-rotate.js";
import { resetPoolLedgerForTest, writeAccountBilling } from "../dist/pool/pool-usage.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "synthrot";

/** 额度查询的假实现：按凭据的 accessToken 给余额，并记录查询过的 token。 */
interface BillingSpec {
  /** token → 余额（缺省 = 上游没给 remain 数字）。 */
  live: Record<string, number | undefined>;
  /** 观测：每次实时查询用的 token。 */
  calls: string[];
  /** 让查询抛错（模拟网络失败）。 */
  fail?: boolean;
}

function configOf(cid: string): ChannelConfig {
  return {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
}

function makeChannel(cid: string, spec: BillingSpec): Channel {
  return {
    config: configOf(cid),
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      // 读 live 凭据（不带 cid：必须走 ALS 上下文，与真实渠道一致）
      load: (): Record<string, unknown> =>
        JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>,
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_ROTATE_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken?: string }) => ({
        Authorization: `Bearer ${String(credential?.accessToken ?? "")}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async (options: { credential?: { accessToken?: string } } = {}) => {
        if (spec.fail) throw new Error("额度端点不可达");
        const token = String(options.credential?.accessToken ?? "");
        spec.calls.push(token);
        const remain = spec.live[token];
        return remain === undefined
          ? { ok: true, total: {}, packages: [] }
          : {
              ok: true,
              total: { remain, size: 1000, used: 1000 - remain, unit: "credits", remain_percent: remain / 10 },
              packages: [],
            };
      },
    },
  } as unknown as Channel;
}

interface SeedAccount {
  key: string;
  uid: string;
  token: string;
  health?: string;
  cooldownUntil?: string | null;
}

/** 铺现场：写 credentials.json（live = active）+ accounts.json + 各账号凭证文件。 */
function seedPool(accounts: SeedAccount[], activeKey: string): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  const live = accounts.find((a) => a.key === activeKey)!;
  const writeCred = (a: SeedAccount): void => {
    writeFileSync(
      join(dir, "accounts", `${a.key}.json`),
      JSON.stringify({ uid: a.uid, domain: "d", accessToken: a.token }),
      "utf8",
    );
  };
  for (const a of accounts) writeCred(a);
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ uid: live.uid, domain: "d", accessToken: live.token }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: activeKey,
      accounts: accounts.map((a) => ({
        key: a.key,
        uid: a.uid,
        domain: "d",
        label: `label-${a.key.slice(0, 4)}`,
        name: "",
        added_at: "2026-10-28T00:00:00.000Z",
        last_used_at: "2026-10-28T00:00:00.000Z",
        expires_at: null,
        health: a.health ?? "ok",
        health_at: "2026-10-28T00:00:00.000Z",
        fail_streak: 0,
        cooldown_until: a.cooldownUntil ?? null,
      })),
    }),
    "utf8",
  );
}

const keyOf = (uid: string): string => accountKey({ uid, domain: "d", accessToken: `tok-${uid}` });

describe("额度耗尽自动换号（决策）", () => {
  let root = "";
  let saved: string | undefined;
  const spec: BillingSpec = { live: {}, calls: [] };
  const A = keyOf("ua");
  const B = keyOf("ub");
  const C = keyOf("uc");

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-rotate-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel(CID, spec));
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    clearChannels();
    resetPoolLedgerForTest();
    rmSync(root, { recursive: true, force: true });
  });

  /** 每个用例都重置现场：账本缓存与落盘、额度假实现、池子。 */
  function scene(live: Record<string, number | undefined>, accounts: SeedAccount[], active = A): void {
    // ⚠ 账本是「内存缓存 + 1s 节流落盘」：只清缓存不够，上一轮用例可能已经把
    // 旧余额写进了文件，重新加载会把它读回来 → 必须连文件一起删。
    resetPoolLedgerForTest();
    rmSync(paths.poolUsagePath(), { force: true });
    spec.live = live;
    spec.calls = [];
    delete spec.fail;
    seedPool(accounts, active);
  }

  const threeAccounts: SeedAccount[] = [
    { key: A, uid: "ua", token: "tok-ua" },
    { key: B, uid: "ub", token: "tok-ub" },
    { key: C, uid: "uc", token: "tok-uc" },
  ];

  it("最近一次账单还有额度（≥100）→ 不换号、不联网重查", async () => {
    scene({ "tok-ua": 500 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 500, size: 1000, used: 500, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不像额度问题"), result.reason);
    assert.deepEqual(spec.calls, [], "本地快照足够下结论，不该联网");
    assert.equal(readIndex(CID).active, A, "生效账号不变");
  });

  it("错误码明确是额度问题（quota_exhausted）→ 快照不否决，联网重查后换号（2026-10-28 事故复现）", async () => {
    // 事故现场：账本快照停在 117（滞后），实时已经打到 0 —— 旧逻辑被快照挡住，一直不换号
    // 池内只留「耗尽的生效账号 + 一个满额备选」：避免受挑号排序影响
    //（`pickAlternative` 会把「未知额度」排在「已知额度」之前，见 findings 记录）
    scene({ "tok-ua": 0, "tok-ub": 20000 }, [
      { key: A, uid: "ua", token: "tok-ua" },
      { key: B, uid: "ub", token: "tok-ub" },
    ]);
    writeAccountBilling(CID, A, { total: { remain: 117, size: 20000, used: 19883, unit: "credits" } });
    writeAccountBilling(CID, B, { total: { remain: 20000, size: 20000, used: 0, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID, undefined, { code: "quota_exhausted" });
    assert.equal(result.switched, true, `应换号，实际没换：${result.reason}`);
    assert.deepEqual(spec.calls, ["tok-ua"], "跳过快照，直接联网重查生效账号");
    assert.equal(readIndex(CID).active, B, "切到有额度的账号");
  });

  it("quota_exhausted 但实时重查仍 ≥100 → 不换号（上游误报时不乱换）", async () => {
    scene({ "tok-ua": 800 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 117, size: 20000, used: 19883, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID, undefined, { code: "quota_exhausted" });
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不是额度问题"), result.reason);
    assert.equal(readIndex(CID).active, A, "安全网：实时值说了算");
  });

  it("模糊错误（upstream_error）→ 快照 ≥100 仍兜底不换（防抖动误换保留）", async () => {
    scene({ "tok-ua": 0 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 117, size: 20000, used: 19883, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID, undefined, { code: "upstream_error" });
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不像额度问题"), result.reason);
    assert.deepEqual(spec.calls, [], "模糊错误由快照兜底，不联网");
  });

  it("生效账号冷却 + 池内有可用账号 → 请求发出前提前切走", () => {
    scene({ "tok-ub": 20000 }, [
      { key: A, uid: "ua", token: "tok-ua", health: "cooldown", cooldownUntil: new Date(Date.now() + 600_000).toISOString() },
      { key: B, uid: "ub", token: "tok-ub" },
    ]);
    writeAccountBilling(CID, B, { total: { remain: 20000, size: 20000, used: 0, unit: "credits" } });

    const result = switchOffCoolingAccount(CID);
    assert.equal(result.switched, true, `应切走，实际：${result.reason}`);
    assert.equal(readIndex(CID).active, B);
    assert.deepEqual(spec.calls, [], "切号只读本地状态，不联网查额度");
  });

  it("生效账号冷却 + 池内其它账号也不可用 → 不切，如实短路", () => {
    const cooldown = new Date(Date.now() + 600_000).toISOString();
    scene({}, [
      { key: A, uid: "ua", token: "tok-ua", health: "cooldown", cooldownUntil: cooldown },
      { key: B, uid: "ub", token: "tok-ub", health: "cooldown", cooldownUntil: cooldown },
      { key: C, uid: "uc", token: "tok-uc", health: "unauthorized" },
    ]);

    const result = switchOffCoolingAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("都不可用"), result.reason);
    assert.equal(readIndex(CID).active, A, "生效账号不变");
  });

  it("生效账号不在冷却 → 提前切号不动作", () => {
    scene({}, threeAccounts);
    const result = switchOffCoolingAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不在冷却中"), result.reason);
  });

  it("挑替代账号：已知够用 > 未知（2026-10-28 排序修正）", async () => {
    // A 耗尽，B 已知还有 20000，C 从没查过 → 应切到 B，而不是「更未知」的 C
    scene({ "tok-ua": 0 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 20000, used: 20000, unit: "credits" } });
    writeAccountBilling(CID, B, { total: { remain: 20000, size: 20000, used: 0, unit: "credits" } });
    // C 刻意不写账本：known = null（未知）

    const result = await rotateExhaustedAccount(CID, undefined, { code: "quota_exhausted" });
    assert.equal(result.switched, true, result.reason);
    assert.equal(readIndex(CID).active, B, "已知够用的 B 应优先于未知的 C");
  });

  it("挑替代账号：未知 > 已知不够用（保留原意图）", async () => {
    // A 耗尽，B 已知只剩 20（不够用），C 从未查过 → 选 C
    scene({ "tok-ua": 0 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 20000, used: 20000, unit: "credits" } });
    writeAccountBilling(CID, B, { total: { remain: 20, size: 20000, used: 19980, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID, undefined, { code: "quota_exhausted" });
    assert.equal(result.switched, true, result.reason);
    assert.equal(readIndex(CID).active, C, "未知的 C 应优先于已知不够用的 B");
  });

  it("挑替代账号：全未知时稳定取一个，不抛错", async () => {
    scene({ "tok-ua": 0 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 20000, used: 20000, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID, undefined, { code: "quota_exhausted" });
    assert.equal(result.switched, true, result.reason);
    const active = readIndex(CID).active;
    assert.ok(active === B || active === C, `应切到池内某个账号，实际 ${active}`);
  });

  it("快照 <100 且实时重查 <100 → 换到池内额度最高的账号，旧账号标冷却", async () => {
    scene({ "tok-ua": 0, "tok-ub": 300, "tok-uc": 900 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 1000, used: 1000, unit: "credits" } });
    writeAccountBilling(CID, B, { total: { remain: 300, size: 1000, used: 700, unit: "credits" } });
    writeAccountBilling(CID, C, { total: { remain: 900, size: 1000, used: 100, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, true);
    assert.deepEqual(spec.calls, ["tok-ua"], "只重查生效账号自己");
    assert.equal(readIndex(CID).active, C, "切到额度最高的账号");
    assert.equal(result.to, `${C.slice(0, 8)}…`);
    const old = readIndex(CID).accounts.find((a) => a.key === A)!;
    assert.equal(old.health, "cooldown", "额度不足是冷却不是故障");
    assert.ok((old.cooldown_reason ?? "").includes("自动换号"), old.cooldown_reason);
    assert.equal(old.fail_streak, 0, "额度不足不吃连败");
  });

  it("快照 <100 但实时重查 ≥100 → 不换号（说明是别的问题）", async () => {
    scene({ "tok-ua": 800 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 1000, used: 1000, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不是额度问题"), result.reason);
    assert.equal(readIndex(CID).active, A);
    assert.equal(readIndex(CID).accounts.find((a) => a.key === A)!.health, "ok", "没换号就不该动状态");
  });

  it("从未查过额度（快照缺失）+ 实时 ≥100 → 不换号", async () => {
    scene({ "tok-ua": 300 }, threeAccounts);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.equal(result.remain, 300);
    assert.deepEqual(spec.calls, ["tok-ua"], "没查过才需要实测一次");
  });

  it("池内只有一个账号 → 不换号，也不联网", async () => {
    scene({ "tok-ua": 0 }, [{ key: A, uid: "ua", token: "tok-ua" }]);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("只有一个账号"), result.reason);
    assert.deepEqual(spec.calls, []);
  });

  it("实时重查抛错 → 不换号（拿不到证据就不动账号）", async () => {
    scene({}, threeAccounts);
    spec.fail = true;
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("重查失败"), result.reason);
    assert.equal(readIndex(CID).active, A);
  });

  it("额度端点没返回数字 → 不换号", async () => {
    scene({}, threeAccounts);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("没返回数字"), result.reason);
  });

  it("额度确实不足，但其它账号都在冷却 / 凭据失效 → 不换号（旧账号仍标冷却）", async () => {
    scene({ "tok-ua": 0 }, [
      { key: A, uid: "ua", token: "tok-ua" },
      { key: B, uid: "ub", token: "tok-ub", health: "cooldown", cooldownUntil: new Date(Date.now() + 600_000).toISOString() },
      { key: C, uid: "uc", token: "tok-uc", health: "unauthorized" },
    ]);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("都不可用"), result.reason);
    assert.equal(readIndex(CID).active, A);
    assert.equal(
      readIndex(CID).accounts.find((a) => a.key === A)!.health,
      "cooldown",
      "结论仍是「额度不足」，只是没有去处",
    );
  });

  it("阈值是共享常量（100），不是散落魔数", () => {
    assert.equal(LOW_CREDIT_THRESHOLD, 100);
  });
});
