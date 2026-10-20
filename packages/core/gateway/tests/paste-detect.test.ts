/**
 * 粘贴兜底的文本识别（`auth/paste-detect.ts`）。
 *
 * 重点验三件事：**授权失败页认得出**（认出来立刻结束等待，不白等 5 分钟）、
 * **正常授权码 / 回调 URL 提得准**、**垃圾输入不误判**（宁可当没粘到，
 * 也不能换出一个假授权码去换 token）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractPastedCallback,
  isPastedAuthFailure,
  pastedAuthFailureReason,
} from "../dist/auth/paste-detect.js";

describe("1. 授权失败页：认得出", () => {
  it("英文措辞（denied / access_denied）", () => {
    assert.equal(isPastedAuthFailure("Access denied"), true);
    assert.equal(isPastedAuthFailure("The user denied the request"), true);
    assert.equal(isPastedAuthFailure("http://127.0.0.1:9000/cb?error=access_denied"), true);
  });

  it("英文措辞（error= / errmsg=）", () => {
    assert.equal(isPastedAuthFailure("http://127.0.0.1:9000/cb?error=invalid_request"), true);
    assert.equal(isPastedAuthFailure("http://127.0.0.1:9000/cb?errmsg=boom"), true);
  });

  it("中文措辞（拒绝 / 失败）", () => {
    assert.equal(isPastedAuthFailure("用户拒绝了授权"), true);
    assert.equal(isPastedAuthFailure("授权失败"), true);
  });

  it("正常内容不算失败页", () => {
    assert.equal(isPastedAuthFailure(""), false);
    assert.equal(isPastedAuthFailure("   "), false);
    assert.equal(isPastedAuthFailure("http://127.0.0.1:9000/oauth/callback?code=abc123&state=xyz"), false);
    assert.equal(isPastedAuthFailure("abc123"), false);
  });
});

describe("2. 失败原因：能问出更具体的就问", () => {
  it("从 query 里取 errmsg / error_description / error", () => {
    assert.equal(
      pastedAuthFailureReason("http://127.0.0.1:9000/cb?errmsg=user+canceled"),
      "user canceled",
    );
    assert.equal(
      pastedAuthFailureReason("http://127.0.0.1:9000/cb?error_description=access+denied"),
      "access denied",
    );
    assert.equal(
      pastedAuthFailureReason("http://127.0.0.1:9000/cb?error=invalid_scope"),
      "invalid_scope",
    );
  });

  it("问不出原因时给通用话术", () => {
    assert.equal(
      pastedAuthFailureReason("用户拒绝了授权"),
      "the browser reported an authorization error",
    );
    assert.equal(
      pastedAuthFailureReason("http://127.0.0.1:9000/cb?error=access_denied"),
      "access_denied",
    );
  });

  it("不是失败页时返回空串", () => {
    assert.equal(pastedAuthFailureReason("http://127.0.0.1:9000/cb?code=abc123"), "");
  });
});

describe("3. 授权码 / 回调 URL：提得准", () => {
  it("整条回调 URL", () => {
    const got = extractPastedCallback("http://127.0.0.1:9000/oauth/callback?code=abc123&state=xyz");
    assert.equal(got.code, "abc123");
    assert.equal(got.state, "xyz");
    assert.equal(got.url, "http://127.0.0.1:9000/oauth/callback?code=abc123&state=xyz");
  });

  it("查询串 / 片段 / 裸 query / 裸码", () => {
    assert.equal(extractPastedCallback("?code=abc123&state=xyz").code, "abc123");
    assert.equal(extractPastedCallback("#code=abc123&state=xyz").code, "abc123");
    assert.equal(extractPastedCallback("code=abc123&state=xyz").code, "abc123");
    assert.equal(extractPastedCallback("abc123").code, "abc123");
    assert.equal(extractPastedCallback("?code=abc123&state=xyz").state, "xyz");
  });

  it("URL 的授权码在 fragment 里也认", () => {
    const got = extractPastedCallback("http://127.0.0.1:9000/oauth/callback#code=abc123&state=xyz");
    assert.equal(got.code, "abc123");
    assert.equal(got.state, "xyz");
  });

  it("授权失败页里没有授权码", () => {
    const got = extractPastedCallback("http://127.0.0.1:9000/cb?error=access_denied");
    assert.equal(got.code, "");
    assert.equal(got.state, "");
  });
});

describe("4. 垃圾输入：不误判", () => {
  it("空 / 空白", () => {
    for (const raw of ["", "   ", "\n\t"]) {
      const got = extractPastedCallback(raw);
      assert.deepEqual(got, { code: "", state: "", url: "" }, `输入 ${JSON.stringify(raw)}`);
      assert.equal(isPastedAuthFailure(raw), false);
    }
  });

  it("不是码的杂字", () => {
    for (const raw of ["hello world", "!!!@@@###", "code=", "foo=bar", "我登录不上去"]) {
      assert.equal(extractPastedCallback(raw).code, "", `输入 ${JSON.stringify(raw)}`);
    }
  });
});
