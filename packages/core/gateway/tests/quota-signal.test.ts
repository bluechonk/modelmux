/**
 * 额度/用量信号识别（`http/chat/errors.ts`）。
 *
 * 词表全部来自**真机原文**，不是凭感觉写的 —— 2026-10-23 之前 `isQuotaExhausted`
 * 不认 workbuddyai 的真实 6004 消息，导致账号额度打满后既不冷却、也不告诉用户等到几点，
 * 只回一个普通 502（实测：请求 200ms 失败、账号始终 ok）。
 *
 * 用例即原文片段：
 * - loomy：HTTP 402 `{"error":{"message":"积分余额不足，请获取积分后再试","type":"insufficient_quota"}}`
 * - workbuddyai：HTTP 429 `{"code":6004,"msg":"usage exceeds frequency limit, but don't
 *   worry, your usage will reset at 2026-10-23 17:36:25 UTC+8, alternatively, you can switch
 *   to the other models to continue using it."}`
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { isQuotaExhausted, isUsageLimit } from "../dist/http/chat/errors.js";

/** loomy 真实 402 原文（2026-10-23 网关日志）。 */
const LOOMY_402 =
  '{"error":{"message":"积分余额不足，请获取积分后再试","type":"insufficient_quota","param":null,"code":402,"metadata":{"provider_name":"loomy"}}';

/** workbuddyai 真实 429/6004 原文（2026-10-23 网关日志）。 */
const WB_6004 =
  '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-10-23 17:36:25 UTC+8, alternatively, you can switch to the other models to continue using it.","requestId":"01a166c24ce17954b4abb603c6643ab6"}';

describe("额度/用量信号识别", () => {
  it("loomy 402（余额不足）→ 额度信号，但不是账户级用量限额", () => {
    assert.equal(isQuotaExhausted(LOOMY_402), true);
    assert.equal(isUsageLimit(LOOMY_402), false, "余额不足不是用量限额（免费模型该继续打上游）");
  });

  it("workbuddyai 6004（用量限额）→ 额度信号，且是账户级用量限额", () => {
    assert.equal(isQuotaExhausted(WB_6004), true, "6004 必须被认出（此前漏了）");
    assert.equal(isUsageLimit(WB_6004), true, "用量限额对所有模型生效，与倍率无关");
  });

  it("普通 4xx / 参数错误不该被当成额度信号", () => {
    assert.equal(isQuotaExhausted('{"error":{"message":"invalid model name"}}'), false);
    assert.equal(isQuotaExhausted('{"error":{"message":"tool_calls must be a response to a preceding message"}}'), false);
    assert.equal(isQuotaExhausted('{"error":{"message":"content policy violation"}}'), false);
  });

  it("空体不误判", () => {
    assert.equal(isQuotaExhausted(""), false);
    assert.equal(isQuotaExhausted("not json at all"), false);
  });

  /**
   * 架构守卫：**共享层不许出现渠道业务码**（AGENTS.md：共享层不许出现任何渠道知识）。
   *
   * 渠道自己的码（如 workbuddyai 的 `6004`）必须由渠道包经 `upstream.quotaSignal()` 上报；
   * 一旦有人把它写回共享层的正则里，这个用例就红 —— 防止知识回流。
   * 注释里提到码名是允许的（说明知识归属），只查**可执行代码**（去掉注释与字符串里的码名示例）。
   */
  it("共享层代码里没有渠道业务码（6004 只能由渠道上报）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sharedRoot = join(here, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readFileSync === undefined ? [] : readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        // 去掉注释行（// 与 /* */），只留可执行代码
        const code = readFileSync(full, "utf8")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
          .join("\n");
        if (/\b6004\b/.test(code)) offenders.push(full.replace(sharedRoot, "src"));
      }
    };
    walk(sharedRoot);
    assert.deepEqual(offenders, [], `共享层出现了渠道业务码 6004：${offenders.join(", ")}`);
  });
});
