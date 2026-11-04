// 干什么：全渠道批量回归 —— 以 zcode 供应商清单为候选集，按网关倍率给每个渠道选免费/最低档模型，
//        逐渠道跑 zcode-e2e（默认 smoke 档控成本），结果逐渠道落 .tmp/zcode-sweep/<cid>.json 并打汇总表。
// 怎么跑：node scripts/zcode-sweep.mjs [--dry] [--only <cid>] [--full] [--include-unknown]
//        --dry 只打选型计划不跑；--full 跑工具往返（贵且慢，确认后再用）；倍率全是 `-` 的渠道默认跳过。
// 依赖什么：node >=18；mx 在 PATH；modelmux 网关在跑；zcode.cjs（同 e2e 脚本）；
//          成本口径见 SKILL.md「测试成本红线」——倍率 0 优先，否则清单内最低档。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const full = args.includes("--full");
const includeUnknown = args.includes("--include-unknown");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

// ---- 1. zcode 供应商清单里的 modelmux 模型（候选集 = 这里，网关有但 zcode 没登记的不可测）----
const pcPath = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
const pc = JSON.parse(fs.readFileSync(pcPath, "utf8"));
const provider = (pc.config?.providerConfigRules?.providerRules ?? []).find(
  (p) => p.providerName === "modelmux" || p.providerId === "new-provider",
);
if (!provider) {
  console.error("provider_config.json 里没有 modelmux 供应商（providerName=modelmux / providerId=new-provider）");
  process.exit(2);
}
const zcodeModels = Object.values(provider.config?.personalModelIds ?? {});
if (zcodeModels.length === 0) {
  console.error("modelmux 供应商的 personalModelIds 为空 —— 先在 zcode 桌面端把模型加进清单");
  process.exit(2);
}

// ---- 2. 按渠道分组，查网关倍率，选免费/最低档 ----
const byCid = new Map();
for (const m of zcodeModels) {
  const cid = m.split("/")[0];
  if (!byCid.has(cid)) byCid.set(cid, []);
  byCid.get(cid).push(m);
}

const rateFor = (cid) => {
  // mx model <cid> 行形态：`  <cid>/<模型>  <倍率|->  ← <上游名>`
  const r = spawnSync("mx", ["model", cid], { encoding: "utf8", shell: process.platform === "win32" });
  const rates = new Map();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = line.match(/^\s+([\w-]+\/[\w.-]+)\s+(\d+(?:\.\d+)?|-)\s+←/);
    if (m) rates.set(m[1], m[2] === "-" ? null : Number(m[2]));
  }
  return rates;
};

const plan = [];
for (const [cid, models] of byCid) {
  if (only && cid !== only) continue;
  const rates = rateFor(cid);
  const withRates = models.map((m) => ({ model: m, rate: rates.get(m) ?? null }));
  const free = withRates.filter((x) => x.rate === 0);
  const priced = withRates.filter((x) => typeof x.rate === "number" && x.rate > 0);
  const picked =
    free.sort((a, b) => String(a.model).localeCompare(String(b.model)))[0] ??
    priced.sort((a, b) => a.rate - b.rate)[0] ??
    (includeUnknown ? withRates[0] : null);
  plan.push({
    cid,
    candidates: withRates,
    pick: picked?.model ?? null,
    rate: picked?.rate ?? null,
    skip: !picked,
  });
}

console.log("== 选型计划（候选集 = zcode 供应商清单；倍率来自 mx model <cid>）");
for (const p of plan) {
  console.log(
    `  ${p.cid.padEnd(10)} → ${p.skip ? "(无可测模型" + (includeUnknown ? "" : "，倍率未知；--include-unknown 可强制") + ")" : `${p.pick}  倍率=${p.rate}${p.rate === 0 ? "（免费）" : ""}`}`,
  );
}
if (dry) process.exit(0);

// ---- 3. 逐渠道跑 e2e（默认 smoke 控成本；--full 才跑工具往返）----
const outDir = path.join(repoRoot, ".tmp", "zcode-sweep");
fs.mkdirSync(outDir, { recursive: true });
const runnable = plan.filter((p) => !p.skip);
const results = [];
for (const p of runnable) {
  console.log(`\n== 跑 ${p.cid}: ${p.pick}`);
  const e2eArgs = [path.join(scriptDir, "zcode-e2e.mjs"), p.pick];
  if (p.rate !== 0 && !full) e2eArgs.push("--smoke"); // 免费模型才默认跑完整工具往返
  if (full) e2eArgs.push("--timeout", "900");
  const r = spawnSync(process.execPath, e2eArgs, { encoding: "utf8", timeout: 1000 * 1000 });
  const resultLine = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  let parsed = null;
  try { parsed = JSON.parse(resultLine.slice(7)); } catch {}
  const record = { cid: p.cid, pick: p.pick, rate: p.rate, mode: full ? "tool" : "smoke", ...(parsed ?? { ok: false, error: "e2e 无 RESULT 输出", stdout: (r.stdout ?? "").slice(-400) }) };
  fs.writeFileSync(path.join(outDir, `${p.cid}.json`), JSON.stringify(record, null, 2) + "\n");
  results.push(record);
  console.log(`  → ${record.ok ? "通过" : "未过"} ${parsed?.outcome ?? ""} ${parsed?.fileOk === false ? "落盘不符" : ""}`);
}

// ---- 4. 汇总 ----
console.log("\n== 汇总（明细落 .tmp/zcode-sweep/<cid>.json）");
for (const r of results) {
  console.log(`  ${r.cid.padEnd(10)} ${r.pick.padEnd(34)} 倍率=${String(r.rate).padEnd(5)} ${r.ok ? "通过" : "未过"} ${r.error ?? ""}`);
}
const okCount = results.filter((r) => r.ok).length;
console.log(`\n通过 ${okCount}/${results.length}`);
process.exit(okCount === results.length ? 0 : 1);
