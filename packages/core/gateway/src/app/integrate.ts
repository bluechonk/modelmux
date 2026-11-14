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

import { POOL_EXPOSED_IDS } from "../pool/model-family.js";
import { poolModelMetas, poolModels } from "../pool/pool-targets.js";
import { defaultAddr } from "../runtime/cli-consts.js";
import { rootDir } from "../runtime/paths.js";
import { writeAtomicFile, writeJsonFile, writeJsonSecret } from "../runtime/secret-file.js";

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
  }
}

/** 本次接入的对外模型名（供调用方/测试注入）。 */
export function integrateClient(target: IntegrationTarget, models: string[] = exposedModels()): IntegrationResult {
  const result = integrateByTarget(target, models);
  // 整体成功才记「接入态」标记（开关式 UI 的状态源）；失败不动 —— 开关留在原位报错误。
  // 记下写入时的模型清单：「有更新」= 这份清单与当前对外清单 diff 出差异（integrationUpdates）。
  if (result.ok) writeIntegrationMarker(target, true, models);
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
  // 已处于接入态 ⇒ 这次是「重复接入（清单同步）」：当前文件就是接入**后**的样子，
  // 存进 `<target>-*` 会让下次还原把接入态写回去（开关关了但客户端仍指向网关 ——
  // 2026-11-14 实拍确认的「假关闭」根因）。改存 `safety-` 快照：不参与还原挑选，
  // 只作保护网（与还原前的 safety 快照同语义）。
  const already = readIntegrationMarker(target)?.integrated === true;
  const dir = join(backupRoot, already ? `safety-${target}-${stamp}` : `${target}-${stamp}`);
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
    default:
      return null;
  }
}

/**
 * zcode「关闭」的第二段：把接入写入的供应商痕迹从（已还原的）配置里**摘除**。
 *
 * 三处：providerRules 里 modelmux 的规则、providerOrder 里的 id、
 * modelConfigRules.providerModelRules 里挂在 modelmux 供应商下的模型启用规则。
 * 任一处不存在都正常跳过（重复摘除幂等）。
 */
function stripZcodeIntegration(file: string, notes: string[]): void {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    // 还原写回的内容不是合法 JSON（老备份占位内容 / 用户手改坏）—— 摘不了就跳过：
    // 还原本身已成功，摘除失败只留 notes，不算失败。
    notes.push(`配置不是合法 JSON，跳过摘除：${String(err)}`);
    return;
  }
  const config = (root["config"] ??= {}) as Record<string, unknown>;
  const rules = (config["providerConfigRules"] ??= {}) as Record<string, unknown>;
  const providerRules = (rules["providerRules"] ??= []) as Array<Record<string, unknown>>;
  const keptRules = providerRules.filter(
    (r) => r["providerId"] !== ZCODE_PROVIDER_ID && r["providerName"] !== ZCODE_PROVIDER_NAME,
  );
  if (keptRules.length !== providerRules.length) {
    rules["providerRules"] = keptRules;
    notes.push("移除 modelmux 供应商规则");
  }
  const order = config["providerOrder"];
  if (Array.isArray(order) && order.includes(ZCODE_PROVIDER_ID)) {
    config["providerOrder"] = order.filter((id) => id !== ZCODE_PROVIDER_ID);
    notes.push("从 providerOrder 移除 modelmux");
  }
  const modelRules = (config["modelConfigRules"] ??= {}) as Record<string, unknown>;
  const providerModelRules = (modelRules["providerModelRules"] ??= []) as Array<Record<string, unknown>>;
  const keptModelRules = providerModelRules.filter((r) => r["providerId"] !== ZCODE_PROVIDER_ID);
  if (keptModelRules.length !== providerModelRules.length) {
    modelRules["providerModelRules"] = keptModelRules;
    notes.push("移除 modelmux 的模型启用规则");
  }
  writeJsonFile(file, root, 0o600);
}

/**
 * dsh「关闭」的第二段：从（已还原的）patch 里摘掉接入写入的段。
 *
 * patch 是 YAML 顶层序列（`- id: <插件>` 条目）。接入写入的是两块：
 * `llm-pi-ai` 条目下的 `config.providers.modelmux` 供应商段，与（acp profile 的）
 * `- id: acp` 路由条目。摘除按块进行：`modelmux:` 行（缩进 m）到下一个缩进 ≤ m 的
 * 非空行之间整块删除；`providers:` 摘空后连键一起删；`config:` 摘空后连键一起删；
 * `llm-pi-ai` 条目只剩 id 时连整条删除（备份链最早一份也只有 modelmux 一个
 * provider，2026-11-14 实测 —— 条目本身是接入新建的）。重复摘除幂等。
 */
function stripDshIntegration(text: string, notes: string[]): string {
  const lines = text.split(/\r?\n/);
  const entryIdx = lines.findIndex((l) => /^- id:\s*llm-pi-ai\s*$/.test(l));
  let out = lines;
  if (entryIdx < 0) {
    // 没有 llm-pi-ai 条目：只摘 acp 路由条目（若有）
    const acpIdx = out.findIndex((l) => /^- id:\s*acp\s*$/.test(l));
    if (acpIdx >= 0) {
      let acpEnd = out.length;
      for (let i = acpIdx + 1; i < out.length; i += 1) {
        if (/^- id:\s/.test(out[i]!)) {
          acpEnd = i;
          break;
        }
      }
      out = [...out.slice(0, acpIdx), ...out.slice(acpEnd)];
      notes.push("移除 dsh patch 里的 acp 路由条目");
    }
    return out.filter((l, i) => !(isBlank(l) && i > 0 && isBlank(out[i - 1]!))).join("\n");
  }
  // ① 删 modelmux 块
  const mmIdx = out.findIndex((l, i) => i > entryIdx && /^(\s*)modelmux:\s*$/.test(l));
  if (mmIdx >= 0) {
    const mmIndent = indentOf(out[mmIdx]!);
    let mmEnd = out.length;
    for (let i = mmIdx + 1; i < out.length; i += 1) {
      if (isBlank(out[i]!)) continue;
      if (indentOf(out[i]!) <= mmIndent) {
        mmEnd = i;
        break;
      }
    }
    out = [...out.slice(0, mmIdx), ...out.slice(mmEnd)];
    notes.push("移除 dsh patch 里的 modelmux 供应商段");
  }
  // ② 级联：providers: / config: 摘空后连键一起删（每步重新定位，索引不跨删除复用）
  for (const key of ["providers:", "config:"]) {
    const keyIdx = out.findIndex((l, i) => i > entryIdx && l.trimStart().startsWith(key) && /^\s*providers:\s*$|^\s*config:\s*$/.test(l));
    if (keyIdx < 0) continue;
    const kIndent = indentOf(out[keyIdx]!);
    let kEnd = out.length;
    for (let i = keyIdx + 1; i < out.length; i += 1) {
      if (isBlank(out[i]!)) continue;
      if (indentOf(out[i]!) <= kIndent) {
        kEnd = i;
        break;
      }
    }
    if (out.slice(keyIdx + 1, kEnd).every((l) => isBlank(l))) {
      out = [...out.slice(0, keyIdx), ...out.slice(kEnd)];
      notes.push(`移除摘空的 ${key.replace(":", "")} 键`);
    }
  }
  // ③ 条目只剩 id（name 等子键全无）→ 整条删（边界重新定位）
  const eIdx = out.findIndex((l) => /^- id:\s*llm-pi-ai\s*$/.test(l));
  if (eIdx >= 0) {
    let eEnd = out.length;
    for (let i = eIdx + 1; i < out.length; i += 1) {
      if (/^- id:\s/.test(out[i]!)) {
        eEnd = i;
        break;
      }
    }
    const hasChild = out.slice(eIdx + 1, eEnd).some((l) => /^\s+\S/.test(l));
    if (!hasChild) {
      out = [...out.slice(0, eIdx), ...out.slice(eEnd)];
      notes.push("移除空的 llm-pi-ai 条目");
    }
  }
  // ④ acp 路由条目（acp profile 接入时写入）：整条删除
  const acpIdx = out.findIndex((l) => /^- id:\s*acp\s*$/.test(l));
  if (acpIdx >= 0) {
    let acpEnd = out.length;
    for (let i = acpIdx + 1; i < out.length; i += 1) {
      if (/^- id:\s/.test(out[i]!)) {
        acpEnd = i;
        break;
      }
    }
    out = [...out.slice(0, acpIdx), ...out.slice(acpEnd)];
    notes.push("移除 dsh patch 里的 acp 路由条目");
  }
  // 收尾：连续空行压成一个
  const cleaned: string[] = [];
  for (const l of out) {
    if (isBlank(l) && cleaned.length > 0 && isBlank(cleaned[cleaned.length - 1]!)) continue;
    cleaned.push(l);
  }
  return cleaned.join("\n");
}


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
  // zcode 是**就地修改**（往用户配置里加 modelmux 供应商 + 改清单 + providerOrder），
  // 备份内容可能已是接入态 —— 还原后把接入写入的供应商痕迹**摘除**。这一步才是
  // 「关闭」的本体；失败 = 配置仍指向网关，按失败处理（配置已是备份内容，可重试）。
  if (target === "zcode" && result.restored.length > 0) {
    const zcFile = join(homedir(), ".zcode", "v2", "provider_config.json");
    if (existsSync(zcFile)) {
      try {
        stripZcodeIntegration(zcFile, result.notes);
        result.restored.push(`${zcFile}（摘除 modelmux 供应商）`);
      } catch (err) {
        failed += 1;
        result.notes.push(`摘除 zcode 供应商痕迹失败：${String(err)}`);
      }
    }
  }
  // dsh 同理：patch 备份内容是接入态（历史同步的快照），还原后摘掉 modelmux
  // 供应商段与 acp 路由条目 —— 逐个 restored 的 patch 文件处理。
  if (target === "dsh" && result.restored.length > 0) {
    for (const entryPath of result.restored) {
      if (!entryPath.includes(".dsh") || !existsSync(entryPath)) continue;
      try {
        const stripped = stripDshIntegration(readFileSync(entryPath, "utf8"), result.notes);
        writeVerified(entryPath, stripped, 0o600);
        result.restored.push(`${entryPath}（摘除 modelmux 接入段）`);
      } catch (err) {
        failed += 1;
        result.notes.push(`摘除 dsh 接入段失败（${entryPath}）：${String(err)}`);
      }
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
  /** 接入时写入的对外模型清单（「有更新」的 diff 基准；还原标记与老标记没有该字段）。 */
  models?: string[];
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
 * 清单推断（可能不准），不该为此把一次成功的接入报成失败。但 `models` 基准
 * 也会一起丢（卡头可能亮一个消不掉的假「更新」），失败必须留痕可查。
 */
function writeIntegrationMarker(target: IntegrationTarget, integrated: boolean, models?: string[]): void {
  try {
    writeJsonSecret(markerPathFor(target), {
      integrated,
      // 只在接入时记清单（还原后没有「写入了什么」可言）；老标记缺该字段时按「判不了」处理
      ...(models === undefined ? {} : { models: [...models] }),
      at: new Date().toISOString(),
    } satisfies IntegrationMarker);
  } catch (err) {
    // integrate 走 CLIClient 与控制台两条路，都没带 logger 通道；与 paths.ts 同法
    // 直接写 stderr（监督者会收进 worker.log）
    console.error(`[modelmux] integrate marker write failed: ${String(err)}`);
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
 * 两个目标当前的接入态（开关式 UI 的状态源，随 `/api/state` 快照下发）。
 *
 * 判定顺序：标记文件（integrate / restore **整体成功**时写）→ 最新清单推断；
 * 没有任何备份（从未接入过）= 未接入。
 */
export function integrationStatus(): Record<IntegrationTarget, boolean> {
  const targets: IntegrationTarget[] = ["zcode", "dsh"];
  const out = {} as Record<IntegrationTarget, boolean>;
  for (const target of targets) {
    const marker = readIntegrationMarker(target);
    out[target] = marker ? marker.integrated : fallbackIntegrated(target);
  }
  return out;
}

/** 单个接入目标的「模型有更新」明细（diff 相对当前对外模型清单）。 */
export interface IntegrationUpdate {
  /** 当前对外有、接入时没有的模型。 */
  added: string[];
  /** 接入时有、当前对外已经没有的模型。 */
  removed: string[];
  /** 上次接入时刻（标记文件的 `at`）。 */
  at: string;
}

/**
 * 各接入目标的「模型有更新」（快照随 `integrations` 一起下发）。
 *
 * 判据 = 标记文件里接入时写入的 `models` 与**当前**对外模型清单的集合差；
 * 没接入、老标记没记清单、或集合一致 → null（前端不亮更新按钮）。
 * 集合比较而不是逐位比较：清单顺序无语义，接入时是什么顺序不重要。
 */
export function integrationUpdates(): Record<string, IntegrationUpdate | null> {
  const targets: IntegrationTarget[] = ["zcode", "dsh"];
  const current = new Set(exposedModels());
  const out: Record<string, IntegrationUpdate | null> = {};
  for (const target of targets) {
    const marker = readIntegrationMarker(target);
    if (marker === null || !marker.integrated || !Array.isArray(marker.models)) {
      out[target] = null;
      continue;
    }
    const recorded = new Set(marker.models.filter((m) => typeof m === "string"));
    const added = [...current].filter((m) => !recorded.has(m));
    const removed = [...recorded].filter((m) => !current.has(m));
    out[target] =
      added.length === 0 && removed.length === 0
        ? null
        : { added, removed, at: typeof marker.at === "string" ? marker.at : "" };
  }
  return out;
}
