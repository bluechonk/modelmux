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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { DESKTOP_ROLE_MODELS, POOL_EXPOSED_IDS } from "../pool/model-family.js";
import { poolModelMetas, poolModels } from "../pool/pool-targets.js";
import { defaultAddr } from "../runtime/cli-consts.js";
import { rootDir } from "../runtime/paths.js";
import { writeAtomicFile, writeJsonSecret } from "../runtime/secret-file.js";

/** 接入目标。 */
export type IntegrationTarget = "zcode" | "dsh" | "claude-desktop" | "codex";

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
  /**
   * 需要用户处置的警告（备份清单读不出、备份未登记 等）。
   *
   * 与 `notes` 分开放：`notes` 是「做了什么」，`warnings` 是「有东西没做成」——
   * 混在一起界面会把它当变更说明忽略，而这类问题正是「报成功但备份不可用」的来源。
   */
  warnings: string[];
}

/**
 * 网关对外端点（客户端 baseURL 指向它）。
 *
 * 取 `defaultAddr()` 而不是写死 `4412`：换端口是受支持的部署方式（调试实例、双实例并存），
 * 写死会让接入结果指向一个没人监听的地址。`defaultAddr()` 遵循渠道/仓库配置，
 * 也是 `mx start` 实际监听的来源；`--addr` 是单次运行的临时参数，**不该**被持久写进
 * 用户的客户端配置，所以这里不读它。
 */
function gatewayBaseUrl(): string {
  return `http://${defaultAddr()}/v1`;
}

/** Anthropic 客户端的 baseURL（客户端自己拼 `/v1/messages`，**不带** /v1）。 */
function gatewayAnthropicUrl(): string {
  return `http://${defaultAddr()}`;
}
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

/**
 * 取每个对外模型的输入模态（`["text"]` / `["text","image"]`）。
 *
 * 写在客户端配置里的模型条目要声明自己能收什么 —— 声明错了客户端会在本地就
 * 把图片拦下，网关再能转也没用（dsh 实测就是这个症状）。
 */
function modelModalities(models: string[]): ModalityMap {
  const out: ModalityMap = new Map();
  const metas = poolModelMetas(models);
  for (const model of models) {
    const m = metas.get(model);
    // 元数据缺失时保守按纯文本：宁可在客户端少声明，也不要声明了却转不过去
    out.set(model, m && m.inputModalities.length > 0 ? m.inputModalities : ["text"]);
  }
  return out;
}

/** 按目标分发到各客户端的接入实现（`integrateClient` 的主体）。 */
function integrateByTarget(target: IntegrationTarget, models: string[]): IntegrationResult {
  switch (target) {
    case "zcode":
      return integrateZcode(models);
    case "dsh":
      return integrateDsh(models);
    case "claude-desktop":
      return integrateClaudeDesktop(models);
    case "codex":
      return integrateCodex(models);
  }
}

/** 本次接入的对外模型名（供调用方/测试注入）。 */
export function integrateClient(target: IntegrationTarget, models: string[] = exposedModels()): IntegrationResult {
  const result = integrateByTarget(target, models);
  // 整体成功才记「接入态」标记（开关式 UI 的状态源）；失败不动 —— 开关留在原位报错误
  if (result.ok) writeIntegrationMarker(target, true);
  return result;
}

// ── 备份与还原 ──────────────────────────────────────────────────────────────

let backupRoot: string | undefined;

/**
 * 备份清单里的一条：某个被改文件**接入前**的原始位置与备份落点。
 *
 * `existed: false` 表示接入时该文件**原本不存在**（接入新建了它）—— 还原时必须删除，
 * 否则「还原」会留下一个用户从来没有的配置文件。
 */
interface BackupEntry {
  /** 原文件的绝对路径（还原时写回这里）。 */
  original: string;
  /** 备份文件名（备份目录内）。 */
  backup: string;
  /** 接入前是否存在。 */
  existed: boolean;
}

/** 备份目录里的清单文件（还原靠它找原路径；老备份没有这个文件，走反推）。 */
const BACKUP_MANIFEST = "manifest.json";

/** 清单结构。 */
interface BackupManifest {
  version: 1;
  target: IntegrationTarget;
  /** 备份时刻（ISO）。 */
  createdAt: string;
  /** 被改文件清单（按写入顺序）。 */
  files: BackupEntry[];
  /** 最近一次用这份备份做还原的时刻（ISO）；老备份没有这个字段。 */
  restoredAt?: string;
  /**
   * 本次接入**成功写盘**的时刻（ISO）；老备份没有这个字段。
   *
   * 与 `restoredAt` 配对回答「这个目标现在是不是接入态」：最新一份清单里
   * `integratedAt` 晚于 `restoredAt`（或没有 `restoredAt`）= 处于接入态。
   */
  integratedAt?: string;
}

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
  // 同一秒内两次接入会落进同一目录：清单里的 files 做去重（按原路径），保留最早的快照
  if (existsSync(join(dir, BACKUP_MANIFEST))) return dir;
  writeJsonSecret(join(dir, BACKUP_MANIFEST), {
    version: 1,
    target,
    createdAt: new Date().toISOString(),
    files: [],
  } satisfies BackupManifest);
  return dir;
}

/**
 * 记一条接入警告（同文去重）。
 *
 * 一次接入会按文件逐个登记，同一原因（清单读不出）会连着凑成好几条一模一样的 ——
 * 界面逐条弹 toast，去重前会刷屏。
 */
function warn(sink: string[] | undefined, message: string): void {
  if (sink === undefined || sink.includes(message)) return;
  sink.push(message);
}

/**
 * 读某次备份的清单（没有 manifest 的老备份返回 null，调用方走反推）。
 *
 * `warnings` 非空时，清单**存在却读不出**（解析失败 / `files` 不是数组）会记一条：
 * 调用方会退化成按文件名反推，还原可能不完整，用户必须知道原因。没有 manifest
 * 文件的老备份是正常路径，不记。
 */
function readManifest(dir: string, warnings?: string[]): BackupManifest | null {
  const file = join(dir, BACKUP_MANIFEST);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    warn(warnings, `备份清单读取失败（${basename(dir)}）：${String(err)}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(warnings, `备份清单解析失败（${basename(dir)}）：${String(err)}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as BackupManifest).files)) {
    warn(warnings, `备份清单结构无效（${basename(dir)} 的 files 不是数组）`);
    return null;
  }
  return parsed as BackupManifest;
}

/** 把一条记录追加进清单（同原路径只记一次 —— 多次接入同一个文件时保留最早的原始快照）。 */
function appendManifestEntry(dir: string, entry: BackupEntry, warnings?: string[]): void {
  // 局部收原因再合成一条：readManifest 自己也会记一条，直接透传会一次失败刷出两三条
  const why: string[] = [];
  const manifest = readManifest(dir, why);
  if (manifest === null) {
    // 清单存在却读不出：这条登记不上，还原会缺它 —— 如实报出来（带上读不出的原因）
    if (existsSync(join(dir, BACKUP_MANIFEST))) {
      warn(warnings, `本次备份未登记：${why.join("；") || "备份清单不可读"}`);
    }
    return;
  }
  if (manifest.files.some((f) => f.original === entry.original)) return;
  manifest.files.push(entry);
  try {
    writeJsonSecret(join(dir, BACKUP_MANIFEST), manifest);
  } catch (err) {
    warn(warnings, `备份清单写入失败，本次备份未登记：${String(err)}`);
  }
}

/**
 * 原样备份一个待改文件（0600 —— 备份源可能是凭据文件）。返回备份路径。
 *
 * **备份文件名带原目录的短哈希**：dsh 的多个 profile 补丁同名（都叫
 * `cordis.patch.yml`，分在不同 profile 目录下），只用 basename 会互相覆盖 ——
 * 而清单里记了多条不同原路径，还原时除第一条外全都 ENOENT
 * （2026-11-07 实测：`profiles/web/cordis.patch.yml` 与 `profiles/desktop/...` 撞名）。
 *
 * **命中清单即跳过写入**：同一秒内两次接入会复用同一个备份目录（目录名按秒分桶），
 * 第二次若照写就会把同名备份覆盖成「第一次接入之后」的内容 —— 还原拿到的是中间态，
 * 而真正的「接入前」已经无处可取。文件名与调用次数无关，所以只能靠清单判断。
 *
 * 顺序是**先写盘再登记**：反过来会在写盘失败时留下指向不存在备份的记录。
 */
function backupFile(dir: string, file: string, warnings?: string[]): string {
  const base = file.split(/[\\/]/).pop() ?? "config";
  const dirHash = createHash("sha256").update(file).digest("hex").slice(0, 8);
  const name = `${base}.${dirHash}`;
  const dest = join(dir, name);
  // 这里只做判重，读不出也不记 notes —— 真正要报的「未登记」由 appendManifestEntry 说
  const manifest = readManifest(dir);
  // 已有该原路径的备份：保留最早那份，不覆盖
  if (manifest?.files.some((f) => f.original === file) === true && existsSync(dest)) {
    return dest;
  }
  // 清单读不出但备份已在：无法确认它是不是「最早那份」，覆盖可能毁掉唯一的接入前快照
  if (manifest === null && existsSync(join(dir, BACKUP_MANIFEST)) && existsSync(dest)) {
    warn(warnings, `备份清单不可读，保留已有备份不覆盖：${name}`);
    return dest;
  }
  mkdirSync(dir, { recursive: true });
  writeAtomicFile(dest, readFileSync(file, "utf8"), 0o600);
  appendManifestEntry(dir, { original: file, backup: name, existed: true }, warnings);
  return dest;
}

/**
 * 登记一个「接入将新建」的文件（原本不存在）。
 *
 * 不写备份内容（没内容可备），只记 `existed: false` —— 还原时据此删除。
 * 必须在**写入新文件之前**调用，否则无法区分「原本就没有」与「备份时正好不存在」。
 */
function noteCreatedFile(dir: string, file: string, warnings?: string[]): void {
  appendManifestEntry(
    dir,
    {
      original: file,
      backup: "",
      existed: false,
    },
    warnings,
  );
}

/**
 * 写入并**确认真的落地**，没落地就抛。
 *
 * `writeAtomicFile` 在 rename 失败时会宽松处理（公共底座要照顾多进程并发写，
 * 那里「目标已有内容」就当幂等成功）。但接入改写的是**用户配置**：写没写进去
 * 必须确定 —— 否则会报「已接入」而实际文件未变（Windows 上目标被其它句柄占着
 * 时正是这样，rename 报 EPERM 而旧文件非空）。
 *
 * 所以接入路径在这里多一道读回校验：内容不符就抛错，让上层把该文件从
 * `changed` 里剔除、并如实报失败。
 *
 * `accepts` 用于「内容等价的其它写法也算成功」：并发写者可能刚把目标换成另一份
 * 等价内容（如模型目录 —— 同一模型集可能由另一次接入写出）。没有它只能逐字节
 * 比对，会把别人的等价写入误报成自己的写入失败。
 */
function writeVerified(
  file: string,
  body: string,
  mode = 0o600,
  accepts?: (actual: string) => boolean,
): void {
  writeAtomicFile(file, body, mode);
  const actual = readFileSync(file, "utf8");
  if (actual === body || (accepts !== undefined && accepts(actual))) return;
  throw new Error(`写入未生效：${file}（目标可能被其它进程占用，请关闭后重试）`);
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
  const result: IntegrationResult = {
    ok: false,
    target: "zcode",
    models,
    changed: [],
    unchanged: [],
    notes: [],
    warnings: [],
  };
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
  // 供应商必须进 `providerOrder` 才会在 zcode 里出现：规则写得再全，不在这个列表里
  // 就是「Provider Registry 中查不到」，客户端根本选不到它（2026-11-08 实测）。
  const order = (config["providerOrder"] ??= []) as unknown[];
  if (!order.includes(ZCODE_PROVIDER_ID)) {
    order.push(ZCODE_PROVIDER_ID);
    result.notes.push(`把 modelmux 加进 providerOrder（位置 ${order.length}）`);
  }
  const ruleConfig = (rule["config"] ??= {}) as Record<string, unknown>;
  const before = JSON.stringify(ruleConfig);
  const baseUrl = gatewayBaseUrl();
  ruleConfig["api"] = { type: "openai-chat-completions", baseUrl };
  ruleConfig["personalModelIds"] = [...models];
  ruleConfig["modelOrder"] = [...models];
  // zcode 对个人供应商规则做完整校验（group / access / api 缺一不可），缺任一项就整个
  // 供应商不进注册表 —— 模型清单写得再对，setModel 也报「Provider Registry 中不存在 Model」。
  ruleConfig["group"] = "standard-personal";
  if (!hasUsableAccessKey(ruleConfig["access"])) {
    ruleConfig["access"] = { type: "api-key", apiKey: LOCAL_API_KEY };
  }
  if (JSON.stringify(ruleConfig) !== before) {
    result.notes.push(`供应商 ${ZCODE_PROVIDER_NAME}：baseUrl=${baseUrl}，模型=${models.join(" / ")}`);
  }

  // 逐模型的启用开关：补齐新模型、清掉该供应商下已下线的旧模型；
  // 并按模型清单的输入模态声明 `properties.inputFormat.supportsImage` —— 不声明的话
  // 客户端在本地就把图片拦下，网关再能转也没用（schema 见 zcode 客户端的既有条目）。
  const modalities = modelModalities(models);
  const modelRules = ((config["modelConfigRules"] ??= {}) as Record<string, unknown>);
  const providerModelRules = (modelRules["providerModelRules"] ??= []) as Array<Record<string, unknown>>;
  const wanted = new Set(models);
  const kept = providerModelRules.filter(
    (r) => !(r["providerId"] === ZCODE_PROVIDER_ID && !wanted.has(String(r["modelId"]))),
  );
  for (const model of models) {
    const supportsImage = (modalities.get(model) ?? ["text"]).includes("image");
    const hit = kept.find((r) => r["providerId"] === ZCODE_PROVIDER_ID && r["modelId"] === model);
    if (hit) {
      const c = (hit["config"] ??= {}) as Record<string, unknown>;
      c["enabled"] = true;
      const props = (c["properties"] ??= {}) as Record<string, unknown>;
      const inputFormat = (props["inputFormat"] ??= {}) as Record<string, unknown>;
      inputFormat["supportsImage"] = supportsImage;
    } else {
      kept.push({
        modelId: model,
        providerId: ZCODE_PROVIDER_ID,
        config: { enabled: true, properties: { inputFormat: { supportsImage } } },
      });
      result.notes.push(`新增模型启用项 ${model}${supportsImage ? "（含图片输入）" : ""}`);
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
  try {
    backupFile(dir, file, result.warnings);
    // 原子写：这是用户的 zcode 主配置，写中断会留下半截 JSON（有备份可救，
    // 但「能不吃备份就别吃」）
    writeVerified(file, text, 0o600);
  } catch (err) {
    result.error = `写 zcode 配置失败：${String(err)}（备份目录 ${dir}）`;
    return result;
  }
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

/** 模型 → 输入模态（`["text"]` / `["text","image"]`）；缺省按纯文本处理。 */
type ModalityMap = Map<string, readonly string[]>;

/**
 * 渲染一个 dsh 模型条目（缩进 = `indent`）。
 *
 * `input` 必须是模型的**真实**模态：早先固定写 `[text]`，支持图片的模型接进 dsh
 * 后发图会被它自己拦下（模型清单声明「只收文本」），而网关其实转得过去 ——
 * 这是「一键接入后图片功能消失」的直接原因。
 */
function renderDshModel(indent: number, model: string, inputModalities: readonly string[]): string[] {
  const pad = " ".repeat(indent);
  return [
    `${pad}- id: ${model}`,
    `${pad}  name: ${model}`,
    `${pad}  input:`,
    ...inputModalities.map((m) => `${pad}    - ${m}`),
  ];
}

/** 渲染完整的 `llm-pi-ai` patch 条目（顶层，缩进 0）。 */
function renderDshProviderEntry(models: string[], modalities: ModalityMap): string[] {
  const lines = [
    `- id: ${DSH_PLUGIN_ID}`,
    `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
    `  config:`,
    `    providers:`,
    `      ${DSH_PROVIDER}:`,
    `        displayName: ${DSH_PROVIDER}`,
    `        apiKeyEnv: ${DSH_CREDENTIAL_REF}`,
    `        api: openai-completions`,
    `        baseURL: ${gatewayBaseUrl()}`,
    `        models:`,
  ];
  for (const model of models) lines.push(...renderDshModel(10, model, modalities.get(model) ?? ["text"]));
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
function ensureDshCredential(warnings: string[]): { file: string; changed: boolean; notes: string[]; backupDir?: string } {
  const notes: string[] = [];
  const file = join(homedir(), ".dsh", ".credentials.yaml");
  const entry = `${DSH_CREDENTIAL_REF}: ${LOCAL_API_KEY}`;

  if (!existsSync(file)) {
    const dir = backupDirFor("dsh");
    try {
      // 必须登记「这个文件是本次接入新建的」：否则还原时不知道该删它，
      // 凭据文件会永久留在 ~/.dsh 下，而用户从没拥有过它。
      noteCreatedFile(dir, file, warnings);
      writeVerified(file, `version: 1\nrefs: { ${entry} }\n`, 0o600);
    } catch (err) {
      warnings.push(`新建凭据文件失败：${String(err)}（备份目录 ${dir}）`);
      return { file, changed: false, notes, backupDir: dir };
    }
    notes.push(`新建凭据文件并写入 ${DSH_CREDENTIAL_REF}`);
    return { file, changed: true, notes, backupDir: dir };
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
        warnings.push("refs 块形态无法安全解析，已跳过写入");
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
  try {
    backupFile(dir, file, warnings);
    writeVerified(file, text, 0o600);
  } catch (err) {
    warnings.push(`凭据文件写入失败：${String(err)}（备份目录 ${dir}）`);
    return { file, changed: false, notes, backupDir: dir };
  }
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
  const result: IntegrationResult = {
    ok: false,
    target: "dsh",
    models,
    changed: [],
    unchanged: [],
    notes: [],
    warnings: [],
  };
  const profilesDir = join(homedir(), ".dsh", "profiles");
  if (!existsSync(profilesDir)) {
    result.error = `找不到 dsh profiles 目录：${profilesDir}（dsh 装了吗？）`;
    return result;
  }
  let dir: string | undefined;

  // 凭据引用与补丁分开落：补丁写模型清单，凭据文件写 `apiKeyEnv` 指向的名字。
  const cred = ensureDshCredential(result.warnings);
  result.notes.push(...cred.notes);
  dir = cred.backupDir;
  if (cred.changed) result.changed.push(cred.file);
  else result.unchanged.push(cred.file);

  // 「有没有接入成功」只看 profile 本身：凭据引用被新建不能把「一个 profile 都没改」
  // 说成已接入 —— 那比报错更具误导性（界面 toast「已接入」，实际什么都没接）。
  let profileSeen = 0;
  let profileChanged = 0;
  const modalities = modelModalities(models);
  for (const profile of DSH_PROFILES) {
    const file = join(profilesDir, profile, "cordis.patch.yml");
    if (!existsSync(file)) continue;
    profileSeen += 1;
    const original = readFileSync(file, "utf8");
    const next = upsertDshPatch(original, profile, models, modalities);
    if (next === original) {
      result.unchanged.push(file);
      continue;
    }
    dir ??= backupDirFor("dsh");
    try {
      backupFile(dir, file, result.warnings);
      // 原子写：dsh profile patch 是 dsh 唯一的模型清单来源，写坏会让它起不来
      writeVerified(file, next, 0o600);
    } catch (err) {
      // 单条失败不中断其余 profile（与还原同取舍）
      result.warnings.push(`${profile}：写入失败，已跳过 —— ${String(err)}`);
      continue;
    }
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
function upsertDshPatch(text: string, profile: string, models: string[], modalities: ModalityMap): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  const providerIdx = lines.findIndex((l) => /^(\s*)modelmux:\s*$/.test(l));
  let out: string[];

  if (providerIdx < 0) {
    // 没有 modelmux provider：**追加**一个新条目，其余行（其它插件条目、它们的注释）
    // 一律原样保留。
    // 不能整份替换 —— patch 里可能有 `ui-chat` / `permission` / `subagent-*` 等其它条目，
    // 整份替换会把它们全删掉（2026-11-08 实测：`- id: other-plugin` 整块消失），
    // 而界面还会报「已接入」。
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    const body = [...renderDshProviderEntry(models, modalities)];
    if (profile === "acp") body.push(...renderDshAcpEntry(models[0]!));
    // 原有内容与追加条目之间留一个空行（YAML 顶层序列彼此紧邻也能解析，留空只为可读）
    out = lines.length > 0 ? [...lines, "", ...body] : body;
  } else {
    out = replaceDshModels(lines, providerIdx, models, modalities);
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
function replaceDshModels(lines: string[], providerIdx: number, models: string[], modalities: ModalityMap): string[] {
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
    next.splice(at, 0, `${" ".repeat(childIndent)}models:`, ...renderDshModelItems(childIndent + 2, models, modalities));
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
  next.splice(modelsLine + 1, last - (modelsLine + 1), ...renderDshModelItems(itemIndent, models, modalities));
  return next;
}

/** 渲染 models 列表项（`- id: …` 形式）。 */
function renderDshModelItems(indent: number, models: string[], modalities: ModalityMap): string[] {
  const out: string[] = [];
  for (const model of models) out.push(...renderDshModel(indent, model, modalities.get(model) ?? ["text"]));
  return out;
}

// ── claude desktop ──────────────────────────────────────────────────────────

/**
 * Claude Desktop 的 3P（third-party）profile 路径。
 *
 * Desktop 读自己的 3P profile（`<LOCALAPPDATA>/Claude-3p/configLibrary/`，macOS 在
 * `~/Library/Application Support/Claude-3p/`），**不是** `~/.claude/settings.json`。
 * 写错位置的后果是 Desktop 照常启动、但完全不读我们写的配置 —— 静默无效，没有任何报错。
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
 * 把池模型写成 Desktop 的 `inferenceModels`（角色名 → 池模型的固定映射）。
 *
 * `name` 必须写成**真实存在的 Anthropic 模型名**：Desktop 的校验器（`app.asar` 里
 * `jo()` → `ko = /^[A-Za-z0-9_-]{1,64}$/` 再叠加「须为已知 Anthropic 模型」）会拒掉
 * 自造名 —— 连斜杠与点号都不允许，`anthropic/claude-sonnet-deepseek-v4.1-flash` 实测会被丢弃
 * （日志：`is not an Anthropic model`），结果是模型选择器为空。
 *
 * 槽位与映射表都由 `model-family.ts` 的 `DESKTOP_ROLE_MODELS` 决定（接入与解析同源）：
 * Desktop 直连只会发角色名，`labelOverride` 仅改菜单显示名、不进请求体，所以
 * 「选了什么模型」全靠网关侧的这张表还原。
 *
 * 只写**本次接入的对外模型里真有的**那些槽：池里没有的模型写进 profile 只会让
 * 用户选到一个必然 400 的条目。`supports1m` + `prefer1m` 必须成对出现 ——
 * 前者给出 1M 变体，后者让选择器只列 1M 那一项，少了 UI 会退回 200k。
 */
function desktopInferenceModels(models: readonly string[]): Array<Record<string, unknown>> {
  const wanted = new Set(models);
  return DESKTOP_ROLE_MODELS.filter(([, model]) => wanted.has(model)).map(([roleId, model]) => ({
    name: roleId,
    labelOverride: model,
    supports1m: true,
    prefer1m: true,
  }));
}

/**
 * Claude Desktop：写 3P profile（`configLibrary/modelmux.json` + `_meta.json`）。
 *
 * 走 **`inferenceProvider: "gateway"`**，模型清单写进 `inferenceModels`（**不**用模型发现，
 * 原因见 `desktopInferenceModels` 与 `modelDiscoveryEnabled` 处的注释）。
 *
 * 认证用 `x-api-key`（本地回环网关不校验入站密钥，只要求头存在）。
 */
function integrateClaudeDesktop(models: string[]): IntegrationResult {
  const result: IntegrationResult = {
    ok: false,
    target: "claude-desktop",
    models,
    changed: [],
    unchanged: [],
    notes: [],
    warnings: [],
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

  // profile 文件损坏要**如实报错**（与 _meta.json 同口径）：profileId 来自
  // `_meta.json` 的 `appliedId`，可能指向 Desktop / cc-switch 生成的其它 profile，
  // 那个文件不一定是本工具写的。这里裸 `JSON.parse` 会让异常穿透到控制台的
  // `.catch`，用户看到的是「命令失败」而不是「这个文件不是合法 JSON」。
  let profile: Record<string, unknown> = {};
  if (existsSync(profileFile)) {
    try {
      profile = JSON.parse(readFileSync(profileFile, "utf8")) as Record<string, unknown>;
    } catch (err) {
      result.error = `Claude Desktop 的 ${profileId}.json 不是合法 JSON：${String(err)}`;
      return result;
    }
  }
  const before = JSON.stringify(profile);
  const anthropicUrl = gatewayAnthropicUrl();
  profile["inferenceProvider"] = "gateway";
  profile["inferenceGatewayBaseUrl"] = anthropicUrl;
  profile["inferenceGatewayAuthScheme"] = "x-api-key";
  profile["inferenceGatewayApiKey"] = LOCAL_API_KEY;
  // **必须关**模型发现：它直接拿 `/v1/models` 的裸名（`qwen3.8-flash` / `deepseek-v4.1-flash`）
  // 当候选，而 Desktop 的校验器不接受点号 —— 实测 3 个模型全被判「不可用」
  // （日志：`Gateway /v1/models returned 0 usable models { rawCount: 3 }`，选择器为空）。
  // 显式 `inferenceModels` 里的角色名才是可走的路（映射见 `desktopInferenceModels`）。
  profile["modelDiscoveryEnabled"] = false;
  // 按 `DESKTOP_ROLE_MODELS` 写池里真有的角色槽 —— 模型发现已关，profile 是唯一来源
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
  try {
    // 两个文件都可能是新建（Desktop 没装过 3P profile）：新建的记 `existed:false`，
    // 还原时删掉，别把接入产物留在用户目录里
    if (existsSync(profileFile)) backupFile(backup, profileFile, result.warnings);
    else noteCreatedFile(backup, profileFile, result.warnings);
    if (existsSync(metaFile)) backupFile(backup, metaFile, result.warnings);
    else noteCreatedFile(backup, metaFile, result.warnings);
    writeVerified(profileFile, profileAfter, 0o600);
    writeVerified(metaFile, metaAfter, 0o600);
  } catch (err) {
    result.error = `写 Claude Desktop 配置失败：${String(err)}（备份目录 ${backup}）`;
    return result;
  }
  result.changed.push(profileFile, metaFile);
  result.backupDir = backup;
  result.notes.push(
    `baseUrl=${anthropicUrl}，角色映射 ${desktopInferenceModels(models).length} 项（全部 1M 上下文）`,
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
    `base_url = "${gatewayBaseUrl()}"`,
    `wire_api = "responses"`,
    `experimental_bearer_token = "${LOCAL_API_KEY}"`,
    `requires_openai_auth = false`,
  ];
}

/** Codex 的模型目录文件放在网关自己的存储根下（不碰用户的 ~/.codex 里的其它文件）。 */
function codexCatalogPath(): string {
  return join(rootDir(), "codex-model-catalog.json");
}

/**
 * catalog 条目的 schema 必填字段（Codex 0.163；缺任一项整份文件解析失败）。
 *
 * 与 `renderCodexCatalog` 输出、以及「等价目录」判定共用一份：只比 id 集会放过
 * 缺字段的目录，那次接入会报成功而 Codex 起不来。
 */
const CODEX_CATALOG_REQUIRED_KEYS = [
  "slug",
  "display_name",
  "base_instructions",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "support_verbosity",
  "truncation_policy",
  "experimental_supported_tools",
] as const;

/** 渲染 Codex 模型目录的 JSON 文本（纯函数，供写入前比对与复用）。 */
function renderCodexCatalog(models: string[]): string {
  const doc = {
    models: models.map((id) => ({
      id,
      slug: id,
      model: id,
      display_name: id,
      description: "modelmux 网关模型（渠道由网关按剩余额度自动挑）",
      base_instructions: CODEX_BASE_INSTRUCTIONS,
      apply_patch_tool_type: "freeform",
      supported_in_api: true,
      supported_reasoning_levels: CODEX_REASONING_PRESETS,
      default_reasoning_level: "medium",
      shell_type: "shell_command",
      visibility: "list",
      priority: 0,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10_000 },
      experimental_supported_tools: [],
      context_window: 1_048_576,
      max_context_window: 1_048_576,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * 写一份**只含对外模型**的 Codex 模型目录，并返回其绝对路径。
 *
 * 为什么必须写：Codex 的 `model_catalog_json` 指向的目录里若没有配置里那个
 * `model`，它启动时会直接报「系统找不到指定的文件」并拒绝运行 —— 接入只改
 * config.toml、不写目录，等于让 Codex 起不来（或指向一份不含对外模型名的旧目录，
 * 接入静默失效）。
 *
 * 为什么只写对外模型：Codex 的模型选择器会把这个目录整个列出来，把 100+ 个内部
 * 池 id 塞进去没人看得懂。对外只有家族表那几个裸名。
 *
 * 字段按 Codex 的 schema 给**实测最小必填集**（Codex 0.163 逐轮探测得出）：
 * `slug` / `display_name` / `base_instructions` / `supported_reasoning_levels` /
 * `shell_type` / `visibility` / `supported_in_api` / `priority` / `support_verbosity` /
 * `truncation_policy` / `experimental_supported_tools`，缺任一项整份文件解析失败
 * （报 `missing field \`xxx\``）。
 *
 * 三处字段形状必须严格照 schema：`supported_reasoning_levels` 的元素是
 * `{effort, description}` 对象而非裸字符串（实测报
 * `invalid type: string "low", expected struct ReasoningEffortPreset`）；`visibility`
 * 的枚举只有 `list` / `hide`（写 `public` 同样解析失败）；`truncation_policy` 是
 * `{mode, limit}` 对象。
 *
 * 刻意**不**继承内置目录的实验工具（`experimental_supported_tools` 置空）：那些是
 * Codex 自家模型的内部工具，第三方模型声明了只会让 Codex 发它不认识的工具调用。
 *
 * `support_verbosity` 必须为 `false`：网关的 Responses 适配器只转发
 * `reasoning.effort`，不转发 `text.verbosity`。声明 `true` 会让 Codex 在用户配置
 * `model_verbosity` 时发送该字段，随后被网关静默丢弃。
 */
function writeCodexCatalog(models: string[]): string {
  const path = codexCatalogPath();
  mkdirSync(dirname(path), { recursive: true });
  const expected = new Set(models);
  writeVerified(path, renderCodexCatalog(models), 0o600, (actual) => {
    try {
      const doc = JSON.parse(actual) as { models?: Array<Record<string, unknown>> };
      if (!Array.isArray(doc.models) || doc.models.length !== expected.size) return false;
      // 只对 id 集不算等价：缺必填字段的目录 Codex 整份拒绝，认它等于把失败报成成功
      return doc.models.every(
        (m) =>
          CODEX_CATALOG_REQUIRED_KEYS.every((k) => k in m) &&
          typeof m["id"] === "string" &&
          expected.has(m["id"]),
      );
    } catch {
      // 解析不了 = 不能当作我们的目录用；具体原因由 writeVerified 的失败信息统一报出
      return false;
    }
  });
  return path;
}

/**
 * Codex 模型目录里的推理档位（`ReasoningEffortPreset`）。
 *
 * 只给 `low` / `medium` / `high` 三档：网关各渠道的真实档位未在 `/v1/models`
 * 里声明（`effort` 均为 null），多给的档位只会变成选了也没效果的空选项。
 */
const CODEX_REASONING_PRESETS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
];

/**
 * Codex 的 base instructions（`base_instructions` 是 catalog 每条目的必填项）。
 *
 * 与 Codex CLI 内置提示同源，接入只负责让它存在；真正的会话级 instructions
 * 仍由 Codex 每次请求自带。
 */
const CODEX_BASE_INSTRUCTIONS = [
  "You are Codex, a coding agent working with the user in a shared workspace.",
  "",
  "Keep the user informed while completing their task. Before the first tool call, send a brief",
  "user-facing message explaining what you will check or change and why.",
  "",
  "Inspect the relevant code and workspace instructions before editing. Preserve unrelated user",
  "changes, make focused fixes, and run checks appropriate to the change.",
].join("\n");

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
  const result: IntegrationResult = {
    ok: false,
    target: "codex",
    models,
    changed: [],
    unchanged: [],
    notes: [],
    warnings: [],
  };
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
  // `model_catalog_json` 一并重写：它指向的目录必须含下面这个 `model`，
  // 否则 Codex 启动即报「系统找不到指定的文件」（目录不存在或里面没有该模型名）。
  const head = next
    .slice(0, headEnd)
    .filter((l) => !/^\s*(model_provider|model|model_catalog_json)\s*=/.test(l));
  const tail = firstTable < 0 ? [] : next.slice(firstTable);
  // TOML 字面量字符串（单引号）不处理转义，Windows 路径原样写入即可；
  // 只有双引号基本字符串才需要把反斜杠转成 `\\`
  const catalogPath = codexCatalogPath();
  const catalogLiteral = `'${catalogPath}'`;
  const topKeys = [
    `model_provider = "modelmux"`,
    `model = "${models[0]!}"`,
    `model_catalog_json = ${catalogLiteral}`,
  ];
  const withKeys = [...head, ...topKeys, ...tail];

  const text = `${withKeys.join(eol).replace(/\s+$/, "")}${eol}`;
  const catalogBody = renderCodexCatalog(models);
  // 留一份接入前的目录内容：配置写失败时要靠它回滚（见下面的 catch）
  let catalogOriginal: string | undefined;
  try {
    catalogOriginal = readFileSync(catalogPath, "utf8");
  } catch {
    catalogOriginal = undefined; // 不存在或读不出 → 需要写
  }
  const catalogChanged = catalogOriginal !== catalogBody;
  const fileChanged = text !== original;
  if (!fileChanged && !catalogChanged) {
    result.unchanged.push(file, catalogPath);
    result.ok = true;
    return result;
  }
  // 配置与目录都是接入产物：接入前存在则备份，不存在则登记为「接入新建」（还原时删）
  const backup = backupDirFor("codex");
  // 先记账：随后的任何失败返回都要能让用户找到这份备份
  result.backupDir = backup;
  try {
    if (existsSync(catalogPath)) backupFile(backup, catalogPath, result.warnings);
    else noteCreatedFile(backup, catalogPath, result.warnings);
    if (existsSync(file)) backupFile(backup, file, result.warnings);
    else noteCreatedFile(backup, file, result.warnings);
  } catch (err) {
    result.error = `备份 Codex 接入前的文件失败：${String(err)}（备份目录 ${backup}）`;
    return result;
  }
  // 先写目录再写配置：目录写失败时 config.toml 未被改写，不会出现「配置指向一份
  // 不存在/不完整的目录」的中间态（那会让 Codex 直接起不来）
  if (catalogChanged) {
    try {
      writeCodexCatalog(models);
    } catch (err) {
      result.error = `写 Codex 模型目录失败：${String(err)}（config.toml 尚未改写，备份在 ${backup}）`;
      return result;
    }
    result.changed.push(catalogPath);
  } else {
    result.unchanged.push(catalogPath);
  }
  if (fileChanged) {
    try {
      writeVerified(file, text, 0o600);
    } catch (err) {
      // 目录已按新模型集改写、配置还是旧的：旧模型可能不在新目录里，Codex 会起不来。
      // 把目录回滚到接入前，宁可这次接入整体失败。
      let rollback = "目录未改动";
      if (catalogChanged) {
        try {
          if (catalogOriginal === undefined) rmSync(catalogPath, { force: true });
          else writeVerified(catalogPath, catalogOriginal, 0o600);
          const at = result.changed.indexOf(catalogPath);
          if (at >= 0) result.changed.splice(at, 1);
          rollback = "目录已回滚";
        } catch (e) {
          rollback = `目录回滚也失败：${String(e)}`;
        }
      }
      result.error = `写 Codex 配置失败：${String(err)}（${rollback}；备份在 ${backup}）`;
      return result;
    }
    result.changed.push(file);
  } else {
    result.unchanged.push(file);
  }
  result.notes.push(`base_url=${gatewayBaseUrl()}（wire_api=responses），模型=${models[0]}`);
  result.ok = true;
  return result;
}

// ── 一键还原 ────────────────────────────────────────────────────────────────

export interface RestoreResult {
  ok: boolean;
  target: IntegrationTarget;
  /** 被还原回原内容的文件。 */
  restored: string[];
  /** 因为接入时本来不存在、还原时被删掉的文件。 */
  removed: string[];
  /** 本次还原使用的备份目录（**可重复使用** —— 还原不消费备份）。 */
  sourceDir?: string;
  /** 还原前对「当前状态」做的保护性备份目录（可用来反悔）。 */
  safetyDir?: string;
  error?: string;
  notes: string[];
}

/** 从目录名末尾取 14 位时间戳（`target-20261107120000`）；取不到返回 0。 */
function stampOf(dir: string): number {
  const name = dir.split(/[\\/]/).pop() ?? "";
  const m = /(\d{14})$/.exec(name);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

/**
 * 清单条目的字段校验：缺原路径 / 缺 existed / existed 为真却没有备份名 → 一律跳过。
 *
 * 清单是**磁盘数据**（用户可手改、老版本写的、被截断的），还原又是破坏性动作 ——
 * 字段不全时猜一条路径写回去，比跳过更危险。路径还要求是**绝对路径**：
 * 相对路径会被按当前工作目录解析，写到哪里全凭运气。
 *
 * `backup` 必须是**裸文件名**（不含任何分隔符，也不许 `.` / `..`）：它会被
 * `join(source, backup)` 后直接读取，再写到 `original` 指向的绝对路径。放行相对段
 * 等于让一条被改过的清单把任意文件读出来、写到任意位置（2026-11-08 实测：
 * `backup: "../../../../outside-secret.txt"` 会读到 MODELMUX_HOME 之外的内容）。
 */
function isValidEntry(entry: unknown): entry is BackupEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const rec = entry as Record<string, unknown>;
  if (typeof rec["original"] !== "string" || !isAbsolute(rec["original"])) return false;
  if (typeof rec["existed"] !== "boolean") return false;
  if (rec["existed"]) {
    const backup = rec["backup"];
    if (typeof backup !== "string") return false;
    // 裸文件名：不许带分隔符，也不许是路径跳转段
    if (backup.trim() === "" || backup === "." || backup === "..") return false;
    if (backup.includes("/") || backup.includes("\\")) return false;
  }
  return true;
}

/**
 * 读某次备份的**可还原条目**；没有可还原内容时返回 `null`（调用方据此跳过该目录）。
 *
 * 有清单用清单（逐条校验，坏条目如实记 notes）；老备份（无清单）按文件名反推原路径。
 */
function entriesOfBackup(
  target: IntegrationTarget,
  dir: string,
  notes: string[],
): BackupEntry[] | null {
  const manifest = readManifest(dir, notes);
  if (manifest !== null) {
    // 清单记的 target 与请求不符 → 整个目录不是这个 target 的备份，跳过
    // （目录名可能被手工改过；放过去会把别家客户端的配置写到本机来）
    if (manifest.target !== undefined && manifest.target !== target) {
      notes.push(`跳过备份目录 ${basename(dir)}：清单 target 是 ${String(manifest.target)}，与请求的 ${target} 不符`);
      return null;
    }
    const valid = manifest.files.filter(isValidEntry);
    for (const entry of manifest.files) {
      if (!isValidEntry(entry)) notes.push(`跳过清单里字段不全的条目：${JSON.stringify(entry)}`);
    }
    return valid.length > 0 ? valid : null;
  }
  const inferred: BackupEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name === BACKUP_MANIFEST) continue;
    const original = inferOriginalPath(target, e.name);
    if (original === null) {
      notes.push(`跳过 ${e.name}：老备份没有清单，无法确定原路径`);
      continue;
    }
    inferred.push({ original, backup: e.name, existed: true });
  }
  return inferred.length > 0 ? inferred : null;
}

/** 某次备份的可还原条目，以及 discovery 阶段为该目录产生的 notes。 */
interface BackupSource {
  dir: string;
  entries: BackupEntry[];
  notes: string[];
}

/** 备份扫描结果：可用源（新→旧）+ 被跳过的候选目录及原因。 */
interface BackupScan {
  sources: BackupSource[];
  skipped: string[];
}

/**
 * 扫出某 target 的全部**可用**备份目录，按时间**新的在前**，并一并算出可还原条目。
 *
 * 目录名形如 `<target>-<yyyymmddhhmmss>`；两类目录仍可用作还原源：
 * - `<target>-*`：接入时留的备份；
 * - `restored-<target>-*`：**旧版本**消费过的备份 —— 它装的一样是「接入前」状态，
 *   （新版改成可重复还原后）仍能再还原，只是时间戳更老。
 *
 * 唯一排除的是 `safety-<target>-*`：还原时给「当前状态」留的保护性快照 ——
 * 它装着接**后**的状态，拿去当还原源会把配置又改回接入后的样子（自噬）。
 *
 * 排序按目录名末尾的 14 位时间戳而不是整个文件名的字典序：后者会让
 * `restored-<target>-*` 恒排在 `<target>-*` 之前（`r` 大于多数 target 的首字母）。
 *
 * 清单为空 / 读不出任何条目的目录直接跳过 —— 否则一次「只建了目录没写文件」的
 * 接入会挡住更早的真实备份。跳过的原因收进 `skipped`：一个可用源都没有时，
 * 还原要能说清「找到了备份目录但不可用」，而不是报「没有备份」。
 *
 * 条目在 discovery 阶段算好、还原直接复用（省掉对选中目录的重复计算）；选中目录的
 * notes 跟它走 —— 其余目录的问题与本次还原无关，不进用户视野。
 */
function backupScanOf(target: IntegrationTarget): BackupScan {
  backupRoot ??= join(rootDir(), "backups", "integrate");
  if (!existsSync(backupRoot)) return { sources: [], skipped: [] };
  const prefix = `${target}-`;
  const sources: BackupSource[] = [];
  const skipped: string[] = [];
  for (const e of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(`safety-${target}-`)) continue;
    if (!e.name.startsWith(prefix) && !e.name.startsWith(`restored-${prefix}`)) continue;
    const dir = join(backupRoot!, e.name);
    const notes: string[] = [];
    const entries = entriesOfBackup(target, dir, notes);
    if (entries !== null) sources.push({ dir, entries, notes });
    // 没有条目也要留原因：空清单目录（一次失败的接入只建了目录）若静默消失，
    // 还原就会报「没有备份」——而「接入过、备份目录也在」是事实
    else skipped.push(`${e.name}：${notes.length > 0 ? notes.join("；") : "清单为空或没有可还原条目"}`);
  }
  sources.sort((a, b) => stampOf(b.dir) - stampOf(a.dir));
  return { sources, skipped };
}

/** 还原前的保护性快照目录（`safety-` 前缀，不参与自动挑选）。 */
function safetyDirFor(target: IntegrationTarget): string {
  backupRoot ??= join(rootDir(), "backups", "integrate");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(backupRoot, `safety-${target}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, BACKUP_MANIFEST))) {
    writeJsonSecret(join(dir, BACKUP_MANIFEST), {
      version: 1,
      target,
      createdAt: new Date().toISOString(),
      files: [],
    } satisfies BackupManifest);
  }
  return dir;
}

/**
 * 老备份（无 manifest）的原路径反推。
 *
 * 只对**路径能被文件名唯一确定**的文件可行。反推不出来就返回 `null`（调用方跳过并记
 * notes）—— 不猜路径，写错文件比不还原更糟。
 *
 * 走这条路的都是没有清单的老备份，所以每个分支只能接受**已知的精确文件名**：
 * 曾经把 dsh 的所有非 `config.yaml` 一律映射到 `~/.dsh/credentials/<name>`，
 * 而那个目录根本不存在 —— 结果是整份老备份回 `ENOENT`（2026-11-08 实测），
 * 或者在该目录恰好存在时把文件写到错位置、假装还原成功。
 *
 * 备份名可能带 `.xxxxxxxx` 哈希后缀（同名不同目录的去重手段），反推前先剥掉。
 */
function inferOriginalPath(target: IntegrationTarget, backupName: string): string | null {
  const home = homedir();
  // 剥掉 basename 之后的 8 位哈希后缀
  const base = backupName.replace(/\.[0-9a-f]{8}$/, "");
  switch (target) {
    case "codex": {
      // 只认两个能唯一确定的名字；其余不猜（写错文件比不还原更糟）。
      // catalog 也是接入产物，原路径固定在网关存储根，可以反推。
      if (base === "config.toml") return join(home, ".codex", "config.toml");
      if (base === "codex-model-catalog.json") return join(rootDir(), "codex-model-catalog.json");
      return null;
    }
    case "zcode":
      return join(home, ".zcode", "v2", "provider_config.json");
    case "dsh": {
      // 只认两个能唯一确定的：凭据引用文件（家目录下）与 config.yaml。
      // `cordis.patch.yml` 按 profile 分目录、同名多份 —— 反推不出是哪一份，跳过。
      if (base === ".credentials.yaml" || base === "credentials.yaml") {
        return join(home, ".dsh", ".credentials.yaml");
      }
      if (base === "config.yaml") return join(home, ".dsh", "config.yaml");
      return null;
    }
    case "claude-desktop": {
      // profile 与 meta 都在 Desktop 的 3P 配置库（跨平台路径由渠道自己推导），靠文件名区分。
      // 只认该库实际用到的两种命名，其余（老备份里混进来的别的文件）不猜。
      if (base === "_meta.json" || base.endsWith(".json")) {
        return join(claudeDesktopLibraryDir(), base);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * 一键还原：把该 target 的客户端配置恢复成**接入前**的样子。
 *
 * 语义（与「接入」对称，用户可预期）：
 * 1. 取该 target **最新一次**备份（`safety-*` 保护性快照不参与挑选）；
 * 2. **先把当前状态再备份一次**（`safety-<target>-<stamp>`）—— 还原是破坏性动作，
 *    用户可能想反悔；多留一份成本极低；
 * 3. 逐个文件回写：`existed:true` 写回原文，`existed:false` **删除**；
 * 4. 往清单里记 `restoredAt` 留痕，**不消费备份**。
 *
 * **可重复还原**：同一份「接入前」状态可以反复还原，第二次点不再报「没有找到备份」。
 * 早期版本把用过的备份改名成 `restored-` 前缀、导致只能还原一次（主人反馈）——
 * 现在 `restored-*` 与 `<target>-*` 一样按时间戳参与挑选，旧目录照常可用。
 *
 * 没有任何备份时如实报错（不假装成功）。
 */
export function restoreClient(target: IntegrationTarget): RestoreResult {
  const result: RestoreResult = { ok: false, target, restored: [], removed: [], notes: [] };
  const scan = backupScanOf(target);
  const source = scan.sources[0];
  if (source === undefined) {
    const backupRootPath = join(rootDir(), "backups", "integrate");
    // 找到了候选目录却都不可用时说清楚原因，否则「没有备份」是假象
    const detail = scan.skipped.length > 0 ? `；候选目录不可用：${scan.skipped.join("；")}` : "";
    result.error =
      `没有找到 ${target} 的接入备份（${backupRootPath}/${target}-*）` +
      `——先接入过一次才有可还原的状态${detail}`;
    return result;
  }

  // 条目来源：清单（逐条校验）或老备份的文件名反推；坏条目已在 notes 里说明
  result.notes.push(...source.notes);
  const entries = source.entries;
  // 先记账：部分失败时也要能让用户知道用的是哪份备份
  result.sourceDir = source.dir;

  // 保护性备份：把「当前状态」再留一份，用户想反悔时还有得救。
  // 用 `safety-` 前缀 —— 它装着接**后**的状态，混进自动挑选会让下次还原把自己改回去
  const safety = safetyDirFor(target);
  result.safetyDir = safety;
  for (const entry of entries) {
    if (!existsSync(entry.original)) continue;
    try {
      backupFile(safety, entry.original);
    } catch (err) {
      // 备份失败不阻断还原（可能是权限问题）；但要在 notes 里说出来
      result.notes.push(`保护性备份失败（${entry.original}）：${String(err)}`);
    }
  }

  // 逐个还原。
  // 单条失败**不中断**其余文件：一条坏条目（目标目录不存在、权限不足）不该让同一份
  // 备份里的有效条目全都白等（2026-11-08 实测：老 dsh 备份的第一条是 ENOENT，
  // 后面的补丁文件根本没被处理）。失败记进 notes、整体标记为失败，但把能还原的都还原。
  let failed = 0;
  for (const entry of entries) {
    try {
      if (!entry.existed) {
        // 接入时新建的文件：还原 = 删掉它（原本就不该存在）
        if (existsSync(entry.original)) {
          rmSync(entry.original, { force: true });
          result.removed.push(entry.original);
        }
        continue;
      }
      const backupPath = join(source.dir, entry.backup);
      if (!existsSync(backupPath)) {
        // 缺失也算失败：只报 ok 会让用户以为配置已回到接入前，实际少还原了一个文件
        failed += 1;
        // 报原路径（带哈希的备份名用户看不懂）
        result.notes.push(`备份文件缺失，跳过：${entry.original}（备份 ${entry.backup}）`);
        continue;
      }
      const original = readFileSync(backupPath, "utf8");
      // 目标目录可能已被删掉（用户清理过客户端目录）：补建，否则 writeAtomicFile 的
      // 临时文件会 ENOENT（报错信息还会指向一个用户看不懂的 `.tmp` 路径）。
      mkdirSync(dirname(entry.original), { recursive: true });
      writeVerified(entry.original, original, 0o600);
      result.restored.push(entry.original);
    } catch (err) {
      failed += 1;
      result.notes.push(`还原 ${entry.original} 失败，已跳过：${String(err)}`);
    }
  }
  if (failed > 0) {
    // 失败详情直接拼进 error：控制台的 err 分支只展示 error，notes 透不出去
    const detail = result.notes.length > 0 ? `：${result.notes.join("；")}` : "";
    result.error = `${failed} 个文件还原失败（其余 ${
      result.restored.length + result.removed.length
    } 个已还原）${detail}`;
    return result;
  }

  // **不消费备份**：还原改成幂等、可重复 —— 同一份「接入前」状态可以反复还原，
  // 第二次点还原不再报「没有找到备份」（主人反馈「前面的问题只能还原一次」）。
  // 只往清单里记一笔 `restoredAt` 留痕；旧版本留下的 `restored-*` 目录因此也是
  // 有效还原源（见 `backupScanOf`）。
  const manifest = readManifest(source.dir);
  if (manifest !== null) {
    manifest.restoredAt = new Date().toISOString();
    try {
      writeJsonSecret(join(source.dir, BACKUP_MANIFEST), manifest);
    } catch (err) {
      // 留痕失败不影响还原结果（配置已经写回）
      result.notes.push(`备份清单写回失败（不影响还原结果）：${String(err)}`);
    }
  }

  result.ok = true;
  writeIntegrationMarker(target, false);
  return result;
}

// ── 接入状态（开关式 UI 的状态源）────────────────────────────────────────────

/** 每 target 的接入态标记（`<root>/backups/integrate/<target>.state.json`）。 */
interface IntegrationMarker {
  integrated: boolean;
  /** 标记时刻（ISO）。 */
  at: string;
}

function markerPathFor(target: IntegrationTarget): string {
  backupRoot ??= join(rootDir(), "backups", "integrate");
  return join(backupRoot, `${target}.state.json`);
}

/** 容错读：文件缺失 / 损坏 / 字段非法一律返回 null（调用方回落清单推断）。 */
function readIntegrationMarker(target: IntegrationTarget): IntegrationMarker | null {
  const file = markerPathFor(target);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as IntegrationMarker;
    if (typeof parsed.integrated !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 写接入态标记。失败静默：接入 / 还原本身已完成，标记丢了只会让开关回落到
 * 清单推断（可能不准），不该为此把一次成功的接入报成失败。
 */
function writeIntegrationMarker(target: IntegrationTarget, integrated: boolean): void {
  try {
    writeJsonSecret(markerPathFor(target), {
      integrated,
      at: new Date().toISOString(),
    } satisfies IntegrationMarker);
  } catch {
    /* 回落清单推断，见上 */
  }
}

/**
 * 老安装没有标记文件：回落到「最新一份可用清单」推断 —— 接入成功的清单没有
 * `restoredAt`，视为在接入态。已知边界：接入失败（备份成功、写盘失败）也会留下
 * 没有 `restoredAt` 的清单，会误报成已接入 —— 首次开关操作后标记文件即接管。
 */
function fallbackIntegrated(target: IntegrationTarget): boolean {
  const scan = backupScanOf(target);
  const latest = scan.sources[0];
  if (latest === undefined) return false;
  const manifest = readManifest(latest.dir);
  if (manifest === null) return false;
  return manifest.restoredAt === undefined;
}

/**
 * 四个目标当前的接入态（开关式 UI 的状态源，随 `/api/state` 快照下发）。
 *
 * 判定顺序：标记文件（integrate / restore **整体成功**时写）→ 最新清单推断；
 * 没有任何备份（从未接入过）= 未接入。
 */
export function integrationStatus(): Record<IntegrationTarget, boolean> {
  const targets: IntegrationTarget[] = ["zcode", "dsh", "claude-desktop", "codex"];
  const out = {} as Record<IntegrationTarget, boolean>;
  for (const target of targets) {
    const marker = readIntegrationMarker(target);
    out[target] = marker ? marker.integrated : fallbackIntegrated(target);
  }
  return out;
}
