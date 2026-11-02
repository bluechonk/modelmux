#!/usr/bin/env node
/**
 * 用途：对统一模型目录里缺失关键字段的模型做联网补全，写入 model-specs.json。
 *
 * 跑法：
 *   node scripts/model-enrich.mjs --dry --limit 5
 *   node scripts/model-enrich.mjs --limit 20
 *   DWS_CLI="C:/path/to/deepseek-web-search/cli/src/index.mjs" node scripts/model-enrich.mjs
 *
 * 依赖：dws（DeepSeek web search CLI）与 DEEPSEEK_API_KEY；先跑过 `mx model refresh`。
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 与共享层 paths.ts 同一口径：`MODELMUX_HOME` > `~/.modelmux`。
const home = process.env["MODELMUX_HOME"] ?? join(homedir(), ".modelmux");
const catalogPath = join(home, "model-catalog.json");
const specsPath = join(home, "model-specs.json");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const limit = Number(args[args.indexOf("--limit") + 1]) || 20;
const onlyModel = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;

/** 常见上下文档位：提取值必须落在这些档位附近，否则视为误读（如把 1M 当成 3B 模型窗口）。 */
const COMMON_CONTEXT = [4096, 8192, 16384, 32768, 65536, 100000, 128000, 131072, 200000, 262144, 524288, 1000000, 1048576, 2000000];
const COMMON_OUTPUT = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

function plausible(value, table) {
  return table.some((item) => Math.abs(value - item) / item <= 0.03);
}

/** 模型名归一（去标点与大小写），用于判断数字是否和模型名出现在同一段文本里。 */
function normalizeName(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mentionsModel(text, model) {
  const core = normalizeName(model).slice(0, 12);
  return core.length >= 6 && normalizeName(text).includes(core);
}

/** 一手/官方域名：只从这些来源提取，二手聚合站一律跳过（错数据比没有更糟）。 */
const TRUSTED = [
  "deepseek.com",
  "deepseek.ai",
  "volcengine.com",
  "siliconflow.com",
  "siliconflow.cn",
  "tencent.com",
  "tencentcloud.com",
  "hunyuan.tencent.com",
  "aliyun.com",
  "alibabacloud.com",
  "bigmodel.cn",
  "zhipuai.cn",
  "moonshot.cn",
  "moonshot.ai",
  "minimax.io",
  "minimaxi.com",
  "huggingface.co",
  "github.com",
  "modelscope.cn",
  "openrouter.ai",
  "openai.com",
  "anthropic.com",
  "ai.google.dev",
  "deepmind.google",
  "stepfun.com",
  "01.ai",
  "baichuan-ai.com",
];

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.enrich.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    rmSync(tmp, { force: true });
  }
}

function scale(text) {
  const value = Number.parseFloat(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function toTokens(number, unit) {
  const value = scale(number);
  if (value === null) return null;
  if (!unit) return value >= 1000 ? Math.round(value) : null;
  if (unit.toLowerCase() === "k") return Math.round(value * 1024);
  if (unit.toLowerCase() === "m") return Math.round(value * 1024 * 1024);
  return null;
}

/** 从一段文本里提取上下文窗口；只认带单位或明确 "tokens" 的数字。 */
function extractContext(text) {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*([KkMm])\s*(?:context|上下文|tokens?)/,
    /(?:context(?:\s+window)?|上下文(?:窗口)?)[^\d]{0,24}(\d+(?:\.\d+)?)\s*([KkMm])\b/,
    /(\d{3,7})\s*tokens?\s*(?:context|上下文)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = match[2] ? toTokens(match[1], match[2]) : toTokens(match[1], null);
    if (value !== null && plausible(value, COMMON_CONTEXT)) return value;
  }
  return null;
}

/** 从一段文本里提取最大输出；要求出现 max output / 输出上限 等词。 */
function extractOutput(text) {
  const patterns = [
    /max(?:imum)?\s*output[^\d]{0,24}(\d+(?:\.\d+)?)\s*([KkMm]?)\b/,
    /输出(?:上限|长度)[^\d]{0,24}(\d+(?:\.\d+)?)\s*([KkMm]?)\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = toTokens(match[1], match[2]);
    if (value !== null && plausible(value, COMMON_OUTPUT)) return value;
  }
  return null;
}

function dwsSearch(query) {
  const cli = process.env["DWS_CLI"] ?? "dws";
  const useNode = cli.endsWith(".mjs") || cli.endsWith(".js");
  const cmd = useNode ? process.execPath : cli;
  const base = useNode ? [cli] : [];
  const result = spawnSync(cmd, [...base, "search", query, "--count", "5", "--format", "json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : (parsed.results ?? []);
  } catch {
    return [];
  }
}

function modelQuery(id) {
  const model = id.split("/")[1] ?? id;
  return `${model} context window max output tokens official specs`;
}

function trusted(url) {
  return TRUSTED.some((domain) => String(url).includes(domain));
}

function main() {
  const catalog = readJson(catalogPath, null);
  if (!catalog?.models) {
    console.error(`没有找到目录快照：${catalogPath}（先跑 mx model refresh）`);
    process.exit(2);
  }

  const specs = readJson(specsPath, { version: 1, models: {} });
  specs.version = 1;
  specs.models ??= {};

  const targets = [];
  for (const entry of Object.values(catalog.models)) {
    if (onlyModel && !entry.id.includes(onlyModel)) continue;
    const missing =
      entry.meta_sources.context_window === "default" ||
      entry.meta_sources.max_output_tokens === "default";
    if (!missing) continue;
    // 已经补过的跳过：快照可能还没刷新，但 specs 里已有值就不要再搜一次
    const existing = specs.models[entry.id.split("/")[1] ?? entry.id];
    if (existing?.contextWindow !== undefined && existing?.maxOutputTokens !== undefined) continue;
    targets.push(entry);
  }

  const seen = new Set();
  const unique = [];
  for (const entry of targets) {
    const key = (entry.id.split("/")[1] ?? entry.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  console.log(`待补全模型：${unique.length} 个（本次最多处理 ${limit} 个）`);
  let done = 0;
  for (const entry of unique.slice(0, limit)) {
    const results = dwsSearch(modelQuery(entry.id));
    const ordered = results.filter((item) => trusted(item.url));
    const modelName = entry.id.split("/")[1] ?? entry.id;
    let context = null;
    let output = null;
    let source = "";
    for (const item of ordered) {
      const text = `${item.title ?? ""}\n${item.snippet ?? ""}\n${item.summary ?? ""}`;
      // 数字必须和模型名出现在同一段文本里：防止把同一页面上别的模型规格抓过来
      if (!mentionsModel(text, modelName)) continue;
      context ??= extractContext(text);
      output ??= extractOutput(text);
      if ((context || output) && !source) source = String(item.url ?? "");
      if (context && output) break;
    }
    if (context === null && output === null) {
      const hint = results.length > 0 ? "（有结果但都非一手来源）" : "（无搜索结果）";
      console.log(`- ${entry.id}: 未提取到${hint}，保留兜底`);
      continue;
    }
    const model = entry.id.split("/")[1] ?? entry.id;
    const patch = { _source: `web_search:${source}`, _updated: new Date().toISOString() };
    if (context !== null) patch.contextWindow = context;
    if (output !== null) patch.maxOutputTokens = output;
    console.log(`- ${entry.id}: context=${context ?? "-"} output=${output ?? "-"} <- ${source}`);
    if (!dry) {
      specs.models[model] = { ...(specs.models[model] ?? {}), ...patch };
      writeJsonAtomic(specsPath, specs);
    }
    done += 1;
  }
  console.log(`完成：写入 ${done} 条${dry ? "（dry-run，未落盘）" : ""}`);
}

main();
