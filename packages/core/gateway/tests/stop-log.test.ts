/**
 * `stop` 的终止记录：成功停掉守护进程后，往生命周期时间线追加一行
 * `{"event":"stop","pid":…}` —— 时间线平时只有 start/ready，
 * 不补这行就没有“下线”痕迹（手动停与崩溃分不出来）。
 *
 * 落点是**分层日志**的生命周期文件 `<root>/logs/system/<日期>/lifecycle.log`
 * （`appendSystem("stop", { pid })`，契约见 docs/LOGGING.md §4；
 * start / ready 写同一份文件）。完全离线：只起一个本地 dummy 进程当“网关”。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { stop } from "../dist/app/lifecycle/daemon.js";
import { localDate } from "../dist/runtime/log-store.js";

/** 生命周期时间线的落点：`<root>/logs/system/<本地日期>/lifecycle.log`。 */
function lifecyclePath(root: string): string {
  return join(root, "logs", "system", localDate(), "lifecycle.log");
}

describe("stop：终止记录写入日志", () => {
  let root = "";
  let savedRoot: string | undefined;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "modelmux-stoplog-"));
    savedRoot = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
  });
  after(() => {
    if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = savedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("成功停止后日志追加 stop 行（原有内容保留），PID 文件清除", async () => {
    // 一个活着的本地进程冒充网关守护进程
    const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const pidPath = join(root, "gateway.pid");
      const logPath = lifecyclePath(root);
      writeFileSync(pidPath, String(dummy.pid), "utf8");
      mkdirSync(dirname(logPath), { recursive: true });
      const ready = `{"ts":"2026-01-01T00:00:00.000Z","event":"ready","addr":"http://127.0.0.1:8787","pid":1}`;
      writeFileSync(logPath, `${ready}\n`, "utf8");

      const code = await stop({ quiet: true, addr: "127.0.0.1:1" });
      assert.equal(code, 0, "stop 应成功");
      assert.ok(!existsSync(pidPath), "PID 文件应被清除");
      const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
      assert.equal(lines[0], ready, "原有日志必须保留");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { event?: string; pid?: number };
      assert.equal(last.event, "stop", "末行应是终止记录");
      assert.equal(last.pid, dummy.pid, "终止记录要带被停的 PID");
    } finally {
      dummy.kill("SIGKILL"); // 兜底：killTree 失败时也别留孤儿进程
    }
  });

  it("进程已死（PID 失效）也如实补记录，不误报失败", async () => {
    const pidPath = join(root, "gateway.pid");
    const logPath = lifecyclePath(root);
    // 起一个立刻退出的进程，拿到一个已死亡的 pid 写进 PID 文件
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const gonePid = gone.pid ?? 0;
    await new Promise((r) => gone.once("exit", r));
    writeFileSync(pidPath, String(gonePid), "utf8");
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "", "utf8");

    const code = await stop({ quiet: true, addr: "127.0.0.1:1" });
    assert.equal(code, 0, "已死的实例按已停止处理");
    const last = readFileSync(logPath, "utf8").trim();
    assert.ok(last.includes(`"event":"stop"`), `日志应有终止记录：${last}`);
  });
});
