/**
 * 落点巡检：`paths` 的只读统计（文件字节/权限、workspaces 展开、未构建渠道包提醒）。
 *
 * 直接调导出的 inspect / expandWorkspaces / renderReport / runPaths，全程只读。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { expandWorkspaces, inspect, renderReport, runPaths } from "../dist/app/cli/report.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { channelDirFor } from "../dist/runtime/paths.js";

const ROOT = mkdtempSync(join(tmpdir(), "mx-report-"));
process.env["MODELMUX_HOME"] = ROOT;

function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "1.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
  };
  return { config } as unknown as Channel;
}

after(() => {
  clearChannels();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("inspect：文件存在时给出字节与权限位", () => {
  it("存在的文件带 bytes/mode，不存在的文件只有名字", () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const config = makeChannel("alpha").config;
    const dir = channelDirFor(config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), '{"accessToken":"tok"}', "utf8");
    mkdirSync(join(dir, "cache"), { recursive: true });

    const report = inspect(config);
    const cred = report.files.find((f) => f.name === "credentials.json");
    assert.ok(cred, "要有 credentials 条目");
    assert.equal(cred.exists, true);
    assert.ok((cred.bytes ?? 0) > 0, "存在就要给字节数");
    assert.match(cred.mode ?? "", /^\d+$/, "权限位是八进制字符串");

    const missing = report.files.find((f) => f.name === "upstream.json");
    assert.ok(missing);
    assert.equal(missing.exists, false);
    assert.equal(missing.bytes, undefined, "不存在不给字节数");

    const cache = report.subdirs.find((s) => s.name === "cache");
    assert.ok(cache);
    assert.equal(cache.exists, true);

    const text = renderReport(report);
    assert.ok(text.includes("alpha"), text);
    assert.ok(text.includes("credentials.json"), text);
  });
});

describe("expandWorkspaces", () => {
  it("没有 package.json / JSON 损坏 → 空表", () => {
    const empty = join(ROOT, "no-pkg");
    mkdirSync(empty, { recursive: true });
    assert.deepEqual(expandWorkspaces(empty, empty), []);

    const broken = join(ROOT, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{ not json", "utf8");
    assert.deepEqual(expandWorkspaces(broken, broken), []);
  });

  it("字面目录与对象形态的 workspaces 都展开", () => {
    const root = join(ROOT, "ws-literal");
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    mkdirSync(join(root, "packages", "b"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/a", "packages/b"] }), "utf8");
    writeFileSync(join(root, "packages", "a", "package.json"), "{}", "utf8");
    writeFileSync(join(root, "packages", "b", "package.json"), "{}", "utf8");
    const out = expandWorkspaces(root, root);
    assert.equal(out.length, 2);
    assert.ok(out.every((dir) => existsSync(join(dir, "package.json"))));

    const objRoot = join(ROOT, "ws-object");
    mkdirSync(join(objRoot, "packages", "c"), { recursive: true });
    writeFileSync(
      join(objRoot, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/c"] } }),
      "utf8",
    );
    writeFileSync(join(objRoot, "packages", "c", "package.json"), "{}", "utf8");
    assert.equal(expandWorkspaces(objRoot, objRoot).length, 1);
  });

  it("通配展开：跳过不存在的基础目录与没有 package.json 的子目录", () => {
    const root = join(ROOT, "ws-wild");
    mkdirSync(join(root, "packages", "ok"), { recursive: true });
    mkdirSync(join(root, "packages", "skip"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "vendor/*"] }), "utf8");
    writeFileSync(join(root, "packages", "ok", "package.json"), "{}", "utf8");
    const out = expandWorkspaces(root, root);
    assert.equal(out.length, 1, "只收有 package.json 的子目录");
    assert.ok(out[0]!.endsWith("ok"));
  });
});

describe("runPaths --all", () => {
  it("找不到工作区根 → 报错并返回 2", async () => {
    const empty = join(ROOT, "no-root");
    mkdirSync(empty, { recursive: true });
    const code = await runPaths({ all: true, workspace: empty });
    assert.equal(code, 2);
  });

  it("渠道包没构建出来 → 跳过并提醒", async () => {
    const root = join(ROOT, "ws-bad");
    mkdirSync(join(root, "packages", "bad", "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");
    writeFileSync(join(root, "packages", "bad", "package.json"), "{}", "utf8");
    // 入口存在但一 import 就抛：loadConfig 要回落到 src/channel.ts（也不存在）
    writeFileSync(join(root, "packages", "bad", "dist", "channel.js"), "throw new Error('boom');", "utf8");

    const err: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => void err.push(args.join(" "));
    let code: number;
    try {
      code = await runPaths({ all: true, workspace: root });
    } finally {
      console.error = origErr;
    }
    assert.equal(code!, 0);
    assert.ok(err.join("\n").includes("[warn] 跳过未构建的渠道包"), err.join("\n"));
  });
});
