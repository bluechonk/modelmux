/**
 * 版本号单一真相：根 `package.json` 的 `version` 是唯一来源。
 *
 * 干什么：`syncVersion()` 把其余落点（gateway 的 `VERSION` 常量、可发布的 cli 清单、
 *         desktop 清单与 lock、根 lock、`docs/PROGRESS.md`）对齐到根版本。
 * 怎么跑：库模块（无 CLI）；命令行入口见 `scripts/sync-version.mjs`，打包侧见 `scripts/pack-desktop.mjs`。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+$/;

function requireSemver(value, where) {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`${where} 的版本号非法（应为 x.y.z）：${JSON.stringify(value)}`);
  }
  return value;
}

/** 读仓库根 `package.json` 的 version（非 x.y.z 直接抛，避免把 undefined 写进落点）。 */
export function readRootVersion(root) {
  return requireSemver(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "根 package.json");
}

/**
 * 确证锚点存在后再替换。
 *
 * 直接 `str.replace` 在格式漂移时会静默 no-op（返回原文），调用方据此判「无改动」——
 * 版本锚点是一处固定文本，匹配不上就说明格式变了，必须报错而不是当成功。
 */
function replaceAnchored(text, re, replacement, where) {
  if (!re.test(text)) throw new Error(`${where}：未匹配到版本锚点（${re}），格式可能已改`);
  return text.replace(re, () => replacement);
}

/**
 * 把落点对齐到 `next`（缺省=根当前版本）。
 *
 * 传入 `next` 时先改根 `package.json`，再逐处派生 —— 这样「改一个地方」就是改根版本。
 * JSON 落点走 parse→改字段→stringify：npm 与手写清单都是 2 空格缩进、可无损往返（实测），
 * 按字段改比按文本替换稳，不会被某个依赖恰好同版本号误伤。
 * `only` 限定只处理部分落点（打包脚本只同步 desktop 自己的两处）。
 * 返回本次真正改动的文件（仓库根相对路径），未变动的文件不写盘、不进 diff。
 */
export function syncVersion(root, next, { only } = {}) {
  const changed = [];
  const wanted = (rel) => only === undefined || only.includes(rel);
  const edit = (rel, make, { optional = false } = {}) => {
    if (!wanted(rel)) return;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      if (optional) return;
      throw new Error(`缺少版本落点文件：${rel}`);
    }
    const before = readFileSync(abs, "utf8");
    const after = make(before);
    if (after === before) return;
    writeFileSync(abs, after);
    changed.push(rel);
  };
  const editJson = (rel, mutate, opts) =>
    edit(rel, (s) => `${JSON.stringify(mutate(JSON.parse(s)), null, 2)}\n`, opts);

  const to = next === undefined ? readRootVersion(root) : requireSemver(next, "命令行参数");

  editJson("package.json", (j) => ({ ...j, version: to }));
  edit("packages/core/gateway/src/version.ts", (s) =>
    replaceAnchored(s, /export const VERSION = "[^"]*";/, `export const VERSION = "${to}";`, "version.ts"),
  );
  // cli 是唯一**可发布**的包（有 bin / files / prepack），npm 要求清单带 version，故保留并派生；
  // 其余 workspace 包（ui / gateway / 各渠道）都是 private，一律不带 version。
  editJson("packages/cli/package.json", (j) => ({ ...j, version: to }));
  editJson("desktop/package.json", (j) => ({ ...j, version: to }));
  editJson(
    "desktop/package-lock.json",
    (j) => ({ ...j, version: to, packages: { ...j.packages, "": { ...j.packages[""], version: to } } }),
    { optional: true },
  );
  editJson("package-lock.json", (j) => {
    const packages = { ...j.packages, "": { ...j.packages[""], version: to } };
    // 可发布的 cli 在 lock 里也带 version，须与清单同步，否则 npm ci 报 lock 与 manifest 不一致
    if (packages["packages/cli"]) packages["packages/cli"] = { ...packages["packages/cli"], version: to };
    return { ...j, version: to, packages };
  });
  edit("docs/PROGRESS.md", (s) =>
    replaceAnchored(s, /\| 当前版本 \| v[^\s|]+ \|/, `| 当前版本 | v${to} |`, "PROGRESS.md"),
  );

  return changed;
}
