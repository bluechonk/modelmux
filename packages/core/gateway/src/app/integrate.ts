/**
 * 一键接入：把本机 harness 的模型配置改写成网关的 deepseek 裸模型名。
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

import { DEEPSEEK_EXPOSED_IDS } from "../pool/model-family.js";
import { poolModels } from "../pool/pool-targets.js";
import { rootDir } from "../runtime/paths.js";
import { writeAtomicFile } from "../runtime/secret-file.js";

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
