/**
 * 一键接入：把本机 harness 的模型配置改写成网关的对外模型名。
 *
 * 只改**模型清单**，不动 baseURL / apiKeyEnv / retryPolicy；写前备份到
 * `<root>/backups/integrate/`，幂等。两处例外：zcode 个人供应商规则必须带齐
 * group / access / api（缺则整个供应商不进注册表）；dsh 的 `apiKeyEnv` 引用名必须
 * 在 `~/.dsh/.credentials.yaml` 的 refs 里有条目。
 *
 * 为什么在 app 层：写的是**客户端**配置（`~/.zcode` / `~/.dsh`），不是网关运行时；
 * 控制台经 `ControlBridge.integrate` 注入调用，避免 http → app 的反向依赖。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { POOL_EXPOSED_IDS } from "../pool/model-family.js";
import { poolModels } from "../pool/pool-targets.js";
import { rootDir } from "../runtime/paths.js";
import { writeAtomicFile } from "../runtime/secret-file.js";

/** 接入目标。 */
export type IntegrationTarget = "zcode" | "dsh" | "claude-code" | "claude-desktop" | "codex";

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
/** Anthropic 客户端的 baseURL（Claude Code 自己拼 `/v1/messages`，**不带** /v1）。 */
const GATEWAY_ANTHROPIC_URL = "http://127.0.0.1:4412";
/** zcode 供应商在 provider_config.json 里的标识。 */
const ZCODE_PROVIDER_ID = "new-provider";
const ZCODE_PROVIDER_NAME = "modelmux";
/** dsh 里承载网关配置的 provider / 插件 id。 */
const DSH_PROVIDER = "modelmux";
const DSH_PLUGIN_ID = "llm-pi-ai";
const DSH_PROFILES = ["acp", "desktop", "headless", "web"] as const;
/**
 * 本机回环网关不校验入站密钥，这里只放占位值：zcode 的供应商完整校验要求
 * `access.apiKey` 非空，dsh 要求 `apiKeyEnv` 指向的凭据已配置 —— 两者都只校验「有值」。
 */
const LOCAL_API_KEY = "modelmux-local";
/** dsh 凭据引用名（`apiKeyEnv` 指向它，由 `~/.dsh/.credentials.yaml` 的 `refs` 解析）。 */
const DSH_CREDENTIAL_REF = "MODELMUX_API_KEY";

/** 对外模型名：取当前模型池；池为空（渠道未注册）时回落家族常量。 */
function exposedModels(): string[] {
  const pooled = poolModels();
  return pooled.length > 0 ? [...pooled] : [...POOL_EXPOSED_IDS];
}

/** 本次接入的对外模型名（供调用方/测试注入）。 */
export function integrateClient(target: IntegrationTarget, models: string[] = exposedModels()): IntegrationResult {
  switch (target) {
    case "zcode":
      return integrateZcode(models);
    case "dsh":
      return integrateDsh(models);
    case "claude-code":
      return integrateClaudeCode(models);
    case "claude-desktop":
      return integrateClaudeDesktop(models);
    case "codex":
      return integrateCodex(models);
  }
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

/** 原样备份一个待改文件（同名，0600 —— 备份源可能是凭据文件）。返回备份路径。 */
function backupFile(dir: string, file: string): string {
  const dest = join(dir, file.split(/[\\/]/).pop() ?? "config");
  writeAtomicFile(dest, readFileSync(file, "utf8"), 0o600);
  return dest;
}

// ── zcode ───────────────────────────────────────────────────────────────────

/** `access` 是否已满足 zcode 的完整校验（api-key 系类型 + 非空 apiKey）。 */
function hasUsableAccessKey(access: unknown): boolean {
  if (typeof access !== "object" || access === null) return false;
  const rec = access as Record<string, unknown>;
  // zhipu-account 是另一套完整形态，不在本功能职责内，原样保留
  if (rec["type"] === "zhipu-account") return true;
  if (rec["type"] !== "api-key" && rec["type"] !== "zhipu-coding-plan-api-key") return false;
  const key = rec["apiKey"];
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * zcode：`~/.zcode/v2/provider_config.json`（JSON，直接读写）。
 *
 * 改三处：provider 规则的 `api`（baseUrl）与 `personalModelIds` / `modelOrder`（3 个模型名），
 * 并补齐 `group` / `access`（zcode 完整校验的必填项，缺则供应商不进注册表）；
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
  // zcode 对个人供应商规则做完整校验（group / access / api 缺一不可），缺任一项就整个
  // 供应商不进注册表 —— 模型清单写得再对，setModel 也报「Provider Registry 中不存在 Model」。
  ruleConfig["group"] = "standard-personal";
  if (!hasUsableAccessKey(ruleConfig["access"])) {
    ruleConfig["access"] = { type: "api-key", apiKey: LOCAL_API_KEY };
  }
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
    `        apiKeyEnv: ${DSH_CREDENTIAL_REF}`,
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

/** `refs` 里是否已有该引用：跳过注释行，block（行首即 key）与 flow（`{` / `,` 之后）都认。 */
function hasCredentialRef(lines: string[]): boolean {
  return lines.some((l) => {
    const code = l.replace(/#.*$/, "");
    return (
      new RegExp(`^\\s*["']?${DSH_CREDENTIAL_REF}["']?\\s*:`).test(code) ||
      new RegExp(`(?:\\{|,)\\s*["']?${DSH_CREDENTIAL_REF}["']?\\s*:`).test(code)
    );
  });
}

/** `refs` 子条目缩进：取 `refs:` 之后第一个真实条目的缩进；没有则按 refs 缩进 +2。 */
function childIndentOf(lines: string[], refsIdx: number): string {
  for (let i = refsIdx + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (isBlank(l) || /^\s*}/.test(l)) continue; // 空行 / flow 的收尾括号都不是条目
    return " ".repeat(indentOf(l));
  }
  return `${" ".repeat(indentOf(lines[refsIdx]!))}  `;
}

/**
 * flow（`refs: { … }`，单行或多行）的收尾行下标：按**净花括号深度**走，而不是
 * 「第一个含 `}` 的行」—— 子条目自身是内联 flow（`A: { x: 1 }`）时该行净贡献为 0，
 * 按行找会把内层的 `}` 误判成收尾。逐行**先剥行尾注释再数**：注释里的不平衡花括号
 * （`A: 1 # use { template`）会污染深度计数。只读不写；refs 由 dsh 的凭据提供方
 * 管理，值只会是引用名与固定字面量（本流程只追加 `MODELMUX_API_KEY` 一项），
 * 引号包裹花括号的值不存在。
 */
function flowCloseLine(lines: string[], refsIdx: number): number {
  let depth = 0;
  for (let i = refsIdx; i < lines.length; i += 1) {
    const [bare] = splitTrailingComment(lines[i]!);
    for (const ch of bare) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth <= 0) return i;
  }
  return -1;
}

/**
 * 拆行尾注释（第一个 ` #` 起）；没有返回 `[原行, ""]`。
 * 追加条目与数括号前都要先拆 —— 否则 `A: 1 # note` 会被拼成
 * `A: 1 # note, B: 2`（条目落进注释里静默丢失）。值本身含「空格 + #」的 YAML
 * 不由本函数处理（refs 由 dsh 的凭据提供方机器管理，值里不会出现）。
 */
function splitTrailingComment(line: string): [string, string] {
  const at = line.indexOf(" #");
  if (at < 0) return [line, ""];
  return [line.slice(0, at).replace(/[ \t]+$/, ""), line.slice(at)];
}

/**
 * 确保 dsh 凭据引用存在：补丁里的 `apiKeyEnv: MODELMUX_API_KEY` 只是个引用名，
 * 真正的密钥在 `~/.dsh/.credentials.yaml` 的 `refs` 里；名字不在 refs 中时 dsh 的
 * Models 页判定该 provider 不可用（具名凭据未配置），请求发不出去。
 *
 * 文本级改写：只往 `refs` 里补一行，其余条目、注释与格式原样保留（该文件由 dsh 的
 * 凭据提供方管理，整文件重写会丢格式）。已存在该引用时不动。
 *
 * 并发：dsh 自己写这个文件走跨进程锁 + 原子替换（共享层引不进它的锁工具），这里
 * 只能做到原子替换，做不到互斥 —— 窗口极小，且写前备份可回滚。
 */
function ensureDshCredential(): { file: string; changed: boolean; notes: string[]; backupDir?: string } {
  const notes: string[] = [];
  const file = join(homedir(), ".dsh", ".credentials.yaml");
  const entry = `${DSH_CREDENTIAL_REF}: ${LOCAL_API_KEY}`;

  if (!existsSync(file)) {
    writeAtomicFile(file, `version: 1\nrefs: { ${entry} }\n`, 0o600);
    notes.push(`新建凭据文件并写入 ${DSH_CREDENTIAL_REF}`);
    return { file, changed: true, notes };
  }

  const original = readFileSync(file, "utf8");
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  if (hasCredentialRef(lines)) return { file, changed: false, notes };

  let text: string;
  const refsIdx = lines.findIndex((l) => /^\s*refs:\s*/.test(l));
  if (refsIdx < 0) {
    const head = original.replace(/[ \t]+$/, "").replace(/(?:\r?\n)+$/, "");
    text = `${head}${nl}refs: { ${entry} }${nl}`;
  } else {
    const next = [...lines];
    const refsLine = next[refsIdx]!;
    const close = refsLine.includes("{") ? flowCloseLine(next, refsIdx) : -1;
    if (close < 0) {
      if (refsLine.includes("{")) {
        // flow 开了但收尾判定失败（注释里有不平衡花括号等畸形）：宁可跳过写入，
        // 也不能把 block 条目拼进未闭合的 flow 里写出无效 YAML
        notes.push("refs 块形态无法安全解析，已跳过写入");
        return { file, changed: false, notes };
      }
      // block map：插到 `refs:` 之后，缩进跟着第一个子条目走
      next.splice(refsIdx + 1, 0, `${childIndentOf(next, refsIdx)}${entry}`);
    } else if (close === refsIdx) {
      // 单行 flow：`refs: { A: 1 }` → `refs: { A: 1, B: 2 }`
      const line = next[refsIdx]!;
      const [bare, comment] = splitTrailingComment(line);
      const at = bare.lastIndexOf("}");
      const head = bare.slice(0, at).replace(/[ \t]+$/, "");
      next[refsIdx] = `${head}${head.endsWith("{") ? " " : ", "}${entry}}${comment}`;
    } else {
      // 多行 flow：`refs: {` … `}` —— 追加到 `}` 前最后一个条目行（flow 靠逗号分隔）
      const closeLine = next[close]!;
      const [closeBare, closeComment] = splitTrailingComment(closeLine);
      const at = closeBare.lastIndexOf("}");
      const closeHead = closeBare.slice(0, at).replace(/[ \t]+$/, "");
      if (closeHead !== "") {
        // 条目与收尾同行（`A: 1 }` / `A: 1 # 注 }`）：注释挪到 `}` 之后
        next[close] = `${closeHead.replace(/,\s*$/, "")}, ${entry}}${closeComment}`;
      } else {
        let prev = close - 1;
        while (prev > refsIdx && isBlank(next[prev]!)) prev -= 1;
        if (prev === refsIdx) next.splice(refsIdx + 1, 0, `${childIndentOf(next, refsIdx)}${entry}`);
        else {
          // 条目拼进行尾：先拆行尾注释与尾逗号再接 —— 否则条目会落进注释，
          // 或拼出 `,,` 双逗号（无效 YAML）
          const [bareRaw, comment] = splitTrailingComment(next[prev]!);
          const bare = bareRaw.replace(/,\s*$/, "");
          next[prev] = `${bare}, ${entry}${comment}`;
        }
      }
    }
    text = next.join(nl);
  }

  const dir = backupDirFor("dsh");
  backupFile(dir, file);
  writeAtomicFile(file, text, 0o600);
  notes.push(`凭据文件写入 ${DSH_CREDENTIAL_REF}（备份 ${dir}）`);
  return { file, changed: true, notes, backupDir: dir };
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

  // 凭据引用与补丁分开落：补丁写模型清单，凭据文件写 `apiKeyEnv` 指向的名字。
  const cred = ensureDshCredential();
  result.notes.push(...cred.notes);
  dir = cred.backupDir;
  if (cred.changed) result.changed.push(cred.file);
  else result.unchanged.push(cred.file);

  // 「有没有接入成功」只看 profile 本身：凭据引用被新建不能把「一个 profile 都没改」
  // 说成已接入 —— 那比报错更具误导性（界面 toast「已接入」，实际什么都没接）。
  let profileSeen = 0;
  let profileChanged = 0;
  for (const profile of DSH_PROFILES) {
    const file = join(profilesDir, profile, "cordis.patch.yml");
    if (!existsSync(file)) continue;
    profileSeen += 1;
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
    profileChanged += 1;
    result.notes.push(`${profile}：模型清单改为 ${models.join(" / ")}`);
  }

  if (profileChanged === 0) {
    result.backupDir = dir;
    if (profileSeen === 0) {
      // 一个 profile 都不存在：凭据引用写好了也只是「接线准备」，如实报失败 ——
      // ok:true 会让控制台弹「已接入」而实际什么都没接（评审抓到的误导路径）
      result.error = `${profilesDir} 下没有可改的 profile（${DSH_PROFILES.join(" / ")}）`;
      return result;
    }
    result.ok = true;
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

// ── claude code ─────────────────────────────────────────────────────────────

/**
 * Claude Code：`~/.claude/settings.json` 的 `env` patch（形态同 cc-switch 的供应商写入）。
 *
 * 只写 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型三件，**绝不写
 * `ANTHROPIC_API_KEY`** —— 两者并存会触发 Claude Code 的「Both ANTHROPIC_API_KEY and
 * ANTHROPIC_AUTH_TOKEN are set」警告并拒绝生效（cc-switch #4919 同款坑）；env 里已有的
 * ANTHROPIC_API_KEY 也一并移除。其余用户键（hooks / 权限等）原样保留。
 */
function integrateClaudeCode(models: string[]): IntegrationResult {
  const result: IntegrationResult = { ok: false, target: "claude-code", models, changed: [], unchanged: [], notes: [] };
  const dir = join(homedir(), ".claude");
  const file = join(dir, "settings.json");
  if (!existsSync(dir)) {
    result.error = `找不到 Claude Code 配置目录：${dir}（Claude Code 装了吗？）`;
    return result;
  }
  let root: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      root = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      result.error = `Claude Code 配置不是合法 JSON：${String(err)}`;
      return result;
    }
  } else {
    result.notes.push("settings.json 不存在，新建");
  }
  const env = ((root["env"] ??= {}) as Record<string, unknown>);
  const primary = models[0]!;
  const before = JSON.stringify(env);
  env["ANTHROPIC_BASE_URL"] = GATEWAY_ANTHROPIC_URL;
  env["ANTHROPIC_AUTH_TOKEN"] = LOCAL_API_KEY;
  delete env["ANTHROPIC_API_KEY"];
  // 模型族全指向池主模型：Claude Code 的 haiku/sonnet/opus 三档请求都会进网关
  env["ANTHROPIC_MODEL"] = primary;
  env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = primary;
  env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = primary;
  env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = primary;
  if (JSON.stringify(env) === before) {
    result.unchanged.push(file);
    result.ok = true;
    return result;
  }
  const backup = backupDirFor("claude-code");
  // 新建场景没有旧文件可备份（backupFile 读原文件会 ENOENT）
  if (existsSync(file)) backupFile(backup, file);
  writeAtomicFile(file, `${JSON.stringify(root, null, 2)}\n`, 0o600);
  result.changed.push(file);
  result.backupDir = backup;
  result.notes.push(`baseUrl=${GATEWAY_ANTHROPIC_URL}，模型=${primary}（haiku/sonnet/opus 同指）`);
  result.ok = true;
  return result;
}

// ── claude desktop ──────────────────────────────────────────────────────────

/**
 * Claude Desktop 的 3P（third-party）profile 路径。
 *
 * Desktop 与 Claude Code 是**两个应用**：后者读 `~/.claude/settings.json` 的环境变量，
 * 前者读自己的 3P profile（`<LOCALAPPDATA>/Claude-3p/configLibrary/`，macOS 在
 * `~/Library/Application Support/Claude-3p/`）。写错位置的后果是 Desktop 照常启动、
 * 但完全不读我们写的配置 —— 静默无效，没有任何报错。
 */
function claudeDesktopLibraryDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
  }
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(local, "Claude-3p", "configLibrary");
  }
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(configHome, "Claude-3p", "configLibrary");
}

/**
 * profile 文件名（`_meta.json` 的 `entries[].id` 与 `appliedId` 都指向它）。
 *
 * 复用已有条目的规则见 `pickDesktopProfileId`：Desktop / cc-switch 会按 UUID 命名 profile，
 * 已有同名（`name` 为 `modelmux`）的条目时**沿用它的 id**，否则 `<cid>` 这类供应商会在
 * 列表里出现两条同名项。
 */
const DESKTOP_PROFILE_NAME = "modelmux";

/** 在已有 `_meta.json` 里挑出应当复用的 profile id：同名的优先，其次 `appliedId`。 */
function pickDesktopProfileId(meta: Record<string, unknown>): string {
  const entries = Array.isArray(meta["entries"]) ? (meta["entries"] as unknown[]) : [];
  const named = entries.find(
    (e) =>
      e &&
      typeof e === "object" &&
      (e as Record<string, unknown>)["name"] === DESKTOP_PROFILE_NAME &&
      typeof (e as Record<string, unknown>)["id"] === "string",
  ) as Record<string, unknown> | undefined;
  if (named) return named["id"] as string;
  const applied = meta["appliedId"];
  if (typeof applied === "string" && applied !== "") return applied;
  return DESKTOP_PROFILE_NAME;
}

/**
 * 把一个对外模型名映射成 Desktop 认的条目。
 *
 * `name` 必须是 `anthropic/claude-<role>-…` 形态：Desktop 的模型校验器按**角色前缀**
 * （sonnet / opus / haiku / fable）认模型，不合规的条目会触发 fail-all —— **整组**被拒，
 * 表现为「模型列表里一个都没有」，而不是只丢这一项。所以这里统一挂 `sonnet-` 角色，
 * 真正的对外模型名走 `labelOverride`（界面显示的就是它）。
 */
/**
 * 三条模型的**角色槽位**：Desktop 按角色（sonnet / opus / haiku）给模型分档，
 * 同一角色只能挂一个模型，故最多并存 3 个。
 *
 * `name` 必须写成**真实存在的 Anthropic 模型名**：Desktop 的校验器
 * （`app.asar` 里 `jo()` → `ko = /^[A-Za-z0-9_-]{1,64}$/` 再叠加「须为已知 Anthropic 模型」）
 * 会拒掉自造名 —— 连斜杠与点号都不允许，`anthropic/claude-sonnet-longcat-2.5`、
 * `claude-sonnet-longcat-2-5` 实测都会被丢弃（日志：`is not an Anthropic model`），
 * 结果是模型选择器为空。真正发给网关的模型名走 `labelOverride`。
 */
const DESKTOP_ROLE_SLOTS = ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"] as const;

/**
 * 把对外模型列表映射成 Desktop 的 `inferenceModels`。
 *
 * 超过 3 个时只取前 3 个（角色槽位只有三个）。`supports1m` + `prefer1m` 必须成对出现：
 * 前者给出 1M 变体，后者让选择器只列 1M 那一项 —— 少了 UI 会退回 200k。
 */
function desktopInferenceModels(models: readonly string[]): Array<Record<string, unknown>> {
  return models.slice(0, DESKTOP_ROLE_SLOTS.length).map((model, index) => ({
    name: DESKTOP_ROLE_SLOTS[index]!,
    labelOverride: model,
    supports1m: true,
    prefer1m: true,
  }));
}

/**
 * Claude Desktop：写 3P profile（`configLibrary/modelmux.json` + `_meta.json`）。
 *
 * 走 **`inferenceProvider: "gateway"`**，模型清单写进 `inferenceModels`（**不**用模型发现，
 * 原因见 `DESKTOP_ROLE_SLOTS` 与 `modelDiscoveryEnabled` 处的注释）。
 *
 * 认证用 `x-api-key`（本地回环网关不校验入站密钥，与 Claude Code 那条同口径）。
 */
function integrateClaudeDesktop(models: string[]): IntegrationResult {
  const result: IntegrationResult = {
    ok: false,
    target: "claude-desktop",
    models,
    changed: [],
    unchanged: [],
    notes: [],
  };
  const dir = claudeDesktopLibraryDir();
  const metaFile = join(dir, "_meta.json");

  // 目录不存在 = Desktop 没装过 / 没起过 3P 模式。不替它造目录：Desktop 首次以 3P 模式
  // 启动时会自己建，凭空造一个反而可能让它认不出自己的配置根。
  if (!existsSync(dir)) {
    result.error = `找不到 Claude Desktop 的 3P 配置目录：${dir}（先启动一次 Claude Desktop）`;
    return result;
  }

  const metaBefore = existsSync(metaFile) ? readFileSync(metaFile, "utf8") : "";
  let meta: Record<string, unknown> = {};
  if (metaBefore) {
    try {
      meta = JSON.parse(metaBefore) as Record<string, unknown>;
    } catch (err) {
      result.error = `Claude Desktop 的 _meta.json 不是合法 JSON：${String(err)}`;
      return result;
    }
  }
  // 沿用已有条目（同名的优先，其次 appliedId），避免出现两条同名供应商
  const profileId = pickDesktopProfileId(meta);
  const profileFile = join(dir, `${profileId}.json`);

  const profile: Record<string, unknown> = existsSync(profileFile)
    ? (JSON.parse(readFileSync(profileFile, "utf8")) as Record<string, unknown>)
    : {};
  const before = JSON.stringify(profile);
  profile["inferenceProvider"] = "gateway";
  profile["inferenceGatewayBaseUrl"] = GATEWAY_ANTHROPIC_URL;
  profile["inferenceGatewayAuthScheme"] = "x-api-key";
  profile["inferenceGatewayApiKey"] = LOCAL_API_KEY;
  // **必须关**模型发现：它直接拿 `/v1/models` 的裸名（`longcat-2.5` / `deepseek-v4.1-flash`）
  // 当候选，而 Desktop 的校验器不接受点号 —— 实测 3 个模型全被判「不可用」
  // （日志：`Gateway /v1/models returned 0 usable models { rawCount: 3 }`，选择器为空）。
  // 显式 `inferenceModels` 里用合法 Anthropic 名 + `labelOverride` 才是可走的路。
  profile["modelDiscoveryEnabled"] = false;
  // 兜底清单：显式列全部对外模型（发现生效时以网关返回为准，这份不冲突）
  profile["inferenceModels"] = desktopInferenceModels(models);
  if (profile["disableDeploymentModeChooser"] === undefined) {
    profile["disableDeploymentModeChooser"] = true;
  }

  const entries = Array.isArray(meta["entries"]) ? (meta["entries"] as unknown[]) : [];
  const hasOurs = entries.some(
    (e) => e && typeof e === "object" && (e as Record<string, unknown>)["id"] === profileId,
  );
  if (!hasOurs) entries.push({ id: profileId, name: DESKTOP_PROFILE_NAME });
  meta["entries"] = entries;
  meta["appliedId"] = profileId;

  const metaAfter = `${JSON.stringify(meta, null, 2)}\n`;
  const profileAfter = `${JSON.stringify(profile, null, 2)}\n`;
  if (before === JSON.stringify(profile) && metaAfter === metaBefore) {
    result.unchanged.push(profileFile, metaFile);
    result.ok = true;
    return result;
  }

  const backup = backupDirFor("claude-desktop");
  if (existsSync(profileFile)) backupFile(backup, profileFile);
  if (existsSync(metaFile)) backupFile(backup, metaFile);
  writeAtomicFile(profileFile, profileAfter, 0o600);
  writeAtomicFile(metaFile, metaAfter, 0o600);
  result.changed.push(profileFile, metaFile);
  result.backupDir = backup;
  result.notes.push(
    `baseUrl=${GATEWAY_ANTHROPIC_URL}，按角色槽写入 ${Math.min(models.length, DESKTOP_ROLE_SLOTS.length)} 个模型（全部 1M 上下文）`,
  );
  result.notes.push("改完需重启 Claude Desktop 才生效");
  result.ok = true;
  return result;
}

// ── codex ───────────────────────────────────────────────────────────────────

/** `[model_providers.modelmux]` 段（TOML；Codex 的 Responses 入口，见 cc-switch 的第三方模板）。 */
function renderCodexProviderBlock(): string[] {
  return [
    "[model_providers.modelmux]",
    `name = "modelmux"`,
    `base_url = "${GATEWAY_BASE_URL}"`,
    `wire_api = "responses"`,
    `experimental_bearer_token = "${LOCAL_API_KEY}"`,
    `requires_openai_auth = false`,
  ];
}

/**
 * 标出 TOML 多行字符串（`"""` / `'''`）区间内的行下标（含开闭行）；开合不配对返回 null。
 *
 * 文本级编辑认不出字符串上下文 —— 字符串里行首的 `[` 会被当成表头，把顶层键注进
 * 字符串内部（Codex 照常启动但配置静默失效）。掩码用于表头与顶层键注入点判定。
 */
function maskTomlMultilineStrings(lines: string[]): Set<number> | null {
  const masked = new Set<number>();
  let open: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (open === null) {
      const at = /("""|''')/.exec(line);
      if (!at) continue;
      // 同行自闭合（"""x"""）：不构成区间
      if (line.slice((at.index ?? 0) + 3).includes(at[1]!)) continue;
      open = at[1]!;
      masked.add(i);
    } else {
      masked.add(i);
      if (line.includes(open)) open = null;
    }
  }
  return open === null ? masked : null;
}

/**
 * Codex：`~/.codex/config.toml` 的**文本级** TOML 改写（共享层零依赖，与 dsh 的
 * YAML 文本级改写同理由）。
 *
 * 三件事：顶层 `model_provider` / `model` 键替换或插入（**必须落在任何 `[` 表头之前**
 * —— TOML 顶层键的硬约束）；`[model_providers.modelmux]` 段整段替换或追加。凭据走
 * 段内 `experimental_bearer_token`（优先级高于 auth.json），`~/.codex/auth.json` 不碰
 * —— 不破坏 ChatGPT 登录态（cc-switch 的同款取舍）。
 *
 * 表头识别先做**多行字符串掩码**（`"""` / `'''` 区间内的行首 `[` 不是表头）：文本级
 * 编辑认不出字符串上下文，掩码失败（开合不配对）宁可放弃写入并报错 —— 写坏一份
 * Codex 配置还报成功，比不写更糟（dsh 凭据文件的同款取舍）。
 */
function integrateCodex(models: string[]): IntegrationResult {
  const result: IntegrationResult = { ok: false, target: "codex", models, changed: [], unchanged: [], notes: [] };
  const dir = join(homedir(), ".codex");
  const file = join(dir, "config.toml");
  if (!existsSync(dir)) {
    result.error = `找不到 Codex 配置目录：${dir}（Codex 装了吗？）`;
    return result;
  }
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const masked = maskTomlMultilineStrings(lines);
  if (masked === null) {
    result.error = "config.toml 的多行字符串（\"\"\" / '''）开合不配对，文本级改写无法安全进行；已跳过写入";
    return result;
  }

  // 表头行（行尾可带注释）；掩码表 = 该行不在多行字符串区间内
  const isTableHeader = (line: string, i: number): boolean =>
    /^\s*\[.*\]\s*(#.*)?$/.test(line) && !masked.has(i);

  // 1. [model_providers.modelmux] 段：替换到下一个表头，缺失则追加到文件尾
  const providerIdx = lines.findIndex((l, i) => /^\s*\[model_providers\.modelmux\]\s*(#.*)?$/.test(l) && !masked.has(i));
  let next: string[];
  if (providerIdx >= 0) {
    let end = lines.length;
    for (let i = providerIdx + 1; i < lines.length; i += 1) {
      if (isTableHeader(lines[i]!, i)) {
        end = i;
        break;
      }
    }
    next = [...lines.slice(0, providerIdx), ...renderCodexProviderBlock(), ...lines.slice(end)];
  } else {
    next = [...lines, "", ...renderCodexProviderBlock()];
  }

  // 2. 顶层 model_provider / model：只清**首个表头之前**的旧键行（TOML 顶层键的硬约束：
  //    必须在任何 `[` 表头之前），再统一插到那里 —— 段内同名键不受影响
  const nextMask = maskTomlMultilineStrings(next) ?? new Set<number>();
  const firstTable = next.findIndex((l, i) => /^\s*\[.*\]\s*(#.*)?$/.test(l) && !nextMask.has(i));
  const headEnd = firstTable < 0 ? next.length : firstTable;
  const head = next.slice(0, headEnd).filter((l) => !/^\s*(model_provider|model)\s*=/.test(l));
  const tail = firstTable < 0 ? [] : next.slice(firstTable);
  const topKeys = [`model_provider = "modelmux"`, `model = "${models[0]!}"`];
  const withKeys = [...head, ...topKeys, ...tail];

  const text = `${withKeys.join(eol).replace(/\s+$/, "")}${eol}`;
  if (text === original) {
    result.unchanged.push(file);
    result.ok = true;
    return result;
  }
  const backup = backupDirFor("codex");
  // 新建场景没有旧文件可备份（backupFile 读原文件会 ENOENT）
  if (existsSync(file)) backupFile(backup, file);
  writeAtomicFile(file, text, 0o600);
  result.changed.push(file);
  result.backupDir = backup;
  result.notes.push(`base_url=${GATEWAY_BASE_URL}（wire_api=responses），模型=${models[0]}`);
  result.ok = true;
  return result;
}
