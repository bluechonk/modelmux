/**
 * 端口工具单测：地址展示/规范化、PID 枚举与排除、bindFreeServer 的占用处理。
 *
 * 不 mock netstat/tasklist —— 用真实回环端口上的监听进程驱动平台分支，
 * 保证解析逻辑与真实输出兼容（netstat 行格式是外部事实）。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  PortBusyError,
  baseUrlOf,
  bindFreeServer,
  displayBase,
  excludeSelf,
  exeName,
  findPortPids,
  isAbs,
  procName,
} from "../dist/http/portfree.js";

describe("displayBase / baseUrlOf / isAbs", () => {
  it("空与通配 host 回显 127.0.0.1", () => {
    assert.equal(displayBase("127.0.0.1:4412"), "127.0.0.1:4412");
    assert.equal(displayBase("0.0.0.0:4412"), "127.0.0.1:4412");
    assert.equal(displayBase(":4412"), "127.0.0.1:4412");
  });

  it("无端口与裸 IPv6 原样返回", () => {
    assert.equal(displayBase("localhost"), "localhost");
    assert.equal(displayBase("::1"), "::1");
  });

  it("baseUrlOf 拼出可请求的 http 地址", () => {
    assert.equal(baseUrlOf("127.0.0.1:4412"), "http://127.0.0.1:4412");
    assert.equal(baseUrlOf(":4412"), "http://127.0.0.1:4412");
  });

  it("isAbs 识别盘符与 POSIX 绝对路径", () => {
    assert.equal(isAbs("C:\\data\\x"), true);
    assert.equal(isAbs("/usr/local"), true);
    assert.equal(isAbs("relative/path"), false);
  });

  it("exeName 返回非空小写基名", () => {
    const name = exeName();
    assert.ok(typeof name === "string" && name.length > 0);
    assert.equal(name, name.toLowerCase());
  });
});

describe("findPortPids / excludeSelf / procName", () => {
  let server: Server;
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = createServer();
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    server.close();
  });

  it("能在 netstat / lsof 的真实输出里找到监听进程（含自身）", () => {
    const pids = findPortPids(port);
    assert.ok(pids.length > 0, "测试进程自己就监听着这个端口，必须能找到");
  });

  it("excludeSelf 过滤自身与系统保留 PID", () => {
    assert.deepEqual(excludeSelf([process.pid, 0, 4, 999999]), [999999]);
  });

  it("procName 对自身进程返回非空名；对不存在的 PID 返回空串", () => {
    assert.ok(procName(process.pid).length > 0);
    assert.equal(procName(9_999_999), "");
  });

  it("未被监听的端口枚举为空", () => {
    assert.deepEqual(findPortPids(1), [], "端口 1（tcpmux）几乎不可能被测试进程监听");
  });
});

describe("bindFreeServer", () => {
  let occupied: Server;
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => {
      occupied = createServer();
      occupied.listen(0, "127.0.0.1", () => resolve());
    });
    port = (occupied.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it("空闲端口直接绑定成功", async () => {
    const server = await bindFreeServer("127.0.0.1", 0, () => {});
    assert.ok(server.listening);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("端口被他人占用且非交互环境 → PortBusyError（绝不静默杀第三方进程）", async () => {
    // 测试进程名（node / cli.bundle）与占用进程一致与否不重要：
    // 非交互 stdin 下一律走「请求确认」分支 → 拒绝 → 报错
    await assert.rejects(
      bindFreeServer("127.0.0.1", port, () => {}),
      (err: unknown) => err instanceof PortBusyError && /held by|in use/.test(err.message),
    );
  });
});
