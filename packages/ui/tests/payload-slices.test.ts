/**
 * 上下文弹窗分片推进的状态机不变量（`lib/payload-slices.ts`）。
 *
 * 这里出过两个实测 bug，测试按 bug 复现路径钉死：
 *   1. 「首屏永远空串」：首片（offset=0）必须自动进正文 —— 否则任何解析都拿不到输入；
 *   2. 「首片拼两遍」：推进到 offset=64K 后消费的必须是**该片对应**的续片数据，
 *      不是手里残留的首片。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembledBody, hasMore, nextOffset, PAYLOAD_SLICE } from "../src/lib/payload-slices.ts";

const first = { body: "F".repeat(100) };
const second = { body: "S".repeat(100) };

describe("assembledBody：三态", () => {
  it("首屏（offset=0）：正文 = 首片（旧 bug：这里恒为空串）", () => {
    const text = assembledBody({ recordBody: "", loaded: "", offset: 0, firstSlice: first });
    assert.equal(text, first.body);
  });

  it("续片（offset=64K）：正文 = 已积累 + 续片数据（旧 bug：这里拼成首片×2）", () => {
    const text = assembledBody({
      recordBody: "",
      loaded: first.body,
      offset: PAYLOAD_SLICE,
      nextSlice: second,
    });
    assert.equal(text, first.body + second.body);
    assert.notEqual(text, first.body + first.body, "不得重复首片");
  });

  it("当前片未到达：正文只含已积累部分（不卡渲染）", () => {
    const text = assembledBody({
      recordBody: "",
      loaded: first.body,
      offset: PAYLOAD_SLICE,
      nextSlice: undefined,
    });
    assert.equal(text, first.body);
  });

  it("record.body 非空（full=1 路径）：整段直用，不叠加", () => {
    const text = assembledBody({
      recordBody: "whole",
      loaded: "x",
      offset: PAYLOAD_SLICE,
      firstSlice: first,
      nextSlice: second,
    });
    assert.equal(text, "whole");
  });
});

describe("nextOffset / hasMore", () => {
  it("推进一整片；最后一片夹到 total（短片合法）", () => {
    assert.equal(nextOffset(0, 1_000_000), PAYLOAD_SLICE);
    assert.equal(nextOffset(PAYLOAD_SLICE * 3, PAYLOAD_SLICE * 3 + 100), PAYLOAD_SLICE * 3 + 100);
  });

  it("到顶后 hasMore=false（懒加载停止），未到顶为 true", () => {
    assert.equal(hasMore({ recordBody: "", offset: 0, total: PAYLOAD_SLICE * 2 }), true);
    assert.equal(hasMore({ recordBody: "", offset: PAYLOAD_SLICE * 2, total: PAYLOAD_SLICE * 2 }), false);
    assert.equal(hasMore({ recordBody: "whole", offset: 0, total: 10 }), false, "整段在手时不取");
  });
});
