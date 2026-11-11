/**
 * 转发层与候选选择的补充覆盖：
 * - relayUpstream 收到空响应体时按 502 upstream_error 收口；
 * - maxPoolAttempts 的环境变量解析（缺省 / 合法 / 非法值）；
 * - activeKeyOf 读到生效账号键、空池返回 undefined。
 *
 * 全程离线：假 res + 合成渠道 + 临时存储根。
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { relayUpstream } from "../dist/http/chat/forward.js";
import { activeKeyOf, maxPoolAttempts } from "../dist/http/chat/candidates.js";
import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-forward-extra-"));

before(() => {
  process.env["MODELMUX_HOME"] = HOME;
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
  clearChannels();
  delete process.env["MODELMUX_HOME"];
  delete process.env["MODELMUX_POOL_MAX_TRIES"];
});

interface FakeRes {
  res: ServerResponse;
  status: () => number | null;
  body: () => string;
}

function fakeRes(): FakeRes {
  let status: number | null = null;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(code: number): void {
      status = code;
      this.headersSent = true;
    },
    setHeader(): void {},
    once(): void {},
    on(): void {},
    end(chunk?: string): void {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

describe("relayUpstream 空响应体", () => {
  it("call.body 为 null → 502 upstream_error", async () => {
    const out = fakeRes();
    const channel = {} as Channel;
    await relayUpstream(out.res, channel, "synth", {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    }, { wantStream: false, logger: () => {} });
    assert.equal(out.status(), 502);
    const body = JSON.parse(out.body()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "upstream_error");
    assert.match(body.error.message, /empty response body/);
  });

  it("流式请求同样按 502 收口", async () => {
    const out = fakeRes();
    await relayUpstream(out.res, {} as Channel, "synth", {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    }, { wantStream: true, logger: () => {} });
    assert.equal(out.status(), 502);
  });
});

describe("maxPoolAttempts", () => {
  it("缺省 → 正无穷（不设上限）", () => {
    delete process.env["MODELMUX_POOL_MAX_TRIES"];
    assert.equal(maxPoolAttempts(), Number.POSITIVE_INFINITY);
  });

  it("合法值 → 原样采用", () => {
    process.env["MODELMUX_POOL_MAX_TRIES"] = "5";
    assert.equal(maxPoolAttempts(), 5);
  });

  it("0 / 非法值 → 回落正无穷", () => {
    process.env["MODELMUX_POOL_MAX_TRIES"] = "0";
    assert.equal(maxPoolAttempts(), Number.POSITIVE_INFINITY);
    process.env["MODELMUX_POOL_MAX_TRIES"] = "abc";
    assert.equal(maxPoolAttempts(), Number.POSITIVE_INFINITY);
    delete process.env["MODELMUX_POOL_MAX_TRIES"];
  });
});

describe("activeKeyOf", () => {
  const CID = "fwdchan";

  it("读到索引里的生效账号键", () => {
    clearChannels();
    setChannel({ config: { cid: CID } } as unknown as Channel);
    const dir = paths.channelDir(CID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({ version: 1, active: "acct-x", accounts: [{ key: "acct-x", health: "ok" }] }),
      "utf8",
    );
    assert.equal(activeKeyOf(CID), "acct-x");
  });

  it("空索引 → undefined", () => {
    clearChannels();
    setChannel({ config: { cid: "emptychan" } } as unknown as Channel);
    assert.equal(activeKeyOf("emptychan"), undefined);
  });
});
