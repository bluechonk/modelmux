/**
 * 请求上下文弹窗的滚动位置记忆（`lib/ctx-scroll.ts`）单测。
 *
 * 存储用内存假实现注入 —— Node 里没有 `window.localStorage`，而「损坏值 / 超量 /
 * 过期 / 存不下」这些分支在真机上很难复现，必须能在测试里构造。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CTX_SCROLL_MAX_ENTRIES,
  CTX_SCROLL_PREFIX,
  CTX_SCROLL_TTL_DAYS,
  ctxScrollKey,
  loadCtxScroll,
  pruneCtxScroll,
  saveCtxScroll,
  signatureOf,
} from "../src/lib/ctx-scroll.ts";

/** 内存版 Storage（只需 key/长度/读写删这几件事）。 */
function fakeStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length(): number {
      return map.size;
    },
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
    clear: (): void => map.clear(),
  } as Storage;
}

const DAY = 86_400_000;
const NOW = 1_760_000_000_000; // 固定时刻：过期判定要可复现

describe("ctx-scroll 键与签名", () => {
  it("key 归到 modelmux.* 命名空间（与 modelmux.logs.pageSize 同族）", () => {
    assert.equal(CTX_SCROLL_PREFIX, "modelmux.logs.ctx-scroll:");
    assert.equal(ctxScrollKey("req_abc"), "modelmux.logs.ctx-scroll:req_abc");
  });

  it("签名只取决于记录元数据；空记录集返回空串（= 不写记忆）", () => {
    const a = signatureOf([{ phase: "client", seq: 1, bytes: 100 }]);
    assert.equal(a, signatureOf([{ phase: "client", seq: 1, bytes: 100 }]));
    assert.notEqual(a, signatureOf([{ phase: "client", seq: 1, bytes: 101 }]), "字节数变了就是内容变了");
    assert.notEqual(
      a,
      signatureOf([
        { phase: "client", seq: 1, bytes: 100 },
        { phase: "upstream", seq: 1, bytes: 90 },
      ]),
      "重试多出一条记录也要判定为内容变化",
    );
    assert.equal(signatureOf([]), "");
  });

  it("签名与接口给的数组顺序无关（同毫秒写入的两条记录排序不稳定）", () => {
    const a = { phase: "client", seq: 1, bytes: 100 };
    const b = { phase: "upstream", seq: 2, bytes: 90 };
    assert.equal(signatureOf([a, b]), signatureOf([b, a]));
    // 形状不变（字段顺序）但值变了要认出来
    assert.notEqual(signatureOf([a, b]), signatureOf([{ ...a, seq: 9 }, b]));
  });

  it("记录很多时签名收敛成定长哈希（不给 localStorage 塞长串）", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ phase: "upstream", seq: i, bytes: 1000 + i }));
    const sig = signatureOf(many);
    assert.ok(sig.startsWith("fnv:"), `期望哈希形态，实际 ${sig.slice(0, 12)}…`);
    assert.ok(sig.length < 32);
    assert.notEqual(sig, signatureOf(many.map((r, i) => (i === 3 ? { ...r, bytes: r.bytes + 1 } : r))));
  });
});

describe("ctx-scroll 读写", () => {
  it("写入后按同一签名读回；位置取整", () => {
    const store = fakeStore();
    const sig = signatureOf([{ phase: "client", seq: 1, bytes: 10 }]);
    saveCtxScroll("req_1", 1234.6, sig, NOW, store);
    assert.equal(loadCtxScroll("req_1", sig, NOW, store), 1235);
  });

  it("内容签名不一致 → 返回 null 并删掉旧缓存（回退置顶）", () => {
    const store = fakeStore();
    saveCtxScroll("req_1", 900, signatureOf([{ phase: "client", seq: 1, bytes: 10 }]), NOW, store);
    const changed = signatureOf([
      { phase: "client", seq: 1, bytes: 10 },
      { phase: "upstream", seq: 1, bytes: 20 },
    ]);
    assert.equal(loadCtxScroll("req_1", changed, NOW, store), null);
    assert.equal(store.getItem(ctxScrollKey("req_1")), null, "旧缓存必须被清掉，不能留着误导下次");
  });

  it("过期（超过 TTL）视为没有记忆", () => {
    const store = fakeStore();
    const sig = signatureOf([{ phase: "client", seq: 1, bytes: 10 }]);
    saveCtxScroll("req_1", 500, sig, NOW - (CTX_SCROLL_TTL_DAYS + 1) * DAY, store);
    assert.equal(loadCtxScroll("req_1", sig, NOW, store), null);
  });

  it("空签名 / 负数 / NaN / 存储不可用都不写、不抛", () => {
    const store = fakeStore();
    saveCtxScroll("req_1", 100, "", NOW, store);
    saveCtxScroll("req_1", -5, "sig", NOW, store);
    saveCtxScroll("req_1", Number.NaN, "sig", NOW, store);
    saveCtxScroll("req_1", 100, "sig", NOW, null);
    assert.equal(store.length, 0);
    assert.equal(loadCtxScroll("req_1", "sig", NOW, null), null);
    assert.equal(loadCtxScroll("req_1", "", NOW, store), null, "空签名不读（还没拿到记录）");
    pruneCtxScroll(NOW, null); // 存储不可用时清理也是空操作
  });

  it("值损坏 / 形状不对 → 当没有记忆，不抛", () => {
    const sig = "sig";
    for (const raw of ["{", "null", '"str"', "[]", '{"t":"x","s":"sig","a":1}', '{"t":1,"s":2,"a":3}', '{"t":1,"s":"sig"}']) {
      const store = fakeStore({ [ctxScrollKey("req_1")]: raw });
      assert.equal(loadCtxScroll("req_1", sig, NOW, store), null, `损坏值 ${raw} 不能抛错`);
    }
  });

  it("不同 request id 各自独立（互不串位）", () => {
    const store = fakeStore();
    const sig = signatureOf([{ phase: "client", seq: 1, bytes: 10 }]);
    saveCtxScroll("req_1", 100, sig, NOW, store);
    saveCtxScroll("req_2", 900, sig, NOW, store);
    assert.equal(loadCtxScroll("req_1", sig, NOW, store), 100);
    assert.equal(loadCtxScroll("req_2", sig, NOW, store), 900);
  });
});

describe("ctx-scroll 清理", () => {
  it("删过期与损坏条目，保留未过期的", () => {
    const sig = "sig";
    const store = fakeStore({
      [ctxScrollKey("old")]: JSON.stringify({ t: 1, s: sig, a: NOW - (CTX_SCROLL_TTL_DAYS + 1) * DAY }),
      [ctxScrollKey("bad")]: "{oops",
      [ctxScrollKey("live")]: JSON.stringify({ t: 2, s: sig, a: NOW - DAY }),
      "modelmux.logs.pageSize": "20", // 非本前缀的 key 不能动
    });
    pruneCtxScroll(NOW, store);
    assert.equal(store.getItem(ctxScrollKey("old")), null);
    assert.equal(store.getItem(ctxScrollKey("bad")), null);
    assert.equal(store.getItem(ctxScrollKey("live")), "{\"t\":2,\"s\":\"sig\",\"a\":" + (NOW - DAY) + "}");
    assert.equal(store.getItem("modelmux.logs.pageSize"), "20");
  });

  it("超量时按写入时间淘汰最旧的", () => {
    const store = fakeStore();
    const sig = "sig";
    for (let i = 0; i <= CTX_SCROLL_MAX_ENTRIES; i += 1) {
      saveCtxScroll(`req_${i}`, 10, sig, NOW - (CTX_SCROLL_MAX_ENTRIES - i) * 1000, store);
    }
    assert.equal(store.length, CTX_SCROLL_MAX_ENTRIES + 1, "写路径不做淘汰（滚动热路径要便宜）");
    pruneCtxScroll(NOW, store);
    assert.equal(store.length, CTX_SCROLL_MAX_ENTRIES);
    assert.equal(store.getItem(ctxScrollKey("req_0")), null, "最旧的被淘汰");
    assert.notEqual(store.getItem(ctxScrollKey(`req_${CTX_SCROLL_MAX_ENTRIES}`)), null, "最新的留下");
  });
});
