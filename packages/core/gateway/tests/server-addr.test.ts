/**
 * 服务标识与地址解析：serviceName / knownServiceNames / splitAddr。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { knownServiceNames, serviceName, splitAddr } from "../dist/http/server.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const CID = "svc";

function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Svc ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  return { config, cred: {}, upstream: {}, catalog: {}, billing: {} } as unknown as Channel;
}

before(() => {
  process.env["MODELMUX_HOME"] = mkdtempSync(join(tmpdir(), "mx-svc-"));
  clearChannels();
  setChannel(makeChannel(CID));
});

after(() => {
  clearChannels();
  rmSync(process.env["MODELMUX_HOME"]!, { recursive: true, force: true });
  delete process.env["MODELMUX_HOME"];
});

describe("splitAddr", () => {
  it("普通 host:port", () => {
    assert.deepEqual(splitAddr("127.0.0.1:4412"), ["127.0.0.1", "4412"]);
  });

  it("无端口 → host 回落 127.0.0.1", () => {
    assert.deepEqual(splitAddr("8800"), ["127.0.0.1", "8800"]);
  });

  it("IPv6 [v6]:port", () => {
    assert.deepEqual(splitAddr("[::1]:4412"), ["::1", "4412"]);
  });

  it("空 host → 127.0.0.1", () => {
    assert.deepEqual(splitAddr(":4412"), ["127.0.0.1", "4412"]);
  });
});

describe("serviceName / knownServiceNames", () => {
  it("单渠道时省略 cid 也返回该 cid", () => {
    assert.equal(serviceName(), CID);
    assert.equal(serviceName(CID), CID);
  });

  it("多渠道时省略 cid → modelmux；显式 cid 原样返回", () => {
    setChannel(makeChannel("two"));
    assert.equal(serviceName(), "modelmux");
    assert.equal(serviceName("two"), "two");
  });

  it("knownServiceNames 含 modelmux 与全部在册 cid", () => {
    const names = knownServiceNames();
    assert.ok(names.includes("modelmux"));
    assert.ok(names.includes(CID));
    assert.ok(names.includes("two"));
  });
});
