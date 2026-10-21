/**
 * 陈旧构建检测：「跑着的网关是不是旧代码」（见 docs/CONTRACT-TS.md §8）。
 *
 * 全程在 mkdtemp 的临时根下造目录，绝不触碰真实仓库与真实数据。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 旧行为：实现位于共享层根（`src/stale-build.ts` → `dist/stale-build.js`）。
// 新行为：共享层按职责分了五层目录，陈旧构建检测属「进程生命周期」层 ——
//   `src/app/lifecycle/stale-build.ts` → `dist/app/lifecycle/stale-build.js`
//   （见提交 662f0ae「共享层 src 按职责划分为五层目录」的改名记录）
const { findWorkspaceRoot, detectStaleBuild, staleBuildHint } = await import(
  "../dist/app/lifecycle/stale-build.js"
);

const ROOT = mkdtempSync(join(tmpdir(), "stale-build-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** 造一个「工作区根 + 一个包的 dist + pid 文件」的迷你布局。 */
function scaffold(name: string, buildMs: number, pidMs: number): { root: string; pid: string } {
  const root = join(ROOT, name);
  // 旧行为：dist 放在 `packages/gw/dist` —— 那是「顶层 groups 遍历一层」的老布局。
  // 新行为：实现只扫**显式列出的**包目录（`packages/cli` / `packages/ui` /
  //   `packages/core/gateway`）+ `packages/core/channels/*` 下的渠道包
  //   （见 src/app/lifecycle/stale-build.ts:98-108，提交 ff3f46b 把共享层下沉到 packages/core 时改的）。
  //   布局不对 → 扫不到任何 .js → buildMs 为 null → 一律判「不 stale」，测的就不是陈旧检测了。
  const dist = join(root, "packages", "core", "gateway", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "mini", workspaces: ["packages/*"] }),
    "utf8",
  );
  const built = join(dist, "index.js");
  writeFileSync(built, "// built\n", "utf8");
  utimesSync(built, buildMs / 1000, buildMs / 1000);

  const pid = join(root, "gateway.pid");
  writeFileSync(pid, "12345\n", "utf8");
  utimesSync(pid, pidMs / 1000, pidMs / 1000);
  return { root, pid };
}

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

describe("陈旧构建检测", () => {
  it("构建产物比进程新 → stale（正是事故场景：改完 build 没 restart）", () => {
    const { root, pid } = scaffold("stale", T0 + 60_000, T0);
    const r = detectStaleBuild(pid, root);
    assert.equal(r.stale, true, "构建晚于启动即应判为旧代码");
    assert.equal(r.buildMs, T0 + 60_000);
    assert.equal(r.pidMs, T0);
    assert.match(staleBuildHint(r), /restart/, "提示里要给出做法");
  });

  it("进程比构建新（正常重启过）→ 不 stale", () => {
    const { root, pid } = scaffold("fresh", T0, T0 + 60_000);
    assert.equal(detectStaleBuild(pid, root).stale, false);
  });

  it("同一秒内完成 build 与 start → 不报（留 1s 容差，避免抖动误报）", () => {
    const { root, pid } = scaffold("same-second", T0 + 500, T0);
    assert.equal(detectStaleBuild(pid, root).stale, false);
  });

  it("没有 pid 文件（没有守护进程在跑）→ 不 stale，也不抛", () => {
    const { root } = scaffold("no-pid", T0 + 60_000, T0);
    const r = detectStaleBuild(join(root, "不存在.pid"), root);
    assert.equal(r.stale, false);
    assert.equal(r.buildMs, null);
  });

  it("工作区根判据只认 workspaces 字段（不再要求 `-bridge` 条目）", () => {
    // 本仓库布局早已是 packages/* + channels/*；旧判据在此**永远失败**
    // （实测 `paths <cid>` 一直报「未找到工作区根」）。
    const { root } = scaffold("ws-root", T0, T0);
    assert.equal(findWorkspaceRoot(join(root, "packages", "core", "gateway", "dist")), root);

    // 没有 workspaces 的 package.json 不算根
    const notRoot = join(ROOT, "not-a-root");
    mkdirSync(notRoot, { recursive: true });
    writeFileSync(join(notRoot, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    assert.equal(findWorkspaceRoot(notRoot), null);
  });
});
