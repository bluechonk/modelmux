/**
 * 上下文弹窗两头加载的不变量（`lib/payload-slices.ts`）。
 *
 * 这套模型的硬约束只有两条，测试全钉在这里：
 *   1. 窗口**按格对齐** ⇒ 任意两个窗口要么相同、要么不相交（并发到达也不会拼出重复段）；
 *   2. 两头接上 ⇔ 按格拼接就是完整正文 —— 接不上时不许拼（半截正文会被解析成
 *      「真的就只有这些消息」，这是最想堵住的坑）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembledBody,
  growHead,
  growTail,
  initialSpan,
  nextHeadRequest,
  nextTailRequest,
  PAYLOAD_SLICE,
  spanComplete,
  spanGapBytes,
  type SliceSpan,
  type SliceWindow,
  unionText,
  windowsTileFully,
} from "../src/lib/payload-slices.ts";

/** 造一片：正文用 `offset:length` 占位（只看结构不看内容）。 */
function win(offset: number, length: number, total: number): SliceWindow {
  return { offset, length, total, body: `${offset}:${length}` };
}

/** 模拟服务端：按请求参数给一片，到末尾自动变短。 */
function serve(span: SliceSpan, req: { offset: number; limit: number }): SliceWindow {
  return win(req.offset, Math.min(req.limit, span.total - req.offset), span.total);
}

describe("两头加载：进度推进", () => {
  it("首屏头尾各一格（1 MB 正文）", () => {
    const total = 1_000_000;
    let span = initialSpan(total);
    const head = nextHeadRequest(span)!;
    const tail = nextTailRequest(span)!;
    assert.deepEqual(head, { offset: 0, limit: PAYLOAD_SLICE });
    assert.equal(tail.offset, (Math.ceil(total / PAYLOAD_SLICE) - 1) * PAYLOAD_SLICE, "尾侧取末格");
    assert.equal(tail.offset % PAYLOAD_SLICE, 0, "末格起点同样是格边界");
    span = growHead(span, serve(span, head));
    span = growTail(span, serve(span, tail));
    assert.equal(span.headEnd, PAYLOAD_SLICE);
    assert.equal(span.tailStart, tail.offset);
    assert.equal(spanGapBytes(span), total - PAYLOAD_SLICE - tail.limit);
    assert.equal(spanComplete(span), false);
  });

  it("短片（小于一格）：头尾申请同一格（各取一次，拼接时去重）", () => {
    const span = initialSpan(1000);
    const head = nextHeadRequest(span)!;
    assert.deepEqual(head, { offset: 0, limit: 1000 });
    assert.deepEqual(nextTailRequest(span), head, "同一格被两头各取一次，好过让某一方向卡住");
    // 两片都到 → 进度合上，正文只有一份
    const one = serve(span, head);
    const two = growTail(growHead(span, one), { ...one });
    assert.equal(spanComplete(two), true);
    assert.equal(unionText([one, { ...one }]), "0:1000");
  });

  it("整格整除：末格仍是整格，两头相向逐格收敛", () => {
    const total = PAYLOAD_SLICE * 4;
    let span = initialSpan(total);
    for (let i = 0; i < 6 && !spanComplete(span); i += 1) {
      const head = nextHeadRequest(span);
      if (head !== null) span = growHead(span, serve(span, head));
      const tail = nextTailRequest(span);
      if (tail !== null) span = growTail(span, serve(span, tail));
    }
    assert.equal(spanComplete(span), true);
    assert.equal(span.headEnd, 2 * PAYLOAD_SLICE);
    assert.equal(span.tailStart, 2 * PAYLOAD_SLICE);
    assert.equal(
      windowsTileFully(
        [0, 1, 2, 3].map((k) => win(k * PAYLOAD_SLICE, PAYLOAD_SLICE, total)),
        total,
      ),
      true,
      "四格铺满",
    );
  });

  it("并发同取「中间那一格」：两头都拿到同一格，进度合得上、正文不重复", () => {
    const total = PAYLOAD_SLICE * 3 + 10; // 4 格：两格头侧、一格尾侧后只剩中间一格
    let span = initialSpan(total);
    span = growHead(span, serve(span, nextHeadRequest(span)!)); // [0, 1)
    span = growHead(span, serve(span, nextHeadRequest(span)!)); // [1, 2)
    span = growTail(span, serve(span, nextTailRequest(span)!)); // [3, 4)（末格短）
    const head = nextHeadRequest(span)!;
    const tail = nextTailRequest(span)!;
    assert.deepEqual(head, { offset: 2 * PAYLOAD_SLICE, limit: PAYLOAD_SLICE });
    assert.deepEqual(tail, head, "只剩一格时两头申请的是同一格");
    // 两侧各拿一份（同一格的两次取回）
    const windowBody = serve(span, head);
    span = growHead(span, windowBody);
    span = growTail(span, { ...windowBody });
    assert.equal(spanComplete(span), true);
    const text = unionText([
      win(0, PAYLOAD_SLICE, total),
      win(PAYLOAD_SLICE, PAYLOAD_SLICE, total),
      { ...windowBody },
      windowBody,
      win(3 * PAYLOAD_SLICE, 10, total),
    ]);
    assert.equal(
      text,
      `${0}:${PAYLOAD_SLICE}${PAYLOAD_SLICE}:${PAYLOAD_SLICE}${2 * PAYLOAD_SLICE}:${PAYLOAD_SLICE}${3 * PAYLOAD_SLICE}:10`,
      "同一格只出现一次",
    );
  });

  it("乱序到达：不相邻的窗口先到也不推进进度（等相邻格补上）", () => {
    const span = initialSpan(PAYLOAD_SLICE * 4);
    // 尾侧末格先到，头侧第 2 格（不相邻）后到
    const afterTail = growTail(span, serve(span, nextTailRequest(span)!));
    const bogus = growHead(afterTail, win(2 * PAYLOAD_SLICE, PAYLOAD_SLICE, span.total));
    assert.equal(bogus.headEnd, 0, "头侧进度只能被紧邻格推进");
    const real = growHead(bogus, win(0, PAYLOAD_SLICE, span.total));
    assert.equal(real.headEnd, PAYLOAD_SLICE);
  });

  it("空窗口（服务端没给正文）不推进进度", () => {
    const span = initialSpan(PAYLOAD_SLICE * 2);
    assert.equal(growHead(span, win(0, 0, span.total)).headEnd, 0);
    assert.equal(growTail(span, win(PAYLOAD_SLICE, 0, span.total)).tailStart, span.total);
  });
});

describe("完整正文：只在接上后按格拼", () => {
  it("未接上：返回空串（不许拿半截正文去解析）", () => {
    const span = { headEnd: 10, tailStart: 90, total: 100 };
    assert.equal(assembledBody({ recordBody: "", span, windows: [] }), "");
  });

  it("接上：按 offset 拼接，窗口乱序进来也一样", () => {
    const span = { headEnd: 50, tailStart: 50, total: 100 };
    const windows = [win(50, 50, 100), win(0, 50, 100)];
    assert.equal(assembledBody({ recordBody: "", span, windows }), "0:5050:50");
  });

  it("record.body 非空（调用方给了整段）：直用，不看进度", () => {
    const span = { headEnd: 0, tailStart: 100, total: 100 };
    assert.equal(assembledBody({ recordBody: "whole", span, windows: [] }), "whole");
  });
});

describe("请求参数：收尾与边界", () => {
  it("已取全时两个方向都返回 null", () => {
    const span = { headEnd: 100, tailStart: 100, total: 100 };
    assert.equal(nextHeadRequest(span), null);
    assert.equal(nextTailRequest(span), null);
    assert.equal(spanComplete(span), true);
    assert.equal(spanGapBytes(span), 0);
  });

  it("铺满校验：缺一格 / 末格没到 total / 首格不从 0 起都判为没铺满", () => {
    const total = PAYLOAD_SLICE * 3;
    const full = [0, 1, 2].map((k) => win(k * PAYLOAD_SLICE, PAYLOAD_SLICE, total));
    assert.equal(windowsTileFully(full, total), true);
    assert.equal(windowsTileFully([full[0]!, full[2]!], total), false, "中间缺一格");
    assert.equal(windowsTileFully(full.slice(0, 2), total), false, "末格没到 total");
    assert.equal(
      windowsTileFully([win(PAYLOAD_SLICE, PAYLOAD_SLICE, total), win(2 * PAYLOAD_SLICE, PAYLOAD_SLICE, total)], total),
      false,
      "首格不从 0 起",
    );
    assert.equal(windowsTileFully([], 0), true, "空正文（total 0）视为铺满");
  });

  it("只剩一格时两头申请同一格：两个方向都能收尾（不会有一侧卡住）", () => {
    const span: SliceSpan = { headEnd: 2 * PAYLOAD_SLICE, tailStart: 3 * PAYLOAD_SLICE, total: 4 * PAYLOAD_SLICE };
    const head = nextHeadRequest(span)!;
    assert.deepEqual(head, { offset: 2 * PAYLOAD_SLICE, limit: PAYLOAD_SLICE });
    assert.deepEqual(nextTailRequest(span), head, "向上滚也补得上，不必等用户改方向");
  });
});
