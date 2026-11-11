/**
 * 控制台 UI 根的**候选探测**路径：不设 MODELMUX_WEB_UI_ROOT，
 * 由 resolveWebUiRoot 按候选顺序找到已构建的 dist/ui。
 *
 * 与 console-extra / console-ui-missing 分文件跑（模块级常量在 import 时解析，
 * 环境变量必须在 import 前定好；node --test 每文件一进程）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ControlBridge } from "../dist/http/console/console.js";

delete process.env["MODELMUX_WEB_UI_ROOT"];
const HOME = mkdtempSync(join(tmpdir(), "modelmux-console-uibase-"));
process.env["MODELMUX_HOME"] = HOME;

const { start, emptySnapshot } = await import("../dist/http/console/console.js");

const bridge: ControlBridge = { provider: () => emptySnapshot() };
let server: Awaited<ReturnType<typeof start>>;

before(async () => {
  server = await start(0, bridge, "127.0.0.1");
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
});

describe("UI 根候选探测", () => {
  it("无环境变量覆盖时，从 dist/ui 解析到已构建的 index.html", async () => {
    const res = await fetch(server.url);
    assert.equal(res.status, 200, "应命中 dist/ui/index.html");
    const body = await res.text();
    assert.ok(body.includes("<"), "返回的是 HTML 而不是 404 文案");
  });

  it("资产从 dist/ui/assets 提供", async () => {
    const res = await fetch(`${server.url}assets/`);
    // 目录不是文件 → 404，但至少证明解析到了真实 UI 根（不是「UI 未构建」文案）
    if (res.status === 404) {
      assert.doesNotMatch(await res.text(), /UI 未构建/);
    } else {
      assert.ok(res.status === 200 || res.status === 403);
    }
  });
});
