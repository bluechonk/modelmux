/**
 * 一键接入：把本机 harness 的模型配置改写成网关的 deepseek 裸模型名。
 *
 * 只改**模型清单**，不动 baseURL / apiKeyEnv / retryPolicy —— 现有接线通常已正确，
 * 越少改动越安全；写前备份到 `<root>/backups/integrate/`（误改可回滚）。
 * 幂等：内容与目标一致时不落盘（控制台据此显示「已是最新」）。
 *
 * 为什么在 app 层：写的是**客户端**配置文件（`~/.zcode` / `~/.dsh`），不是网关运行时；
 * 控制台（http 层）经 `ControlBridge.integrate` 注入调用，避免 http → app 的反向依赖
 * （见 `scripts/verify-layering.mjs`）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEEPSEEK_EXPOSED_IDS } from "../pool/model-family.js";
import { poolModels } from "../pool/pool-targets.js";
import { rootDir } from "../runtime/paths.js";

/** 接入目标。 */
export type IntegrationTarget = "zcode" | "dsh";

export interface IntegrationResult {
  ok: boolean;
  target: IntegrationTarget;
  /** 对外模型名（写进客户端配置的就是这几个）。 */
  models: string[];
  /** 内容被改写的文件（绝对路径）。 */
  changed: string[];
  /** 已正确、无需改动的文件。 */
  unchanged: string[];
  /** 本次备份目录（有改写时）。 */
  backupDir?: string;
  error?: string;
  /** 人读的变更说明（控制台原样展示）。 */
  notes: string[];
}

/** 网关对外端点（客户端 baseURL 指向它）。 */
const GATEWAY_BASE_URL = "http://127.0.0.1:4412/v1";
/** zcode 供应商在 provider_config.json 里的标识。 */
const ZCODE_PROVIDER_ID = "new-provider";
const ZCODE_PROVIDER_NAME = "modelmux";
/** dsh 里承载网关配置的 provider / 插件 id。 */
const DSH_PROVIDER = "modelmux";
const DSH_PLUGIN_ID = "llm-pi-ai";
const DSH_PROFILES = ["acp", "desktop", "headless"] as const;

/** 对外模型名：取当前模型池；池为空（渠道未注册）时回落家族常量。 */
function exposedModels(): string[] {
  const pooled = poolModels();
  return pooled.length > 0 ? [...pooled] : [...DEEPSEEK_EXPOSED_IDS];
}

/** 本次接入的对外模型名（供调用方/测试注入）。 */
export function integrateClient(target: IntegrationTarget, models: string[] = exposedModels()): IntegrationResult {
  return target === "zcode" ? integrateZcode(models) : integrateDsh(models);
}

// ── 备份 ────────────────────────────────────────────────────────────────────

let backupRoot: string | undefined;

/**
 * 备份目录（懒创建）：`<root>/backups/integrate/<target>-<时间戳>/`。
 *
 * 改的是**本机客户端配置**（不是网关状态），一旦写坏用户可能连 harness 都起不来 ——
 * 所以每次改写前先留一份原文件。目录按次分桶，便于逐次回滚。
 */
function backupDirFor(target: IntegrationTarget): string {
  backupRoot ??= join(rootDir(), "backups", "integrate");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(backupRoot, `${target}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原样备份一个待改文件（同名）。返回备份路径。 */
function backupFile(dir: string, file: string): string {
  const dest = join(dir, file.split(/[\\/]/).pop() ?? "config");
  writeFileSync(dest, readFileSync(file), "utf8");
  return dest;
}

// ── zcode ───────────────────────────────────────────────────────────────────

/**
 * zcode：`~/.zcode/v2/provider_config.json`（JSON，直接读写）。
 *
 * 改三处：provider 规则的 `api`（baseUrl）与 `personalModelIds` / `modelOrder`（3 个模型名）；
 * `modelConfigRules.providerModelRules` 里给这 3 个模型补 `enabled: true`，并清掉该供应商
 * 下**已不在清单里**的旧模型规则（例如改造前的 `<cid>/<模型>`）。
 */
function integrateZcode(models: string[]): IntegrationResult {
  const result: IntegrationResult = { ok: false, target: "zcode", models, changed: [], unchanged: [], notes: [] };
  const file = join(homedir(), ".zcode", "v2", "provider_config.json");
  if (!existsSync(file)) {
    result.error = `找不到 zcode 配置：${file}（zcode 装了吗？）`;
    return result;
  }

  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    result.error = `zcode 配置不是合法 JSON：${String(err)}`;
    return result;
  }
  const config = (root["config"] ??= {}) as Record<string, unknown>;
  const rules = ((config["providerConfigRules"] ??= {}) as Record<string, unknown>);
  const providerRules = (rules["providerRules"] ??= []) as Array<Record<string, unknown>>;

  let rule = providerRules.find(
    (r) => r["providerId"] === ZCODE_PROVIDER_ID || r["providerName"] === ZCODE_PROVIDER_NAME,
  );
  if (!rule) {
    rule = { providerId: ZCODE_PROVIDER_ID, providerName: ZCODE_PROVIDER_NAME, config: {} };
    providerRules.push(rule);
    result.notes.push("新增 modelmux 供应商规则");
  }
  const ruleConfig = (rule["config"] ??= {}) as Record<string, unknown>;
  const before = JSON.stringify(ruleConfig);
  ruleConfig["api"] = { type: "openai-chat-completions", baseUrl: GATEWAY_BASE_URL };
  ruleConfig["personalModelIds"] = [...models];
  ruleConfig["modelOrder"] = [...models];
  if (JSON.stringify(ruleConfig) !== before) {
    result.notes.push(`供应商 ${ZCODE_PROVIDER_NAME}：baseUrl=${GATEWAY_BASE_URL}，模型=${models.join(" / ")}`);
  }

  // 逐模型的启用开关：补齐新模型、清掉该供应商下已下线的旧模型
  const modelRules = ((config["modelConfigRules"] ??= {}) as Record<string, unknown>);
  const providerModelRules = (modelRules["providerModelRules"] ??= []) as Array<Record<string, unknown>>;
  const wanted = new Set(models);
  const kept = providerModelRules.filter(
    (r) => !(r["providerId"] === ZCODE_PROVIDER_ID && !wanted.has(String(r["modelId"]))),
  );
  for (const model of models) {
    const hit = kept.find((r) => r["providerId"] === ZCODE_PROVIDER_ID && r["modelId"] === model);
    if (hit) {
      const c = (hit["config"] ??= {}) as Record<string, unknown>;
      c["enabled"] = true;
    } else {
      kept.push({ modelId: model, providerId: ZCODE_PROVIDER_ID, config: { enabled: true } });
      result.notes.push(`新增模型启用项 ${model}`);
    }
  }
  modelRules["providerModelRules"] = kept;

  const text = `${JSON.stringify(root, null, 2)}\n`;
  if (text === readFileSync(file, "utf8")) {
    result.unchanged.push(file);
    result.ok = true;
    return result;
  }
  const dir = backupDirFor("zcode");
  backupFile(dir, file);
  writeFileSync(file, text, "utf8");
  result.changed.push(file);
  result.backupDir = dir;
  result.ok = true;
  return result;
}

// ── dsh ─────────────────────────────────────────────────────────────────────

/** 行首缩进宽度（按空格计；制表符按 2 空格折算）。 */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return (m?.[0] ?? "").replace(/\t/g, "  ").length;
}

function isBlank(line: string): boolean {
  return line.trim() === "" || line.trimStart().startsWith("#");
}

/** 在 `lines` 里找 `indent` 层级、`key:` 形式的行；找不到返回 -1。 */
function findKey(lines: string[], indent: number, key: string): number {
  const re = new RegExp(`^ {${indent}}${key}:\\s*$`);
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i]!)) return i;
  return -1;
}

/** 渲染一个 dsh 模型条目（缩进 = `indent`）。 */
function renderDshModel(indent: number, model: string): string[] {
  const pad = " ".repeat(indent);
  return [
    `${pad}- id: ${model}`,
    `${pad}  name: ${model}`,
    `${pad}  input:`,
    `${pad}    - text`,
  ];
}

/** 渲染完整的 `llm-pi-ai` patch 条目（顶层，缩进 0）。 */
function renderDshProviderEntry(models: string[]): string[] {
  const lines = [
    `- id: ${DSH_PLUGIN_ID}`,
    `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
    `  config:`,
    `    providers:`,
    `      ${DSH_PROVIDER}:`,
    `        displayName: ${DSH_PROVIDER}`,
    `        apiKeyEnv: MODELMUX_API_KEY`,
    `        api: openai-completions`,
    `        baseURL: ${GATEWAY_BASE_URL}`,
    `        models:`,
  ];
  for (const model of models) lines.push(...renderDshModel(10, model));
  return lines;
}

/** 渲染 `acp` 路由条目（ACP 会话的默认 provider/model）。 */
function renderDshAcpEntry(model: string): string[] {
  return ["- id: acp", "  config:", `    provider: ${DSH_PROVIDER}`, `    model: ${model}`];
}

/**
 * dsh：`~/.dsh/profiles/<profile>/cordis.patch.yml`（YAML，**文本级**改写）。
 *
 * 共享层零依赖 → 不能引 YAML 解析器；且 `desktop` 的 patch 里还有 longcat 等**其它
 * provider**，整条替换 `llm-pi-ai` 会误删。因此只定位 `providers.modelmux` 块下的
 * `models:` 列表并整段替换，其余行原样保留。
 */
function integrateDsh(models: string[]): IntegrationResult {
  const result: IntegrationResult = { ok: false, target: "dsh", models, changed: [], unchanged: [], notes: [] };
  const profilesDir = join(homedir(), ".dsh", "profiles");
  if (!existsSync(profilesDir)) {
    result.error = `找不到 dsh profiles 目录：${profilesDir}（dsh 装了吗？）`;
    return result;
  }
  let dir: string | undefined;

  for (const profile of DSH_PROFILES) {
    const file = join(profilesDir, profile, "cordis.patch.yml");
    if (!existsSync(file)) continue;
    const original = readFileSync(file, "utf8");
    const next = upsertDshPatch(original, profile, models);
    if (next === original) {
      result.unchanged.push(file);
      continue;
    }
    dir ??= backupDirFor("dsh");
    backupFile(dir, file);
    writeFileSync(file, next, "utf8");
    result.changed.push(file);
    result.notes.push(`${profile}：模型清单改为 ${models.join(" / ")}`);
  }

  if (result.changed.length === 0) {
    result.ok = true;
    if (result.unchanged.length === 0) result.error = `${profilesDir} 下没有可改的 profile（${DSH_PROFILES.join(" / ")}）`;
    return result;
  }
  result.backupDir = dir;
  result.ok = true;
  return result;
}

/**
 * 改写单个 dsh profile patch：替换 `providers.modelmux.models` 列表；
 * provider 不存在时追加完整条目；`acp` profile 再补 ACP 路由条目。
 */
function upsertDshPatch(text: string, profile: string, models: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  const providerIdx = lines.findIndex((l) => /^(\s*)modelmux:\s*$/.test(l));
  let out: string[];

  if (providerIdx < 0) {
    // 没有 modelmux provider：整份文件替换成「新条目（+ acp 路由）」，但保留文件头注释
    const head = lines.filter((l) => isBlank(l));
    while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop();
    const body = [...renderDshProviderEntry(models)];
    if (profile === "acp") body.push(...renderDshAcpEntry(models[0]!));
    out = [...head, ...body];
  } else {
    out = replaceDshModels(lines, providerIdx, models);
    if (profile === "acp" && !lines.some((l) => /^- id: acp\s*$/.test(l))) {
      out = [...out, ...renderDshAcpEntry(models[0]!)];
    }
  }

  return `${out.join(eol).replace(/\s+$/, "")}${eol}`;
}

/**
 * 替换 `modelmux:` 块下的 `models:` 列表。
 *
 * 定位规则：provider 行的缩进为 `p`；`models:` 必须出现在缩进 **大于 p** 的范围内
 * （ provider 的子键），列表项再深一层。找不到 `models:` 时插到 provider 块末尾。
 */
function replaceDshModels(lines: string[], providerIdx: number, models: string[]): string[] {
  const p = indentOf(lines[providerIdx]!);
  let end = lines.length;
  let childIndent = -1;
  for (let i = providerIdx + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i]!)) continue;
    const indent = indentOf(lines[i]!);
    if (indent <= p) {
      end = i;
      break;
    }
    if (childIndent < 0) childIndent = indent;
  }
  if (childIndent < 0) childIndent = p + 2;

  const modelsIdx = findKey(lines.slice(providerIdx + 1, end), childIndent, "models");
  const modelsLine = modelsIdx < 0 ? -1 : providerIdx + 1 + modelsIdx;

  const next = [...lines];
  if (modelsLine < 0) {
    // 插到 provider 块最后一行之后（跳过尾部空行）
    let at = end;
    while (at > providerIdx + 1 && isBlank(next[at - 1]!)) at -= 1;
    next.splice(at, 0, `${" ".repeat(childIndent)}models:`, ...renderDshModelItems(childIndent + 2, models));
    return next;
  }

  // 列表项：`models:` 之后、缩进大于 modelsIndent 的连续行
  const modelsIndent = indentOf(next[modelsLine]!);
  const itemIndent = modelsIndent + 2;
  let stop = modelsLine + 1;
  while (stop < next.length && (isBlank(next[stop]!) || indentOf(next[stop]!) >= itemIndent)) stop += 1;
  // 去掉替换区间尾部混进来的空行（它们属于块外）
  let last = stop;
  while (last > modelsLine + 1 && isBlank(next[last - 1]!)) last -= 1;
  next.splice(modelsLine + 1, last - (modelsLine + 1), ...renderDshModelItems(itemIndent, models));
  return next;
}

/** 渲染 models 列表项（`- id: …` 形式）。 */
function renderDshModelItems(indent: number, models: string[]): string[] {
  const out: string[] = [];
  for (const model of models) out.push(...renderDshModel(indent, model));
  return out;
}
