/**
 * 一键接入写入器（`app/integrate.ts`）：把本机 harness 的模型配置改写成网关的对外模型名。
 *
 * 全程在**临时 HOME** 里操作副本（真实配置绝不碰），锁三件事：
 *  1. 只改目标块 —— zcode 的其它供应商规则、dsh 的其它 provider 必须逐字节不变；
 *  2. 幂等 —— 二次运行为 no-op（内容一致、不重复写）；
 *  3. 缺失场景 —— 配置文件不存在时如实报错，不静默创建。
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { integrateClient } from "../dist/app/integrate.js";

const MODELS = ["deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-pro"];
const GATEWAY_BASE = "http://127.0.0.1:4412/v1";

let home = "";
let savedHome: string | undefined;
let savedRoot: string | undefined;

before(() => {
  home = mkdtempSync(join(tmpdir(), "modelmux-integrate-"));
  savedHome = process.env["USERPROFILE"];
  savedRoot = process.env["MODELMUX_HOME"];
  // os.homedir() 在 Windows 上取 USERPROFILE；网关落点取 MODELMUX_HOME
  process.env["USERPROFILE"] = home;
  process.env["HOME"] = home;
  process.env["MODELMUX_HOME"] = join(home, ".modelmux");
});

after(() => {
  if (savedHome === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = savedHome;
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(home, { recursive: true, force: true });
});

/** zcode 配置（精简但结构真实：modelmux + 另一个供应商 + 逐模型启用项）。 */
const ZCODE_CONFIG = {
  schemaVersion: 1,
  config: {
    providerOrder: ["new-provider", "deepseek"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "new-provider",
          providerName: "modelmux",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "u" },
            api: { type: "openai-chat-completions", baseUrl: GATEWAY_BASE },
            personalModelIds: ["loomy/deepseek-v4.1-flash"],
            modelOrder: ["loomy/deepseek-v4.1-flash"],
          },
        },
        {
          providerId: "deepseek",
          providerName: "DeepSeek",
          config: { access: { type: "api-key", apiKey: "x" }, personalModelIds: [] },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        { modelId: "loomy/deepseek-v4.1-flash", providerId: "new-provider", config: { enabled: true } },
        { modelId: "LongCat-2.5", providerId: "new-provider-2", config: { enabled: true } },
      ],
    },
  },
};

/** 写一份 zcode 配置到临时 HOME，返回路径。 */
function seedZcode(): string {
  const file = join(home, ".zcode", "v2", "provider_config.json");
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ZCODE_CONFIG, null, 2)}\n`, "utf8");
  return file;
}

/** dsh 桌面 profile 的 patch（含 modelmux + longcat 两个 provider）。 */
const DSH_DESKTOP = `# 头部注释（必须保留）
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: detailed
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      modelmux:
        displayName: modelmux
        apiKeyEnv: MODELMUX_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:4412/v1
        models:
          - id: loomy/deepseek-v4.1-flash
            name: loomy/deepseek-v4.1-flash
            contextWindow: 1048576
            maxTokens: 393216
            input:
              - text
              - image
      longcat:
        displayName: longcat
        apiKeyEnv: LONGCAT_API_KEY
        api: openai-completions
        baseURL: https://api.longcat.chat/openai/v1
        models:
          - id: LongCat-2.5
            name: LongCat-2.5
            input:
              - text
`;

/** dsh acp profile 的 patch（当前是空数组）。 */
const DSH_ACP = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

function seedDsh(): string {
  const dir = join(home, ".dsh", "profiles");
  for (const [profile, text] of [["desktop", DSH_DESKTOP], ["acp", DSH_ACP]] as const) {
    mkdirSync(join(dir, profile), { recursive: true });
    writeFileSync(join(dir, profile, "cordis.patch.yml"), text, "utf8");
  }
  return dir;
}

describe("一键接入 zcode", () => {
  it("只改 modelmux 的 api / 模型清单，其它供应商规则逐字节不变", () => {
    const file = seedZcode();
    const before = JSON.parse(readFileSync(file, "utf8")) as typeof ZCODE_CONFIG;
    const result = integrateClient("zcode", MODELS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, [file]);

    const after = JSON.parse(readFileSync(file, "utf8")) as typeof ZCODE_CONFIG;
    const bx = before.config.providerConfigRules.providerRules;
    const ax = after.config.providerConfigRules.providerRules;
    // 其它供应商：完全不动（顺序也一致）
    assert.deepEqual(
      ax.filter((r) => r.providerId !== "new-provider"),
      bx.filter((r) => r.providerId !== "new-provider"),
    );
    assert.equal(ax.length, bx.length, "供应商数量不该变");
    // modelmux：只允许 api / personalModelIds / modelOrder 变
    const bm = bx.find((r) => r.providerId === "new-provider")!;
    const am = ax.find((r) => r.providerId === "new-provider")!;
    assert.equal(am.config["group"], bm.config["group"], "group 被改动了");
    assert.deepEqual(am.config["access"], bm.config["access"], "access 被改动了");
    assert.deepEqual(am.config["api"], { type: "openai-chat-completions", baseUrl: GATEWAY_BASE });
    assert.deepEqual(am.config["personalModelIds"], MODELS);
    assert.deepEqual(am.config["modelOrder"], MODELS);
    // 逐模型启用项：清掉旧复合 id，补齐 3 个新模型
    const rules = after.config.modelConfigRules.providerModelRules;
    assert.deepEqual(
      rules.filter((r) => r.providerId !== "new-provider"),
      before.config.modelConfigRules.providerModelRules.filter((r) => r.providerId !== "new-provider"),
    );
    const mine = rules.filter((r) => r.providerId === "new-provider");
    assert.deepEqual(mine.map((r) => r.modelId).sort(), [...MODELS].sort());
    assert.ok(mine.every((r) => r.config["enabled"] === true));
  });

  it("幂等：二次运行无改动", () => {
    const file = seedZcode();
    integrateClient("zcode", MODELS);
    const once = readFileSync(file, "utf8");
    const second = integrateClient("zcode", MODELS);
    assert.equal(second.changed.length, 0, "二次运行不该再改文件");
    assert.deepEqual(second.unchanged, [file], "二次运行应报告已正确");
    assert.equal(readFileSync(file, "utf8"), once, "二次运行后内容变化");
  });

  it("配置不存在时报错（不静默创建）", () => {
    // 把 HOME 指向一个不存在的目录：写入器必须如实报错，而不是新建一份配置
    const ghost = join(home, "ghost-home");
    const savedProfile = process.env["USERPROFILE"];
    const savedHome = process.env["HOME"];
    process.env["USERPROFILE"] = ghost;
    process.env["HOME"] = ghost;
    try {
      const result = integrateClient("zcode", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /找不到 zcode 配置/);
      assert.equal(existsSync(join(ghost, ".zcode", "v2", "provider_config.json")), false, "不该创建配置文件");
    } finally {
      process.env["USERPROFILE"] = savedProfile ?? "";
      process.env["HOME"] = savedHome ?? "";
    }
  });
});

describe("一键接入 dsh", () => {
  it("只替换 models 块：其它 provider 与头部注释逐字节不变", () => {
    seedDsh();
    const desktop = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    const before = readFileSync(desktop, "utf8");
    const result = integrateClient("dsh", MODELS);
    assert.equal(result.ok, true);
    assert.ok(result.changed.includes(desktop));

    const after = readFileSync(desktop, "utf8");
    // 挖掉 models 块后必须完全一致（longcat 与其它条目不受影响）
    const strip = (t: string) => t.split("\n").filter((l) => !/^ {10}- id: /.test(l) && !/^ {12}(name|contextWindow|maxTokens|input|reasoningEfforts):/.test(l) && !/^ {14}- (text|image)/.test(l) && !/^ {12}"?off"?/.test(l));
    assert.deepEqual(strip(after), strip(before), "除 models 条目外还有变化");
    // 新块含 3 个对外模型
    for (const model of MODELS) assert.ok(after.includes(`- id: ${model}`), `缺少 ${model}`);
    // 头部注释保留
    assert.ok(after.startsWith("# 头部注释（必须保留）"), "头部注释丢失");
  });

  it("acp profile（空 patch）追加 provider 与 ACP 路由条目", () => {
    seedDsh();
    const acp = join(home, ".dsh", "profiles", "acp", "cordis.patch.yml");
    integrateClient("dsh", MODELS);
    const after = readFileSync(acp, "utf8");
    assert.ok(after.includes("- id: llm-pi-ai"), "缺 llm-pi-ai 条目");
    assert.ok(after.includes("- id: acp"), "缺 acp 路由条目");
    assert.ok(after.includes("provider: modelmux"), "ACP 路由没指到 modelmux");
    assert.ok(after.includes(`model: ${MODELS[0]}`), "ACP 路由没指到首个对外模型");
    assert.ok(after.includes("baseURL: http://127.0.0.1:4412/v1"), "baseURL 没写");
  });

  it("幂等：二次运行无改动", () => {
    seedDsh();
    integrateClient("dsh", MODELS);
    const desktop = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    const once = readFileSync(desktop, "utf8");
    const second = integrateClient("dsh", MODELS);
    assert.equal(second.changed.length, 0, "二次运行不该再改文件");
    assert.equal(readFileSync(desktop, "utf8"), once, "二次运行后内容变化");
  });

  it("profiles 目录不存在时报错", () => {
    const ghost = join(home, "ghost-home");
    const savedProfile = process.env["USERPROFILE"];
    const savedHome = process.env["HOME"];
    process.env["USERPROFILE"] = ghost;
    process.env["HOME"] = ghost;
    try {
      const result = integrateClient("dsh", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /找不到 dsh profiles 目录/);
    } finally {
      process.env["USERPROFILE"] = savedProfile ?? "";
      process.env["HOME"] = savedHome ?? "";
    }
  });
});
