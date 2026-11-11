/**
 * 一键接入 / 还原的错误分支补充（既有 integrate.test.ts 只覆盖 happy path）。
 *
 * 全程在临时 HOME（USERPROFILE）+ 临时 MODELMUX_HOME 里操作副本，真实配置绝不碰。
 * Windows 上用 chmod 0o444 挡下 rename 来触发写失败（writeAtomicFile 的幂等判据）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  integrationStatus,
  integrateClient,
  restoreClient,
} from "../dist/app/integrate.js";
import { POOL_EXPOSED_IDS } from "../dist/pool/model-family.js";

const MODELS = ["deepseek-v4.1-flash", "glm-5.3-flash"];
/** 写失败用例依赖 Windows 的只读属性挡 rename；POSIX 上 rename 不受文件权限影响。 */
const isWin = process.platform === "win32";

let home = "";
let root = "";
let savedProfile: string | undefined;
let savedHome: string | undefined;
let savedRoot: string | undefined;
let savedLocalAppData: string | undefined;
let savedXdg: string | undefined;

before(() => {
  home = mkdtempSync(join(tmpdir(), "modelmux-integrate-extra-home-"));
  root = mkdtempSync(join(tmpdir(), "modelmux-integrate-extra-root-"));
  savedProfile = process.env["USERPROFILE"];
  savedHome = process.env["HOME"];
  savedRoot = process.env["MODELMUX_HOME"];
  savedLocalAppData = process.env["LOCALAPPDATA"];
  savedXdg = process.env["XDG_CONFIG_HOME"];
  process.env["USERPROFILE"] = home;
  process.env["HOME"] = home;
  process.env["MODELMUX_HOME"] = root;
  process.env["LOCALAPPDATA"] = join(home, "AppData", "Local");
  process.env["XDG_CONFIG_HOME"] = join(home, ".config");
});

after(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("USERPROFILE", savedProfile);
  restore("HOME", savedHome);
  restore("MODELMUX_HOME", savedRoot);
  restore("LOCALAPPDATA", savedLocalAppData);
  restore("XDG_CONFIG_HOME", savedXdg);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const backupRoot = (): string => join(root, "backups", "integrate");

/** 清空备份根（用例之间互不污染）。 */
function clearBackups(): void {
  rmSync(backupRoot(), { recursive: true, force: true });
}

beforeEach(() => {
  clearBackups();
  // 客户端配置副本也要清：用例之间不能靠「上一个没写过」
  rmSync(join(root, "codex-model-catalog.json"), { force: true });
  rmSync(join(home, ".dsh", ".credentials.yaml"), { force: true });
  rmSync(join(home, ".codex"), { recursive: true, force: true });
  rmSync(DESKTOP_DIR, { recursive: true, force: true });
});

/** Windows 下把文件置只读；其它平台不动（POSIX 的目录权限已由专门用例覆盖）。 */
function readOnly(path: string): void {
  if (process.platform === "win32") chmodSync(path, 0o444);
}

function writable(path: string): void {
  if (process.platform === "win32") chmodSync(path, 0o600);
}

// ── 种子文件 ────────────────────────────────────────────────────────────────

function seedZcode(config: unknown = {}): string {
  const file = join(home, ".zcode", "v2", "provider_config.json");
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

const ZCODE_MINIMAL = {
  schemaVersion: 1,
  config: {
    providerOrder: [] as string[],
    providerConfigRules: { providerRules: [] as Array<Record<string, unknown>> },
    modelConfigRules: { providerModelRules: [] as Array<Record<string, unknown>> },
  },
};

function seedDsh(profile: string, text: string): string {
  const file = join(home, ".dsh", "profiles", profile, "cordis.patch.yml");
  mkdirSync(join(home, ".dsh", "profiles", profile), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

const DSH_PROVIDER_NO_MODELS = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      modelmux:
        displayName: modelmux
        apiKeyEnv: MODELMUX_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:4412/v1
`;

const DSH_ACP_WITH_PROVIDER = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      modelmux:
        displayName: modelmux
        apiKeyEnv: MODELMUX_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:4412/v1
        models:
          - id: old-model
            name: old-model
            input:
              - text
`;

// 与实现同口径：darwin 用 Library，Windows 用 LOCALAPPDATA，其余用 XDG_CONFIG_HOME
const DESKTOP_DIR =
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude-3p", "configLibrary")
    : process.platform === "win32"
      ? join(home, "AppData", "Local", "Claude-3p", "configLibrary")
      : join(home, ".config", "Claude-3p", "configLibrary");

function seedDesktop(): string {
  mkdirSync(DESKTOP_DIR, { recursive: true });
  return DESKTOP_DIR;
}

function seedCodex(text: string): string {
  const dir = join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.toml");
  writeFileSync(file, text, "utf8");
  return file;
}

/** 预建当前秒与未来两秒的备份目录（避免跨秒竞态），对每个目录调 setup。 */
function precreateBackupDirs(target: string, setup: (dir: string) => void): void {
  for (let i = 0; i < 3; i += 1) {
    const stamp = new Date(Date.now() + i * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dir = join(backupRoot(), `${target}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    setup(dir);
  }
}

/** 备份目录里 dest 备份名（与实现同口径：basename + 原路径 sha256 前 8 位）。 */
function backupNameOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? "config";
  return `${base}.${createHash("sha256").update(file).digest("hex").slice(0, 8)}`;
}

// ── zcode ───────────────────────────────────────────────────────────────────

describe("zcode 补充分支", () => {
  it("缺省模型参数走 exposedModels（池为空时回落家族常量）", () => {
    seedZcode(ZCODE_MINIMAL);
    const result = integrateClient("zcode");
    assert.equal(result.ok, true);
    assert.ok(result.models.length > 0, "缺省模型不该是空清单");
    assert.deepEqual([...result.models].sort(), [...POOL_EXPOSED_IDS].sort());
  });

  it("配置不是合法 JSON：如实报错", () => {
    const file = join(home, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(file, "{broken", "utf8");
    const result = integrateClient("zcode", MODELS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /不是合法 JSON/);
  });

  it("供应商规则与 providerOrder 都缺失：新增规则并加入顺序表", () => {
    seedZcode(ZCODE_MINIMAL);
    const result = integrateClient("zcode", MODELS);
    assert.equal(result.ok, true);
    assert.ok(result.notes.some((n) => n.includes("新增 modelmux 供应商规则")));
    assert.ok(result.notes.some((n) => n.includes("providerOrder")));
  });

  it("配置写失败（目标只读）：如实报错", () => {
    const file = seedZcode(ZCODE_MINIMAL);
    readOnly(file);
    if (!isWin) return;
    try {
      const result = integrateClient("zcode", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /写 zcode 配置失败/);
    } finally {
      writable(file);
    }
  });

  it("备份清单读不出：登记不上时如实警告", () => {
    seedZcode(ZCODE_MINIMAL);
    precreateBackupDirs("zcode", (dir) => {
      // manifest.json 是个目录：existsSync 为真，readFileSync 抛 EISDIR
      mkdirSync(join(dir, "manifest.json"), { recursive: true });
    });
    const result = integrateClient("zcode", MODELS);
    assert.ok(
      result.warnings.some((w) => w.includes("本次备份未登记")),
      `应有未登记警告：${result.warnings.join(" / ")}`,
    );
  });

  it("备份清单不可读且备份已存在：保留已有备份不覆盖", () => {
    const file = seedZcode(ZCODE_MINIMAL);
    const name = backupNameOf(file);
    precreateBackupDirs("zcode", (dir) => {
      mkdirSync(join(dir, "manifest.json"), { recursive: true });
      writeFileSync(join(dir, name), "old-backup", "utf8");
    });
    const result = integrateClient("zcode", MODELS);
    assert.ok(
      result.warnings.some((w) => w.includes("保留已有备份不覆盖")),
      `应有保留警告：${result.warnings.join(" / ")}`,
    );
  });
});

// ── dsh ─────────────────────────────────────────────────────────────────────

describe("dsh 补充分支", () => {
  it("provider 块没有 models 键：插到块末尾", () => {
    seedDsh("desktop", DSH_PROVIDER_NO_MODELS);
    const file = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    const result = integrateClient("dsh", MODELS);
    assert.equal(result.ok, true, result.error);
    const after = readFileSync(file, "utf8");
    for (const model of MODELS) assert.ok(after.includes(`- id: ${model}`), `缺少 ${model}`);
    assert.ok(after.indexOf("models:") > after.indexOf("modelmux:"), "models 应插在 provider 块内");
  });

  it("acp 已有 provider 但缺 acp 路由：补路由条目", () => {
    seedDsh("acp", DSH_ACP_WITH_PROVIDER);
    const file = join(home, ".dsh", "profiles", "acp", "cordis.patch.yml");
    const result = integrateClient("dsh", MODELS);
    assert.equal(result.ok, true, result.error);
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("- id: acp"), "缺 acp 路由条目");
    assert.ok(after.includes(`model: ${MODELS[0]}`), "路由没指到首个对外模型");
  });

  it("refs 开了但收尾判不出：跳过写入并警告", () => {
    seedDsh("desktop", DSH_PROVIDER_NO_MODELS);
    const cred = join(home, ".dsh", ".credentials.yaml");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    // 唯一的 `}` 在注释里：剥注释后深度永不归零
    writeFileSync(cred, "version: 1\nrefs: { LONGCAT_API_KEY: ak # }\n", "utf8");
    const result = integrateClient("dsh", MODELS);
    assert.ok(
      result.warnings.some((w) => w.includes("refs 块形态无法安全解析")),
      `应有解析警告：${result.warnings.join(" / ")}`,
    );
  });

  it("多行 flow 的收尾与条目同行：注释挪到括号后", () => {
    seedDsh("desktop", DSH_PROVIDER_NO_MODELS);
    const cred = join(home, ".dsh", ".credentials.yaml");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    writeFileSync(cred, "version: 1\nrefs: {\n  LONGCAT_API_KEY: ak }\n", "utf8");
    const result = integrateClient("dsh", MODELS);
    assert.equal(result.ok, true, result.error);
    const after = readFileSync(cred, "utf8");
    assert.match(after, /LONGCAT_API_KEY: ak, MODELMUX_API_KEY: modelmux-local\}\n/, "条目应接在收尾同行");
  });

  it("凭据文件写失败（只读）：警告且不中断 profile", () => {
    seedDsh("desktop", DSH_PROVIDER_NO_MODELS);
    const cred = join(home, ".dsh", ".credentials.yaml");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    writeFileSync(cred, "version: 1\nrefs: { LONGCAT_API_KEY: ak }\n", "utf8");
    readOnly(cred);
    if (!isWin) return;
    try {
      const result = integrateClient("dsh", MODELS);
      assert.ok(
        result.warnings.some((w) => w.includes("凭据文件写入失败")),
        `应有写失败警告：${result.warnings.join(" / ")}`,
      );
      assert.equal(result.ok, true, "profile 仍应接入成功");
    } finally {
      writable(cred);
    }
  });

  it("单个 profile 写失败（只读）：跳过它，其余照常", () => {
    const desktop = seedDsh("desktop", DSH_PROVIDER_NO_MODELS);
    seedDsh("acp", DSH_ACP_WITH_PROVIDER);
    const acp = join(home, ".dsh", "profiles", "acp", "cordis.patch.yml");
    readOnly(acp);
    if (!isWin) return;
    try {
      const result = integrateClient("dsh", MODELS);
      assert.equal(result.ok, true, result.error);
      assert.ok(result.changed.includes(desktop), "desktop 应写入");
      assert.ok(
        result.warnings.some((w) => w.includes("acp：写入失败")),
        `应有跳过警告：${result.warnings.join(" / ")}`,
      );
    } finally {
      writable(acp);
    }
  });
});

// ── claude desktop ──────────────────────────────────────────────────────────

describe("claude desktop 补充分支", () => {
  it("_meta.json 不是合法 JSON：如实报错", () => {
    const dir = seedDesktop();
    writeFileSync(join(dir, "_meta.json"), "{broken", "utf8");
    const result = integrateClient("claude-desktop", MODELS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /_meta\.json 不是合法 JSON/);
  });

  it("profile 不是合法 JSON：如实报错", () => {
    const dir = seedDesktop();
    writeFileSync(join(dir, "modelmux.json"), "{broken", "utf8");
    const result = integrateClient("claude-desktop", MODELS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /不是合法 JSON/);
  });

  it("空配置库：两个文件都是接入新建", () => {
    const dir = seedDesktop();
    const result = integrateClient("claude-desktop", MODELS);
    assert.equal(result.ok, true, result.error);
    assert.ok(result.changed.includes(join(dir, "modelmux.json")), "profile 应是新建");
    assert.ok(result.changed.includes(join(dir, "_meta.json")), "meta 应是新建");
  });

  it("配置写失败（只读）：如实报错", () => {
    const dir = seedDesktop();
    const profile = join(dir, "modelmux.json");
    writeFileSync(profile, "{}\n", "utf8");
    readOnly(profile);
    if (!isWin) return;
    try {
      const result = integrateClient("claude-desktop", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /写 Claude Desktop 配置失败/);
    } finally {
      writable(profile);
    }
  });
});

// ── codex ───────────────────────────────────────────────────────────────────

describe("codex 补充分支", () => {
  it("modelmux 段后面还有别的表：替换到下一个表头为止", () => {
    const file = seedCodex(`[model_providers.modelmux]
name = "old"
base_url = "http://old"

[profiles.fast]
model = "gpt"
`);
    const result = integrateClient("codex", MODELS);
    assert.equal(result.ok, true, result.error);
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("[profiles.fast]"), "后续段丢失");
    assert.ok(after.includes('model = "gpt"'), "后续段被改动");
    assert.ok(!after.includes("http://old"), "旧段没被替换");
  });

  it("多行字符串开合不配对：如实报错", () => {
    seedCodex('instructions = """\nunclosed\n');
    const result = integrateClient("codex", MODELS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /多行字符串/);
  });

  it("catalog 内容损坏且写不进去：解析不了不算等价，如实报错", () => {
    seedCodex('model = "gpt"\n');
    const catalog = join(root, "codex-model-catalog.json");
    mkdirSync(join(root), { recursive: true });
    writeFileSync(catalog, "{broken", "utf8");
    readOnly(catalog);
    if (!isWin) return;
    try {
      const result = integrateClient("codex", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /写 Codex 模型目录失败/);
    } finally {
      writable(catalog);
    }
  });
});

// ── 还原 ────────────────────────────────────────────────────────────────────

describe("还原补充分支", () => {
  /** 造一个带清单的备份目录。 */
  function makeBackup(target: string, stamp: string, files: Array<{ original: string; backup: string; existed: boolean }>, bodies: Record<string, string>): string {
    const dir = join(backupRoot(), `${target}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(bodies)) writeFileSync(join(dir, name), body, "utf8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: 1, target, createdAt: "2026-01-01T00:00:00.000Z", files }),
      "utf8",
    );
    return dir;
  }

  it("清单读不出（manifest 是目录）：记原因并跳过", () => {
    const dir = join(backupRoot(), "zcode-20990101000000");
    mkdirSync(join(dir, "manifest.json"), { recursive: true });
    const result = restoreClient("zcode");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /备份清单读取失败/);
  });

  it("清单 files 不是数组：记原因并跳过", () => {
    const dir = join(backupRoot(), "zcode-20990101000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, target: "zcode", files: {} }), "utf8");
    const result = restoreClient("zcode");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /files 不是数组/);
  });

  it("老备份（无清单）按文件名反推原路径", () => {
    const provider = join(home, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(provider, "CURRENT", "utf8");
    makeBackup(
      "zcode",
      "20990101000000",
      [],
      {},
    );
    // 老备份没有 manifest：手动删掉后放一个备份文件
    const dir = join(backupRoot(), "zcode-20990101000000");
    rmSync(join(dir, "manifest.json"), { force: true });
    writeFileSync(join(dir, "provider_config.json.aaa11111"), "OLD", "utf8");

    const result = restoreClient("zcode");
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(provider, "utf8"), "OLD", "应按反推路径写回");
  });

  it("老备份反推不出原路径：跳过并记 notes", () => {
    const dir = join(backupRoot(), "dsh-20990101000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.txt"), "x", "utf8");
    const result = restoreClient("dsh");
    assert.equal(result.ok, false);
    assert.ok(
      (result.error ?? "").includes("无法确定原路径") || result.notes.some((n) => n.includes("无法确定原路径")),
      `应记录跳过的文件：${result.error ?? ""} / ${result.notes.join(" / ")}`,
    );
  });

  it("dsh 老备份反推 .credentials.yaml 与 config.yaml", () => {
    const cred = join(home, ".dsh", ".credentials.yaml");
    const cfg = join(home, ".dsh", "config.yaml");
    mkdirSync(join(home, ".dsh"), { recursive: true });
    writeFileSync(cred, "CURRENT", "utf8");
    writeFileSync(cfg, "CURRENT", "utf8");
    const dir = join(backupRoot(), "dsh-20990101000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.yaml.aaa11111"), "OLDCRED", "utf8");
    writeFileSync(join(dir, "config.yaml.bbb22222"), "OLDCFG", "utf8");

    const result = restoreClient("dsh");
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(cred, "utf8"), "OLDCRED");
    assert.equal(readFileSync(cfg, "utf8"), "OLDCFG");
  });

  it("desktop 老备份反推 json 文件；非 json 跳过", () => {
    const dir = join(backupRoot(), "claude-desktop-20990101000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "_meta.json.aaa11111"), "META", "utf8");
    writeFileSync(join(dir, "other.txt"), "x", "utf8");

    const result = restoreClient("claude-desktop");
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(join(DESKTOP_DIR, "_meta.json"), "utf8"), "META");
    assert.ok(result.notes.some((n) => n.includes("other.txt")), "非 json 文件应被跳过并记录");
  });

  it("老备份（codex）反推不出原路径：跳过并记 notes", () => {
    const dir = join(backupRoot(), "codex-20990101000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.txt"), "x", "utf8");
    const result = restoreClient("codex");
    assert.equal(result.ok, false);
    assert.ok(
      (result.error ?? "").includes("无法确定原路径") || result.notes.some((n) => n.includes("无法确定原路径")),
      `应记录跳过的文件：${result.error ?? ""} / ${result.notes.join(" / ")}`,
    );
  });

  it("多份备份按时间戳排序：stampOf 参与比较", () => {
    const provider = join(home, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(provider, "CURRENT", "utf8");
    makeBackup(
      "zcode",
      "20980101000000",
      [{ original: provider, backup: "provider_config.json.aaa11111", existed: true }],
      { "provider_config.json.aaa11111": "OLDER" },
    );
    makeBackup(
      "zcode",
      "20990101000000",
      [{ original: provider, backup: "provider_config.json.bbb22222", existed: true }],
      { "provider_config.json.bbb22222": "NEWER" },
    );
    const result = restoreClient("zcode");
    assert.equal(result.ok, true, result.error);
    assert.equal(readFileSync(provider, "utf8"), "NEWER", "应选最新那份备份");
  });

  it("保护性备份失败与单条还原失败都如实记 notes", () => {
    const provider = join(home, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(provider, "CURRENT", "utf8");
    const blocked = join(home, "blocked-dir");
    mkdirSync(blocked, { recursive: true });

    makeBackup(
      "zcode",
      "20990101000000",
      [
        { original: provider, backup: "provider_config.json.aaa11111", existed: true },
        { original: blocked, backup: "blocked-dir.bbb22222", existed: true },
      ],
      { "provider_config.json.aaa11111": "OLD", "blocked-dir.bbb22222": "X" },
    );

    const result = restoreClient("zcode");
    assert.equal(result.ok, false, "有失败条目必须报失败");
    assert.ok(result.notes.some((n) => n.includes("保护性备份失败")), "目录被当文件备份要留痕");
    assert.ok(result.notes.some((n) => n.includes("还原") && n.includes("失败")), "单条还原失败要留痕");
    assert.equal(readFileSync(provider, "utf8"), "OLD", "好条目仍应还原");
  });
});

// ── 接入状态 ────────────────────────────────────────────────────────────────

describe("接入状态标记与回落", () => {
  it("无标记无备份：全部未接入", () => {
    const status = integrationStatus();
    assert.deepEqual(status, { zcode: false, dsh: false, "claude-desktop": false, codex: false });
  });

  it("标记损坏 / 字段非法：回落清单推断", () => {
    const marker = join(backupRoot(), "zcode.state.json");
    mkdirSync(backupRoot(), { recursive: true });
    writeFileSync(marker, "{broken", "utf8");
    assert.equal(integrationStatus()["zcode"], false, "损坏标记按未接入处理");

    writeFileSync(marker, JSON.stringify({ integrated: "yes" }), "utf8");
    assert.equal(integrationStatus()["zcode"], false, "非布尔字段按未接入处理");
  });

  it("标记正常：直接用标记", () => {
    const marker = join(backupRoot(), "dsh.state.json");
    mkdirSync(backupRoot(), { recursive: true });
    writeFileSync(marker, JSON.stringify({ integrated: true, at: "2026-01-01T00:00:00.000Z" }), "utf8");
    assert.equal(integrationStatus()["dsh"], true);
  });

  it("无标记但最新清单没有 restoredAt：推断为已接入", () => {
    const provider = join(home, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(provider, "CURRENT", "utf8");
    makeBackupState(
      "zcode",
      "20990101000000",
      [{ original: provider, backup: "provider_config.json.aaa11111", existed: true }],
      { "provider_config.json.aaa11111": "OLD" },
    );
    assert.equal(integrationStatus()["zcode"], true);
  });

  it("标记写失败静默回落（不把成功接入报成失败）", () => {
    seedZcode(ZCODE_MINIMAL);
    // markerPath 是个目录：writeJsonSecret 的 rename 必然失败，但接入本身要成功
    mkdirSync(join(backupRoot(), "zcode.state.json"), { recursive: true });
    const result = integrateClient("zcode", MODELS);
    assert.equal(result.ok, true, result.error);
  });

  it("无标记且最新备份没有清单：推断为未接入", () => {
    const provider = join(home, ".zcode", "v2", "provider_config.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(provider, "CURRENT", "utf8");
    const dir = join(backupRoot(), "zcode-20990101000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "provider_config.json.aaa11111"), "OLD", "utf8");
    assert.equal(integrationStatus()["zcode"], false);
  });
});

/** 造一个带清单的备份目录（接入状态用）。 */
function makeBackupState(target: string, stamp: string, files: Array<{ original: string; backup: string; existed: boolean }>, bodies: Record<string, string>): string {
  const dir = join(backupRoot(), `${target}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(dir, name), body, "utf8");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 1, target, createdAt: "2026-01-01T00:00:00.000Z", files }),
    "utf8",
  );
  return dir;
}
