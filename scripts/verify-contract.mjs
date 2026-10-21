#!/usr/bin/env node
/**
 * 工程契约校验（条文见 docs/CONTRACT-TS.md §1/§2/§4）。
 *
 * 把「渠道包形态、依赖白名单、池模型恒定」这类**机器可查**的契约从文档搬进会失败的
 * 测试 —— 文档只保留编译器与本校验器都管不到的语义约定。
 *
 * 用法：node scripts/verify-contract.mjs（由 npm test 自动执行）
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // scripts/
const repo = dirname(root);
const read = (p) => readFileSync(join(repo, p), "utf8");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** 渠道包 src/ 的 7 文件契约（CONTRACT-TS §1）。 */
const REQUIRED_SRC = ["billing.ts", "catalog.ts", "channel.ts", "cli.ts", "cred.ts", "index.ts", "upstream.ts"];
const DEP_ALLOW = ["@modelmux/gateway"];
/** 渠道包命名：`@modelmux/<cid>`（目录名与 cid 一致，见 CONTRACT-TS §1）。 */
const CHANNEL_PKG_RE = /^@modelmux\/[a-z0-9-]+$/;
const DEV_ALLOW = ["typescript", "@types/node"];

const channelsDir = join(repo, "packages", "core", "channels");
const channelDirs = readdirSync(channelsDir).filter((n) => existsSync(join(channelsDir, n, "package.json")));

let registeredImports = 0;

for (const cid of channelDirs) {
  const where = `packages/core/channels/${cid}`;

  // src/ 恰 7 文件：多出来的都是共享层旧副本残留
  const srcDir = join(channelsDir, cid, "src");
  check(existsSync(srcDir), `${where}: 缺 src/`);
  const srcFiles = existsSync(srcDir)
    ? readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort()
    : [];
  const extra = srcFiles.filter((f) => !REQUIRED_SRC.includes(f));
  const missing = REQUIRED_SRC.filter((f) => !srcFiles.includes(f));
  check(extra.length === 0, `${where}: src/ 出现契约外文件 ${extra.join(", ")}（只允许 7 文件，见 CONTRACT-TS §1）`);
  check(missing.length === 0, `${where}: src/ 缺少 ${missing.join(", ")}`);

  // 依赖白名单（CONTRACT-TS §2）：渠道只许依赖共享包
  const pkg = JSON.parse(read(`${where}/package.json`));
  const deps = Object.keys(pkg.dependencies ?? {});
  check(
    deps.every((d) => DEP_ALLOW.includes(d)),
    `${where}: dependencies 含非白名单包 ${deps.filter((d) => !DEP_ALLOW.includes(d)).join(", ")}（只允许 ${DEP_ALLOW.join("/")}）`,
  );
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  check(
    devDeps.every((d) => DEV_ALLOW.includes(d)),
    `${where}: devDependencies 含非白名单包 ${devDeps.filter((d) => !DEV_ALLOW.includes(d)).join(", ")}`,
  );

  // 渠道 bin 恰为 `<cid>`（单渠道调试入口；双名 modelmux/mx 属仓库级 packages/cli）
  const bin = pkg.bin ?? {};
  check(
    Object.keys(bin).length === 1 && bin[cid] === "./dist/cli.js",
    `${where}: bin 必须恰为 { "${cid}": "./dist/cli.js" }，当前 ${JSON.stringify(bin)}`,
  );

  // cid 与目录名一致（防两套名字漂移）
  const channelSrc = read(`${where}/src/channel.ts`);
  const cidDecl = channelSrc.match(/cid:\s*"([a-z0-9-]+)"/);
  check(cidDecl !== null, `${where}: src/channel.ts 未声明 cid`);
  check(cidDecl?.[1] === cid, `${where}: 目录名与 cid "${cidDecl?.[1]}" 不一致`);
}

// 仓库级入口：bin 双名 + 注册清单与渠道目录一致
const cliPkg = JSON.parse(read("packages/cli/package.json"));
// ⚠ bin 路径**不带** `./` 前缀 —— 这是 npm 11 的发布归一化规则，不是笔误：
// npm 的 `secureAndUnixifyPath`（@npmcli/package-json/lib/normalize.js）会把
// `path.join('.', '/dist/cli.bundle.js')` 归一成 `./dist/...`，而它**以 './' 开头就判为
// 无效并整条删除** —— 结果是发布出去的包没有 `mx` / `modelmux` 命令，且 npm 只打一句
// 含糊的 "was invalid and removed"。实测：带 "./" → bin 被删；不带 → 保留。
check(
  cliPkg.bin?.["modelmux"] === "dist/cli.bundle.js" && cliPkg.bin?.["mx"] === "dist/cli.bundle.js",
  "packages/cli: bin 必须同时提供 modelmux 与 mx，且都指向 dist/cli.bundle.js（不带 ./ 前缀）",
);
const cliDeps = Object.keys(cliPkg.dependencies ?? {});
check(
  cliDeps.every((d) => DEP_ALLOW.includes(d) || CHANNEL_PKG_RE.test(d)),
  `packages/cli: dependencies 含意外包 ${cliDeps.filter((d) => !DEP_ALLOW.includes(d) && !CHANNEL_PKG_RE.test(d)).join(", ")}`,
);
// 随包快照必须进发布包：bundle 步骤把各渠道的 models.json 复制到 dist/models/<cid>.json，
// 渠道侧靠它兜底（见 docs/CONTRACT-TS.md §8.4）—— files 漏了它，npm 包里的快照就白复制了。
check(
  (cliPkg.files ?? []).includes("dist/models"),
  "packages/cli: files 必须包含 dist/models（bundle 复制的随包快照，否则发布包里兜底失效）",
);
check(
  (cliPkg.files ?? []).includes("dist/cli.bundle.js"),
  "packages/cli: files 必须包含 dist/cli.bundle.js（bin 指向它）",
);
const registered = [...read("packages/cli/src/channels.ts").matchAll(/import\s+"(@modelmux\/[a-z0-9-]+)"/g)].map((m) => m[1]);
registeredImports = registered.length;
for (const cid of channelDirs) {
  check(registered.includes(`@modelmux/${cid}`), `packages/core/channels/${cid}: 未在 packages/cli/src/channels.ts 注册`);
}
check(
  registered.length === channelDirs.length,
  `注册清单（${registered.length}）与渠道目录数（${channelDirs.length}）不一致`,
);

// 工程引用对齐（`AGENTS.md` 的「命令与构建」：根 tsconfig 是 solution 文件，references 列出全部包）。
// 每个条目恰含一个 path —— 空条目与「单条目多 path」都是脚本化增删渠道留下的畸形残留：
// TS 自己的解析器会保留重复键（编译照过），走标准 JSON.parse 的工具却只认最后一个。
const referencesBlock = (text) => {
  const at = text.indexOf('"references"');
  if (at === -1) return "";
  let depth = 0;
  let start = 0;
  for (let i = text.indexOf("[", at); i < text.length; i++) {
    if (text[i] === "[") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return text.slice(start);
};

const tsconfigs = [
  "tsconfig.json",
  ...channelDirs.map((cid) => `packages/core/channels/${cid}/tsconfig.json`),
  "packages/cli/tsconfig.json",
  "packages/core/gateway/tsconfig.json",
];
for (const where of tsconfigs) {
  const block = referencesBlock(read(where));
  const braces = (block.match(/\{/g) ?? []).length;
  const wellFormed = (block.match(/\{\s*"path"\s*:\s*"[^"]+"\s*\}/g) ?? []).length;
  check(braces === wellFormed, `${where}: references 含 ${braces - wellFormed} 个畸形条目（空条目或单条目多 path）`);
}

const solutionPaths = [...referencesBlock(read("tsconfig.json")).matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
const packagePaths = [...channelDirs.map((cid) => `packages/core/channels/${cid}`), "packages/cli", "packages/core/gateway"];
const missingRefs = packagePaths.filter((p) => !solutionPaths.includes(p));
const strayRefs = solutionPaths.filter((p) => !packagePaths.includes(p));
check(
  missingRefs.length === 0 && strayRefs.length === 0,
  `tsconfig.json: references 与仓库包不一致（缺 ${missingRefs.join(", ") || "无"}；多 ${strayRefs.join(", ") || "无"}）`,
);

// 「不进 tsc emit 图」的包（显式白名单 + 理由，避免后人困惑）。
//
// 为什么需要白名单：`tsconfig.json` 的 solution 是 **emit 图**（谁产 JS 谁在里面）。
// `packages/ui` 是 Vite SPA —— 产物由 `vite build` 出，`tsc` 对它只做类型检查
// （`noEmit`），把它塞进 solution 只会逼出假的声明产物。
// ⚠ 但**类型检查不能因此缺席**：`npm test` 的链里有 `npm run typecheck`（全工作区），
// 且下面会检查每个包都有 typecheck 脚本 —— 类型缺口仍然会被 CI 拦住。
const NO_EMIT_PACKAGES = ["packages/ui"]; // Vite 产 JS，tsc 只查类型

// 展开根 workspaces 的每个包（工作区清单是唯一的「有哪些包」事实源）。
function expandWorkspaces() {
  const rootPkg = JSON.parse(read("package.json"));
  const out = new Set();
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const base = join(repo, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) {
        if (existsSync(join(base, name, "package.json"))) out.add(`${pattern.slice(0, -2)}/${name}`);
      }
    } else if (existsSync(join(repo, pattern, "package.json"))) {
      out.add(pattern);
    }
  }
  return [...out];
}

const allPackages = expandWorkspaces();
const pkgVersions = new Map();
for (const pkgPath of allPackages) {
  const pkg = JSON.parse(read(`${pkgPath}/package.json`));
  pkgVersions.set(pkgPath, pkg.version);
  // 每个包都必须有 typecheck 脚本：`npm run typecheck`（不带 --if-present）会因此硬失败。
  // 新增包时漏写 → `npm test` 直接红，不会重演「UI 类型错误长期无人拦截」。
  check(
    typeof pkg.scripts?.typecheck === "string",
    `${pkgPath}: package.json 缺 typecheck 脚本（npm test 的 typecheck 链要求每个工作区都能自查类型）`,
  );

  // **可发布包**（没有 private 标记）的 bin 路径一律不得带 './' 前缀 ——
  // npm 发布归一化（@npmcli/package-json 的 secureAndUnixifyPath）会把 './x.js'
  // 判为无效并**整条删除**，结果：装完没有命令，npm 只打一句含糊的
  // "was invalid and removed"。渠道包都是 private、不发布，保留 './dist/cli.js'
  // 形态（由上面的渠道 bin 断言钉住），故这条只管可发布包。
  if (pkg.private === true) continue;
  for (const [binName, binPath] of Object.entries(pkg.bin ?? {})) {
    check(
      typeof binPath === "string" && !binPath.startsWith("./"),
      `${pkgPath}: 可发布包的 bin["${binName}"] 不能以 './' 开头（npm 发布时会把该条目整条删除）`,
    );
  }
}

// 版本号：**全仓一个版本线**（自用工具，走 0.1.x，不搞对外的版本语义）。
// 同一事实只记一遍 —— package.json 的 version 是唯一真相，渠道的 ChannelConfig.version
// 必须与它一致（那处版本会显示在 `mx --version <cid>` 与 `mx path` 的输出里）。
// 靠人同步 22 处版本号必然漂移（此前 catpaw / workbuddyai 就漂到了 0.4.0），故机器守。
const versionSet = new Set(pkgVersions.values());
check(
  versionSet.size === 1,
  `工作区包版本不一致（应全仓同一版本线）：${[...pkgVersions]
    .map(([p, v]) => `${p}=${v}`)
    .join(", ")}`,
);
for (const cid of channelDirs) {
  const declared = read(`packages/core/channels/${cid}/src/channel.ts`).match(/version:\s*"([^"]+)"/)?.[1];
  const pkgVersion = pkgVersions.get(`packages/core/channels/${cid}`);
  check(
    declared === pkgVersion,
    `packages/core/channels/${cid}: channel.ts 声明的 version（${declared}）与 package.json（${pkgVersion}）不一致`,
  );
}
for (const pkgPath of NO_EMIT_PACKAGES) {
  check(
    allPackages.includes(pkgPath),
    `NO_EMIT_PACKAGES 里的 ${pkgPath} 不是实际工作区包（白名单与 workspaces 不一致）`,
  );
  check(
    !solutionPaths.includes(pkgPath),
    `${pkgPath}: 已列入 NO_EMIT_PACKAGES，不应同时出现在 tsconfig.json 的 references 里`,
  );
}

// 共享包自身必须零第三方依赖（CONTRACT-TS §2）
const gwDeps = Object.keys(JSON.parse(read("packages/core/gateway/package.json")).dependencies ?? {});
check(gwDeps.length === 0, `packages/core/gateway: 共享包必须零运行依赖，当前 ${gwDeps.join(", ")}`);

// 公共池模型动态化（全模型池）：不再断言固定 2 个 flash，改为检查动态收集函数存在
const poolTargets = read("packages/core/gateway/src/pool/pool-targets.ts");
check(/export function poolModels\(\)/.test(poolTargets), "pool-targets.ts: 缺 poolModels()（全模型池动态收集）");
check(/function asPoolModel\(/.test(poolTargets), "pool-targets.ts: 缺 asPoolModel()（动态匹配）");
// 共享层代码不得硬编码厂商模型名（`AGENTS.md` 的「仓库结构与约束」：共享层不许出现渠道知识）。
// 剥离注释后再查 —— JSDoc 里的示例 id 是文档，不是共享层持有的模型知识。
const poolCode = poolTargets
  .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
  .replace(/^\s*\/\/.*$/gm, ""); // 行注释
check(
  !/"(deepseek|glm|qwen|kimi|doubao)-[a-z0-9.-]+"/i.test(poolCode),
  "pool-targets.ts: 共享层不得硬编码厂商模型名（模型只由各渠道 exposedIds() 提供）",
);

if (failures.length > 0) {
  console.error(`✗ 工程契约校验失败（${failures.length} 项，渠道 ${channelDirs.length} 个 / 注册 ${registeredImports} 个）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `✓ 工程契约校验通过：${channelDirs.length} 个渠道（7 文件 + 依赖白名单 + cid 一致），` +
    `bin 双名，工程引用对齐，POOL_MODELS 动态化`,
);
