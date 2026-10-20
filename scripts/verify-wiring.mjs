#!/usr/bin/env node
/**
 * 接线与协议形态校验（条文见 docs/CONTRACT-TS.md §5）。
 *
 * 这套校验守的是**接上了没有**、**形态对不对** —— 现有 `verify-*.mjs` 只守
 * 「文件在哪、依赖朝哪、md 落哪」，协议语义一条都没查，于是近三轮反复出现同一类回归：
 *
 * - 渠道导出注入器却**没在装配处调用** → 请求体里恒是默认值（qodercn 目录元数据）
 * - 错误帧的 `code` 传数字 → 客户端按字符串解析，整帧解码失败
 * - assistant 的工具调用被改写成单个对象 → 上游按「前序消息带 tool_calls」校验，直接拒收
 * - 一轮响应连吐多个信封，只按单信封解析 → 整段当文本透传
 *
 * 每条规则都**只读文件、只判形态**，不发任何请求、不碰真实上游。
 *
 * 用法：node scripts/verify-wiring.mjs（由 npm test 自动执行）
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

/** 渠道 id 全集（来自渠道目录，不硬编码在检查里 —— 见下方目录扫描）。 */
const channelsDir = join(repo, "packages", "core", "channels");
const channelDirs = readdirSync(channelsDir).filter((n) => existsSync(join(channelsDir, n, "package.json")));

/** 剥离注释：注释里的示例 id / 字段名是文档，不是代码持有的知识。 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 规则 1：注入点必须接上 ──────────────────────────────────────────────────────
// 渠道的 `upstream.ts` 导出 `set*Lookup` 注入器（把「目录知识」交给「请求体消费方」），
// 装配处（`channel.ts`）必须调用它 —— 导出而不调用 = 功能没生效，且注释还声称已注入。

for (const cid of channelDirs) {
  const srcDir = join(channelsDir, cid, "src");
  const upstreamPath = join(srcDir, "upstream.ts");
  if (!existsSync(upstreamPath)) continue;
  const upstream = read(`packages/core/channels/${cid}/src/upstream.ts`);
  const channelSrc = read(`packages/core/channels/${cid}/src/channel.ts`);

  for (const m of upstream.matchAll(/export function (set[A-Za-z0-9]*Lookup)\s*\(/g)) {
    const hook = m[1];
    check(
      new RegExp(`\\b${hook}\\s*\\(`).test(channelSrc),
      `packages/core/channels/${cid}/src/upstream.ts 导出了 ${hook} 注入器，` +
        `但 src/channel.ts 的装配处没有调用它 —— 注入点漏接（功能不生效，见 docs/CONTRACT-TS.md §5.3）`,
    );
  }

  // 规则 2：声明了模型元数据查询器的渠道，必须提供查表函数
  if (/export function setModelMetaLookup\s*\(/.test(upstream)) {
    const catalogSrc = read(`packages/core/channels/${cid}/src/catalog.ts`);
    check(
      /export function metaOfKey\s*\(/.test(catalogSrc),
      `packages/core/channels/${cid}: 声明了 setModelMetaLookup，但 catalog.ts 没有导出 metaOfKey（注入后无数据可查）`,
    );
  }
}

// ── 规则 3：错误帧的 code 必须是字符串 ───────────────────────────────────────────
// 客户端（严格 JSON 反序列化）按 `error.code` 是**字符串**解析；上游给数字时
// 整帧解码失败（实测：cannot unmarshal number into Go struct field streamWireError.error.code）。
// 允许的形态：显式 String(...) / 字符串字面量 / 模板串 / `X ?? "字面量"`（X 的字段被声明为 string）。

/** 同文件里是否把 `code` 字段声明为 string（形如 `code?: string` / `code: string`）。 */
const declaresStringCode = (text) => /code\??\s*:\s*string\b/.test(text);

/**
 * 表达式是否是「字符串安全」的（求值结果必为字符串）。
 *
 * - `String(…)` / 字符串字面量 / 模板串 → 安全；
 * - `A ?? B` → 两侧都要安全，且 **A 所属的 code 字段必须在同文件被声明为 string**
 *   （`A` 的类型来自上游载荷时可能是数字，`??` 只兜 undefined 不做类型转换）；
 * - 单一标识符 → 同文件声明为 string 时安全。
 */
const isStringy = (expr, stringy) => {
  const value = expr.trim();
  if (/^String\(/.test(value)) return true;
  if (/^["'`]/.test(value)) return true;
  const coalesce = value.match(/^([\w.]+)\s*\?\?\s*(.+)$/);
  if (coalesce) return stringy && isStringy(coalesce[2], stringy);
  if (/^[\w.]+$/.test(value)) return stringy;
  return false;
};

for (const cid of channelDirs) {
  const p = `packages/core/channels/${cid}/src/upstream.ts`;
  if (!existsSync(join(repo, p))) continue;
  const text = read(p);
  const code = stripComments(text);
  const stringy = declaresStringCode(code);

  for (const m of code.matchAll(/error:\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const cm = body.match(/\bcode:\s*([^,}]+)/);
    if (!cm) continue;
    const value = cm[1].trim();
    check(
      isStringy(value, stringy),
      `${p}: 错误帧的 code 必须是字符串（当前 \`${value}\`）—— ` +
        `上游给数字会让严格客户端整帧解码失败（用 String(...) 显式收敛）`,
    );
  }
}

// ── 规则 4：assistant 的工具调用必须保持数组形态 ─────────────────────────────────
// 某些上游按「前序消息带 tool_calls（数组）」校验工具结果；把 assistant 的调用
// 改写成**单个** `function_call` 对象会被直接拒收（实测 code=4027）。
// 允许：读 / `delete` / 嵌在 tool_calls 元素里；禁止：往消息顶层写 `function_call`。

for (const cid of channelDirs) {
  const p = `packages/core/channels/${cid}/src/upstream.ts`;
  if (!existsSync(join(repo, p))) continue;
  const code = stripComments(read(p));
  for (const m of code.matchAll(/(\w+)\[\s*["']function_call["']\s*\]\s*=\s*[^=]/g)) {
    check(
      false,
      `${p}: 禁止把 function_call 写到消息顶层（\`${m[1]}["function_call"] = …\`）—— ` +
        `上游按「前序消息带 tool_calls 数组」校验工具结果，改写成单对象会被拒收（code=4027）`,
    );
  }
}

// ── 规则 5：协议信封解析必须能处理「一轮多个信封」 ─────────────────────────────
// 上游一轮响应里会连着吐多个 `{"action":…}` 信封；只按「最外层花括号跨度」切会连成一坨，
// JSON 解析必失败 → 整段当文本透传（工具调用完全不发生）。
// 判定：用到最外层跨度（lastIndexOf("}")）的文件，必须同时具备**深度扫描**实现。

for (const cid of channelDirs) {
  const p = `packages/core/channels/${cid}/src/upstream.ts`;
  if (!existsSync(join(repo, p))) continue;
  const code = stripComments(read(p));
  if (!/lastIndexOf\(\s*["']\}["']\s*\)/.test(code)) continue;
  const hasDepthScan = /depth\s*(\+\+|\+= 1)/.test(code) && /depth\s*(-= 1|--)/.test(code);
  check(
    hasDepthScan,
    `${p}: 用了最外层花括号跨度切 JSON，但没有**深度扫描**实现 —— ` +
      `上游一轮连吐多个信封时会把它们连成一坨导致解析失败（需逐段扫描平衡括号）`,
  );
}

// ── 规则 6：共享层不得持有渠道知识 ───────────────────────────────────────────────
// 仓库硬约束：共享层不许出现厂商名、渠道 id、渠道特有字段与渠道模型名。
// 现有检查只扫了 1/40 个文件 → 这里扩到全部共享层源文件。

const CHANNEL_ID_RE = new RegExp(`["'\`](${channelDirs.join("|")})["'\`]`);
const MODEL_NAME_RE = /["'`](?:deepseek|glm|qwen|kimi|doubao|hunyuan|minimax|sensenova)-[a-z0-9.-]+["'`]/i;

const gatewaySrc = join(repo, "packages", "core", "gateway", "src");
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
for (const file of walk(gatewaySrc)) {
  const rel = file.slice(repo.length + 1).replace(/\\/g, "/");
  const code = stripComments(readFileSync(file, "utf8"));
  const idHit = code.match(CHANNEL_ID_RE);
  check(
    !idHit,
    `${rel}: 共享层不得硬编码渠道 id（出现 "${idHit?.[0]}"）—— 渠道知识只允许出现在各渠道包内`,
  );
  const modelHit = code.match(MODEL_NAME_RE);
  check(
    !modelHit,
    `${rel}: 共享层不得硬编码厂商模型名（出现 "${modelHit?.[0]}"）—— 模型只由各渠道 exposedIds() 提供`,
  );
}

if (failures.length > 0) {
  console.error(`✗ 接线与协议形态校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `✓ 接线与协议形态校验通过：注入点接线、错误码字符串、工具调用数组形态、` +
    `多信封逐段扫描、共享层无渠道知识（${channelDirs.length} 个渠道）`,
);
