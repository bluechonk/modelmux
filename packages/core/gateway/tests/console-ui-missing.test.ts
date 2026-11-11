/**
 * 控制台 UI 缺失分支：MODELMUX_WEB_UI_ROOT 指向空目录时，首页回 404 + 可诊断文案。
 *
 * WEB_UI_ROOT 在模块加载时解析，故本文件单独成进程（node --test 每文件一进程），
 * 先把环境变量指到空目录再动态 import。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ControlBridge } from "../dist/http/console/console.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-console-missing-"));
const EMPTY_UI_ROOT = mkdtempSync(join(tmpdir(), "modelmux-console-missing-ui-"));
process.env["MODELMUX_HOME"] = HOME;
process.env["MODELMUX_WEB_UI_ROOT"] = EMPTY_UI_ROOT;

const { start, emptySnapshot } = await import("../dist/http/console/console.js");

const bridge: ControlBridge = { provider: () => emptySnapshot() };
let server: Awaited<ReturnType<typeof start>>;

before(async () => {
  server = await start(0, bridge, "127.0.0.1");
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(EMPTY_UI_ROOT, { recursive: true, force: true });
});

describe("UI 未构建", () => {
  it("GET / → 404 + 带查找路径的提示", async () => {
    const res = await fetch(server.url);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /UI 未构建/);
    assert.ok(body.includes(EMPTY_UI_ROOT), "提示里要带查找路径，便于排查");
  });

  it("SPA 回退路径同样 404（不再回 index.html）", async () => {
    const res = await fetch(`${server.url}accounts`);
    assert.equal(res.status, 404);
  });
});
