/**
 * `scripts/version.mjs` 的派生逻辑测试。
 *
 * 为什么单独测：`verify-contract` 只校验**终态一致**，测不出派生过程本身写错 ——
 * 落点写漏、正则漂移后静默 no-op、把同版本号的依赖一起改掉，都只在下次发版才暴露。
 * 用临时目录造最小「仓库根」，断言 syncVersion 的行为与失败路径。
 *
 * 怎么跑：`npm run test:scripts`（仓库根）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { syncVersion } from "../version.mjs";

/** 最小仓库根：每个必填落点各一份，版本统一 1.2.3。 */
const FILES = {
  "package.json": { name: "x", version: "1.2.3" },
  "packages/core/gateway/src/version.ts": 'export const VERSION = "1.2.3";\n',
  "packages/cli/package.json": { name: "x", version: "1.2.3" },
  "desktop/package.json": { name: "d", version: "1.2.3" },
  "desktop/package-lock.json": {
    name: "d",
    version: "1.2.3",
    packages: { "": { name: "d", version: "1.2.3" } },
  },
  "package-lock.json": {
    name: "x",
    version: "1.2.3",
    packages: { "": { version: "1.2.3" }, "packages/cli": { version: "1.2.3" } },
  },
  "docs/PROGRESS.md": "| 当前版本 | v1.2.3 |\n",
};

function seed(root, over = {}) {
  for (const [rel, value] of Object.entries({ ...FILES, ...over })) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const readText = (root, rel) => readFileSync(join(root, rel), "utf8");

const roots = [];
function makeRoot(over) {
  const root = mkdtempSync(join(tmpdir(), "mx-version-test-"));
  roots.push(root);
  seed(root, over);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("syncVersion", () => {
  it("已与根一致时零改动（幂等）", () => {
    const root = makeRoot();
    assert.deepEqual(syncVersion(root), []);
  });

  it("根版本变化时派生到全部落点", () => {
    const root = makeRoot({ "package.json": { name: "x", version: "2.0.0" } });
    assert.deepEqual(syncVersion(root).sort(), [
      "desktop/package-lock.json",
      "desktop/package.json",
      "docs/PROGRESS.md",
      "package-lock.json",
      "packages/cli/package.json",
      "packages/core/gateway/src/version.ts",
    ]);
    assert.match(readText(root, "packages/core/gateway/src/version.ts"), /VERSION = "2\.0\.0"/);
    assert.match(readText(root, "docs/PROGRESS.md"), /\| 当前版本 \| v2\.0\.0 \|/);
    assert.equal(readJson(root, "package-lock.json").version, "2.0.0");
    assert.equal(readJson(root, "package-lock.json").packages["packages/cli"].version, "2.0.0");
    assert.equal(readJson(root, "desktop/package-lock.json").packages[""].version, "2.0.0");
  });

  it("传入新版本时先改根再派生", () => {
    const root = makeRoot();
    syncVersion(root, "3.0.0");
    assert.equal(readJson(root, "package.json").version, "3.0.0");
    assert.match(readText(root, "packages/core/gateway/src/version.ts"), /3\.0\.0/);
  });

  it("缺必填落点文件时抛错（不静默成功）", () => {
    const root = makeRoot();
    rmSync(join(root, "docs/PROGRESS.md"));
    assert.throws(() => syncVersion(root), /缺少版本落点文件/);
  });

  it("版本锚点格式漂移时抛错", () => {
    const root = makeRoot({ "packages/core/gateway/src/version.ts": "export const VERSION =1;\n" });
    assert.throws(() => syncVersion(root), /未匹配到版本锚点/);
  });

  it("根版本非法时抛错", () => {
    const root = makeRoot({ "package.json": { name: "x", version: "nope" } });
    assert.throws(() => syncVersion(root), /版本号非法/);
  });

  it("desktop 锁缺失时跳过（可选落点）", () => {
    const root = makeRoot();
    rmSync(join(root, "desktop/package-lock.json"));
    assert.doesNotThrow(() => syncVersion(root));
  });

  it("only 限定只处理指定落点（打包侧用法）", () => {
    const root = makeRoot({ "package.json": { name: "x", version: "4.0.0" } });
    assert.deepEqual(
      syncVersion(root, undefined, { only: ["desktop/package.json", "desktop/package-lock.json"] }).sort(),
      ["desktop/package-lock.json", "desktop/package.json"],
    );
    assert.equal(readJson(root, "package.json").version, "4.0.0");
    assert.match(readText(root, "packages/core/gateway/src/version.ts"), /1\.2\.3/);
  });

  it("派生不误伤与仓库版本同号的依赖", () => {
    const root = makeRoot({
      "package.json": { name: "x", version: "2.0.0" },
      "package-lock.json": {
        name: "x",
        version: "1.2.3",
        packages: {
          "": { version: "1.2.3" },
          "packages/cli": { version: "1.2.3" },
          "node_modules/leftpad": { version: "1.2.3" },
        },
      },
    });
    syncVersion(root);
    const lock = readJson(root, "package-lock.json");
    assert.equal(lock.packages["node_modules/leftpad"].version, "1.2.3", "依赖版本不得被改");
    assert.equal(lock.packages[""].version, "2.0.0");
    assert.equal(lock.packages["packages/cli"].version, "2.0.0");
  });
});
