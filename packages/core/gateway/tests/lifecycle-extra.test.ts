/**
 * 生命周期补充：陈旧构建的目录扫描分支、进程工具回落、`mx web` 单端口地址。
 *
 * 全程在 mkdtemp 的临时根下造目录；`web` / `start` 用假健康服务让守护逻辑走
 * 「已在运行」的幂等分支，不 spawn 真实网关。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { main } from "../dist/app/cli/index.js";
import { detectStaleBuild, findWorkspaceRoot, staleBuildHint } from "../dist/app/lifecycle/stale-build.js";
import { cliEntry, killTree, pidAlive } from "../dist/app/lifecycle/process.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const HOME = mkdtempSync(join(tmpdir(), "mx-lifecycle-home-"));
process.env["MODELMUX_HOME"] = HOME;
const WS = mkdtempSync(join(tmpdir(), "mx-lifecycle-ws-"));

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

/** 造一个「工作区根 + 网关 dist + pid 文件」的迷你布局。 */
function scaffold(name: string, opts: { buildMs: number; pidMs: number; nested?: boolean; channel?: boolean }): {
  root: string;
  pid: string;
} {
  const root = join(WS, name);
  const dist = join(root, "packages", "core", "gateway", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mini", workspaces: ["packages/*"] }), "utf8");
  const built = join(dist, "index.js");
  writeFileSync(built, "// built\n", "utf8");
  utimesSync(built, opts.buildMs / 1000, opts.buildMs / 1000);
  if (opts.nested) {
    mkdirSync(join(dist, "a", "b"), { recursive: true });
    const deep = join(dist, "a", "b", "c.js");
    writeFileSync(deep, "// deep\n", "utf8");
    utimesSync(deep, opts.buildMs / 1000, opts.buildMs / 1000);
  }
  if (opts.channel) {
    const chDist = join(root, "packages", "core", "channels", "foo", "dist");
    mkdirSync(chDist, { recursive: true });
    const chBuilt = join(chDist, "channel.js");
    writeFileSync(chBuilt, "// ch\n", "utf8");
    utimesSync(chBuilt, opts.buildMs / 1000, opts.buildMs / 1000);
  }
  const pid = join(root, "gateway.pid");
  writeFileSync(pid, "12345\n", "utf8");
  utimesSync(pid, opts.pidMs / 1000, opts.pidMs / 1000);
  return { root, pid };
}

after(() => {
  clearChannels();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WS, { recursive: true, force: true });
});

describe("findWorkspaceRoot：node_modules 祖先跳过", () => {
  it("从 node_modules 里的起点向上跳到真正的工作区根", () => {
    const proj = join(WS, "proj");
    mkdirSync(join(proj, "node_modules", "foo", "dist"), { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");
    assert.equal(findWorkspaceRoot(join(proj, "node_modules", "foo", "dist")), proj);
  });
});

describe("detectStaleBuild：扫描范围", () => {
  it("找不到工作区根 → 退化为只管本包 dist（不抛）", () => {
    const start = join(WS, "no-root");
    mkdirSync(start, { recursive: true });
    const pid = join(start, "gateway.pid");
    writeFileSync(pid, "1\n", "utf8");
    // pid 时刻放到很远以后：即使扫到本包 dist 也不该判 stale
    const future = Date.now() + 3_600_000;
    utimesSync(pid, future / 1000, future / 1000);
    const r = detectStaleBuild(pid, start);
    assert.equal(r.stale, false);
  });

  it("扫描覆盖渠道包 dist 与嵌套子目录", () => {
    const { root, pid } = scaffold("channels", {
      buildMs: T0 + 60_000,
      pidMs: T0,
      nested: true,
      channel: true,
    });
    const r = detectStaleBuild(pid, root);
    assert.equal(r.stale, true);
    assert.equal(r.buildMs, T0 + 60_000);
    assert.match(staleBuildHint(r), /restart/);
  });

  it("扫描遇到悬空链接 → 跳过该条目，不抛", () => {
    const { root, pid } = scaffold("dangling", { buildMs: T0 + 60_000, pidMs: T0 });
    const dist = join(root, "packages", "core", "gateway", "dist");
    try {
      symlinkSync(join(dist, "missing.js"), join(dist, "dangling.js"));
    } catch {
      return; // 平台不允许创建符号链接（无权限）时跳过
    }
    const r = detectStaleBuild(pid, root);
    assert.equal(r.stale, true, "其余产物仍比 pid 新");
    assert.equal(r.buildMs, T0 + 60_000);
  });
});

describe("cliEntry：入口异常回落", () => {
  it("入口路径不存在 → 回落到共享包 cli/index.js", () => {
    const saved = process.argv[1];
    process.argv[1] = join(WS, "不存在的入口.js");
    try {
      const entry = cliEntry();
      assert.ok(entry.endsWith(join("cli", "index.js")), entry);
      assert.ok(existsSync(entry), "回落路径必须真实存在");
    } finally {
      process.argv[1] = saved;
    }
  });
});

describe("killTree：杀不掉的进程", () => {
  it("等满 3s 后如实返回 false（PID 4 是受保护进程，taskkill 拒绝访问）", async () => {
    if (!pidAlive(4)) return; // 非 Windows 环境没有该进程，跳过
    const dead = await killTree(4);
    assert.equal(dead, false, "杀不掉就要如实报 false");
  });
});

describe("killTree：POSIX 分支（伪装 platform）", () => {
  /** 临时把 process.platform 伪装成 linux，跑完恢复。 */
  async function withLinuxPlatform(fn: () => Promise<void>): Promise<void> {
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
  }

  it("SIGTERM 能结束子进程", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid!;
    for (let i = 0; i < 50 && !pidAlive(pid); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pidAlive(pid), true, "子进程应已启动");
    await withLinuxPlatform(async () => {
      const dead = await killTree(pid);
      assert.equal(dead, true);
      assert.equal(pidAlive(pid), false, "返回 true 时进程必须已死");
    });
  });

  it("SIGTERM 杀不掉 → 补 SIGKILL 再等，仍失败则如实返回 false", async () => {
    if (!pidAlive(4)) return; // 非 Windows 环境没有该进程，跳过
    await withLinuxPlatform(async () => {
      const dead = await killTree(4);
      assert.equal(dead, false);
    });
  });
});

describe("mx web / start / stop 路由", () => {
  let server: Server;
  let port = 0;

  /** 跑一次 CLI，收 stdout/stderr 与退出码。 */
  async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    console.error = (...args: unknown[]) => void err.push(args.join(" "));
    try {
      const code = await main(argv);
      return { code, out: out.join("\n"), err: err.join("\n") };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  function makeChannel(cid: string): Channel {
    const config: ChannelConfig = {
      cid,
      display: `Synth ${cid}`,
      version: "1.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
    };
    return {
      config,
      cred: {
        NotLoggedInError: class NotLoggedInError extends Error {},
        load: () => {
          throw new Error("no");
        },
      },
    } as unknown as Channel;
  }

  before(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "modelmux" }));
      });
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("web：网关已在跑就只给控制台地址", async () => {
    clearChannels();
    const r = await runMain(["web", "--host", "127.0.0.1", "--port", String(port)]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`[web] http://127.0.0.1:${port}/web/`), r.out);
  });

  it("start：网关已在跑就幂等返回 0", async () => {
    clearChannels();
    const r = await runMain(["start", "--addr", `127.0.0.1:${port}`, "--ui-port", String(port)]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("网关已在运行"), r.out);
  });

  it("stop：默认地址不可达 → 报未在运行", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await runMain(["stop"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("网关未在运行"), r.out);
  });

  it("restart：停掉默认地址的实例后，在指定地址探到已在跑 → 返回 0", async () => {
    clearChannels();
    // 单渠道的 defaultAddr 是不可达端口：stop 走它，不会碰仓库级 4412
    setChannel(makeChannel("alpha"));
    const r = await runMain(["restart", "--addr", `127.0.0.1:${port}`, "--ui-port", String(port)]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("网关已在运行"), r.out);
  });
});
