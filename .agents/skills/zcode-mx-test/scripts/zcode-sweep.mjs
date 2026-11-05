// 干什么：批量回归 —— 以**网关 `/v1/models`** 的对外模型（deepseek 家族裸名）为候选集，
//        逐个跑 zcode-e2e（默认 smoke 档控成本），结果落 .tmp/zcode-sweep/<模型>.json 并打汇总表。
// 怎么跑：node scripts/zcode-sweep.mjs [--dry] [--only <模型>] [--full]
//        --dry 只打计划不跑；--full 跑工具往返（贵且慢，确认后再用）。
//        落点渠道由网关按账号池剩余额度自动挑，sweep 不指定渠道。
// 依赖什么：node >=18；modelmux 网关在跑（`MODELMUX_BASE` 可覆盖基址）；zcode.cjs（同 e2e 脚本）；
//          成本口径见 SKILL.md「测试成本红线」。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const full = args.includes("--full");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

// ---- 1. 候选集 = 网关对外模型（只有 deepseek 家族）----
const base = process.env["MODELMUX_BASE"] ?? "http://127.0.0.1:4412";
let all = [];
try {
  const resp = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const payload = await resp.json();
  all = (payload.data ?? []).map((m) => m.id).filter(Boolean);
} catch (err) {
  console.error(`读取 ${base}/v1/models 失败：${String(err)}（网关在跑吗？）`);
  process.exit(2);
}
if (all.length === 0) {
  console.error("网关没有暴露任何模型 —— 渠道都没登录？先 `mx login <cid>` 并确认额度（`mx bill <cid>`）");
  process.exit(2);
}
const models = only ? all.filter((m) => m === only) : all;
if (models.length === 0) {
  console.error(`--only ${only} 不在网关模型清单里：${all.join(", ")}`);
  process.exit(2);
}

console.log("== 计划（候选集 = 网关 /v1/models；落点渠道由网关按额度挑）");
for (const m of models) console.log(`  ${m}`);
if (dry) process.exit(0);

// ---- 2. 逐个模型跑 e2e（默认 smoke 控成本；--full 才跑工具往返）----
const outDir = path.join(repoRoot, ".tmp", "zcode-sweep");
fs.mkdirSync(outDir, { recursive: true });
const results = [];
for (const model of models) {
  console.log(`\n== 跑 ${model}`);
  const e2eArgs = [path.join(scriptDir, "zcode-e2e.mjs"), model];
  if (!full) e2eArgs.push("--smoke"); // 默认最省；工具往返只在 --full 时跑
  if (full) e2eArgs.push("--timeout", "900");
  const r = spawnSync(process.execPath, e2eArgs, { encoding: "utf8", timeout: 1000 * 1000 });
  const resultLine = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  let parsed = null;
  try { parsed = JSON.parse(resultLine.slice(7)); } catch {}
  const record = {
    model,
    mode: full ? "tool" : "smoke",
    ...(parsed ?? { ok: false, error: "e2e 无 RESULT 输出", stdout: (r.stdout ?? "").slice(-400) }),
  };
  fs.writeFileSync(path.join(outDir, `${model}.json`), JSON.stringify(record, null, 2) + "\n");
  results.push(record);
  console.log(`  → ${record.ok ? "通过" : "未过"} ${parsed?.outcome ?? ""} ${parsed?.fileOk === false ? "落盘不符" : ""}`);
}

// ---- 3. 汇总 ----
console.log("\n== 汇总（明细落 .tmp/zcode-sweep/<模型>.json）");
for (const r of results) {
  console.log(`  ${r.model.padEnd(22)} ${r.ok ? "通过" : "未过"} ${r.error ?? ""}`);
}
const okCount = results.filter((r) => r.ok).length;
console.log(`\n通过 ${okCount}/${results.length}`);
process.exit(okCount === results.length ? 0 : 1);
