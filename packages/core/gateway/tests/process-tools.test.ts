/**
 * 进程与生命周期工具单测：PID 判活、pidfile 读写、服务探测、进程树结束、入口定位。
 *
 * 全部走真实文件与真实子进程（不 mock process.kill / taskkill），
 * 保证与 Windows 语义一致。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  cliEntry,
  foreignServiceOnPort,
  killTree,
  pidAlive,
  probe,
  readPid,
  scopeOf,
  type Scope,
} from "../dist/app/lifecycle/process.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-process-"));
process.env["MODELMUX_HOME"] = HOME;

function makeChannel(cid: string): Channel {
  const config: ChannelConfig = { cid, display: `Synth ${cid}`, version: "0.0.0", defaultAddr: "127.0.0.1:1", uiPort: 2 };
  return {
    config,
    cred: { NotLoggedInError: class extends Error {}, load: () => { throw new Error("no"); }, save: async () => {} },
  } as unknown as Channel;
}

/** 临时 scope：pidfile 落在临时目录里。 */
const scope: Scope = {
  name: "test",
  pidPath: () => join(HOME, "test.pid"),
  workerPidPath: () => join(HOME, "test.worker.pid"),
  logPath: () => join(HOME, "test.log"),
  prefsPath: () => join(HOME, "test.prefs.json"),
};

describe("pidAlive / readPid", () => {
  it("自身进程判活为 true；不存在的 PID 为 false；非正数为 false", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(9_999_999), false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-5), false);
  });

  it("readPid：缺失文件 0；合法数字正常读；非数字 0", () => {
    assert.equal(readPid(scope), 0);
    writeFileSync(scope.pidPath(), "12345\n", "utf8");
    assert.equal(readPid(scope), 12345);
    writeFileSync(scope.pidPath(), "not-a-pid", "utf8");
    assert.equal(readPid(scope), 0);
  });
});

describe("scopeOf", () => {
  it("多渠道注册时取仓库级（modelmux）；单渠道时取渠道名", () => {
    assert.equal(scopeOf().name, "modelmux", "无渠道注册 → 仓库级");
    setChannel(makeChannel("procchan"));
    assert.equal(scopeOf("procchan").name, "procchan");
    assert.equal(scopeOf().name, "procchan", "恰好一个渠道 → 渠道级");
    setChannel(makeChannel("procchan2"));
    assert.equal(scopeOf().name, "modelmux", "两个渠道 → 回到仓库级");
    clearChannels();
  });
});

describe("probe / foreignServiceOnPort", () => {
  let server: Server;
  let port = 0;
  let payload: unknown = { ok: false };

  before(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("本服务身份（modelmux）→ probe 命中、foreign 为空", async () => {
    payload = { ok: true, service: "modelmux" };
    const hit = await probe(`127.0.0.1:${port}`);
    assert.ok(hit && hit["service"] === "modelmux");
    assert.equal(await foreignServiceOnPort(`127.0.0.1:${port}`), "");
  });

  it("他人服务身份 → probe 为 null、foreign 报服务名；缺失 service 按他人处理", async () => {
    payload = { ok: true, service: "someone-else" };
    assert.equal(await probe(`127.0.0.1:${port}`), null);
    assert.equal(await foreignServiceOnPort(`127.0.0.1:${port}`), "someone-else");
    payload = { ok: true };
    assert.equal(await probe(`127.0.0.1:${port}`), null, "历史实现缺 service 字段不能当自己人");
    assert.equal(await foreignServiceOnPort(`127.0.0.1:${port}`), "未知服务");
  });

  it("ok:false 与 404 都不算任何服务", async () => {
    payload = { ok: false };
    assert.equal(await probe(`127.0.0.1:${port}`), null);
    assert.equal(await foreignServiceOnPort(`127.0.0.1:${port}`), "");
  });

  it("连接拒绝 → probe null / foreign 空串（不抛异常）", async () => {
    assert.equal(await probe("127.0.0.1:1"), null);
    assert.equal(await foreignServiceOnPort("127.0.0.1:1"), "");
  });
});

describe("killTree", () => {
  it("结束真实子进程并等到它死透", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    // 轮询等启动：固定 sleep 在冷启动 / 高负载机器上会假失败
    for (let i = 0; i < 50 && !pidAlive(child.pid!); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pidAlive(child.pid!), true, "子进程应已启动");
    const dead = await killTree(child.pid!);
    assert.equal(dead, true);
    assert.equal(pidAlive(child.pid!), false, "返回 true 时进程必须已死");
  });

  it("对不存在的 PID 返回 true（含本来就不存在）", async () => {
    assert.equal(await killTree(9_999_999), true);
  });
});

describe("cliEntry", () => {
  it("回退到共享包的 cli/index.js（bundle 场景无文件入口时的兜底）", () => {
    const entry = cliEntry();
    assert.ok(entry.endsWith(join("cli", "index.js")), `got ${entry}`);
    assert.ok(existsSync(entry), "回退路径必须真实存在");
  });
});

after(async () => {
  rmSync(HOME, { recursive: true, force: true });
});
