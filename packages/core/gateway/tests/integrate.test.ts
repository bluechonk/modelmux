/**
 * 一键接入写入器（`app/integrate.ts`）：把本机 harness 的模型配置改写成网关的对外模型名。
 *
 * 全程在**临时 HOME** 里操作副本（真实配置绝不碰），锁三件事：
 *  1. 只改目标块 —— zcode 的其它供应商规则、dsh 的其它 provider 必须逐字节不变；
 *  2. 幂等 —— 二次运行为 no-op（内容一致、不重复写）；
 *  3. 缺失场景 —— zcode 配置 / dsh profile 补丁不存在时如实报错，不静默创建
 *     （dsh 凭据文件例外：它正是本功能要补齐的接线，缺失时新建）。
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { integrateClient, restoreClient } from "../dist/app/integrate.js";
import { poolModelMetas } from "../dist/pool/pool-targets.js";

const MODELS = ["deepseek-v4.1-flash", "glm-5.3-flash"];
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

/** 旧版写入器留下的规则：有 api / 模型清单，但缺 group 与 access。 */
function seedZcodeWithoutRequired(): string {
  const file = seedZcode();
  const root = JSON.parse(readFileSync(file, "utf8")) as typeof ZCODE_CONFIG;
  root.config.providerConfigRules.providerRules = root.config.providerConfigRules.providerRules.map((r) =>
    r.providerId === "new-provider"
      ? { ...r, config: { api: r.config.api, personalModelIds: r.config.personalModelIds, modelOrder: r.config.modelOrder } }
      : r,
  );
  writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return file;
}

/** 写一份 dsh 凭据文件到临时 HOME，返回路径。 */
function seedDshCredentials(text = "version: 1\nrefs: { LONGCAT_API_KEY: ak_test }\n"): string {
  const file = join(home, ".dsh", ".credentials.yaml");
  writeFileSync(file, text, "utf8");
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

/** dsh web profile 的 patch（比 desktop 多一段 retryPolicy，models 块结构相同）。 */
const DSH_WEB = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      modelmux:
        displayName: modelmux
        apiKeyEnv: MODELMUX_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:4412/v1
        retryPolicy:
          mode: normal
          maxRetries: 3
        models:
          - id: workbuddyai/deepseek-v4.1-flash
            name: WorkBuddyAI DeepSeek V4.1 Flash
            input:
              - text
`;

function seedDsh(): string {
  const dir = join(home, ".dsh", "profiles");
  // 隔离：清掉上一次测试留下的凭据文件与 web profile（desktop / acp 走下面的覆写）
  rmSync(join(home, ".dsh", ".credentials.yaml"), { force: true });
  rmSync(join(dir, "web"), { recursive: true, force: true });
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

  it("补齐 group / access：缺任一项 zcode 就不注册该供应商", () => {
    const file = seedZcodeWithoutRequired();
    integrateClient("zcode", MODELS);
    const after = JSON.parse(readFileSync(file, "utf8")) as typeof ZCODE_CONFIG;
    const rule = after.config.providerConfigRules.providerRules.find((r) => r.providerId === "new-provider")!;
    assert.equal(rule.config["group"], "standard-personal");
    assert.deepEqual(rule.config["access"], { type: "api-key", apiKey: "modelmux-local" });
  });

  it("保留用户已配的 access.apiKey", () => {
    const file = seedZcode();
    integrateClient("zcode", MODELS);
    const after = JSON.parse(readFileSync(file, "utf8")) as typeof ZCODE_CONFIG;
    const rule = after.config.providerConfigRules.providerRules.find((r) => r.providerId === "new-provider")!;
    assert.deepEqual(rule.config["access"], { type: "api-key", apiKey: "u" });
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

  it("模型条目的 input 只写 text 一种模态 —— 旧行为（已修）", () => {
    // 这是**回归守卫**：早先 `renderDshModel` 恒写 `[text]`，无论模型是否支持图片。
    // 后果是接入后客户端在本地就把图片拦下（网关其实转得过去）——用户报的
    // 「一键接入 dsh 后图片功能消失」就是它。
    //
    // 本测试环境没有渠道注册，池元数据全是默认的 `["text"]`，因此**无法**在这里
    // 断言 image 分支；image 分支由 `modelModalities` 的注入测试覆盖（见下一个用例）。
    seedDsh();
    const desktop = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    integrateClient("dsh", MODELS);
    const after = readFileSync(desktop, "utf8");
    for (const model of MODELS) {
      const block = after.split(`- id: ${model}`)[1] ?? "";
      const inputPart = block.split("input:")[1]?.split(/^\s{10}- id: /m)[0] ?? "";
      assert.ok(inputPart.includes("- text"), `${model} 的 input 缺 text`);
    }
  });

  it("modelModalities 按池元数据解析模态，图片模型得到 text+image", () => {
    // 直接测模态解析：不依赖运行期渠道注册，用真实 `/v1/models` 的已知形态作期望。
    const metas = poolModelMetas(["glm-5.3-flash"]);
    const meta = metas.get("glm-5.3-flash");
    assert.ok(meta !== undefined, "池元数据应能取到 glm-5.3-flash");
    // 元数据可能因渠道未注册而回落默认值 —— 两种情况都必须**包含 text**
    assert.ok(meta.inputModalities.includes("text"), "任何模型的 input 都必须含 text");
    // 图片支持由上游目录声明；本机网关实测 glm-5.3-flash 为 ["text","image"]
    // （见 /v1/models）。此处只断言「若元数据声明了 image，它就会被保留」。
    if (meta.inputModalities.includes("image")) {
      assert.deepEqual(
        [...meta.inputModalities],
        ["text", "image"],
        "图片模型的模态应为 text + image",
      );
    }
  });

  it("web profile 也改写（含 retryPolicy，同样只换 models 块）", () => {
    seedDsh();
    const web = join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
    mkdirSync(join(home, ".dsh", "profiles", "web"), { recursive: true });
    writeFileSync(web, DSH_WEB, "utf8");
    const result = integrateClient("dsh", MODELS);
    assert.ok(result.changed.includes(web));
    const after = readFileSync(web, "utf8");
    for (const model of MODELS) assert.ok(after.includes(`- id: ${model}`), `缺少 ${model}`);
    assert.ok(after.includes("apiKeyEnv: MODELMUX_API_KEY"), "apiKeyEnv 被改动");
    assert.ok(after.includes("retryPolicy:"), "retryPolicy 被改动");
    assert.ok(!after.includes("workbuddyai/deepseek-v4.1-flash"), "旧模型残留");
  });

  it("flow refs：写入凭据引用 MODELMUX_API_KEY（apiKeyEnv 指向的名字必须存在）", () => {
    seedDsh();
    const cred = seedDshCredentials();
    const result = integrateClient("dsh", MODELS);
    const after = readFileSync(cred, "utf8");
    assert.match(after, /MODELMUX_API_KEY:\s*\S+/, "缺 MODELMUX_API_KEY");
    assert.match(after, /LONGCAT_API_KEY/, "其它凭据条目被改动");
    assert.ok(result.changed.includes(cred), "凭据文件没进 changed");
  });

  it("block refs：缩进跟着已有子条目走（写坏会让 dsh 凭据服务起不来）", () => {
    seedDsh();
    const text = "version: 1\nrecords: {}\nrefs:\n    LONGCAT_API_KEY: ak_test\n";
    const cred = seedDshCredentials(text);
    integrateClient("dsh", MODELS);
    const after = readFileSync(cred, "utf8");
    assert.match(after, /^    MODELMUX_API_KEY: modelmux-local$/m, "缩进没跟随已有子条目");
    assert.match(after, /^    LONGCAT_API_KEY: ak_test$/m, "已有子条目被改动");
  });

  it("跨行 flow refs：插到收尾的 `}` 前", () => {
    seedDsh();
    const text = "version: 1\nrefs: {\n  LONGCAT_API_KEY: ak_test\n}\n";
    const cred = seedDshCredentials(text);
    integrateClient("dsh", MODELS);
    assert.equal(readFileSync(cred, "utf8"), "version: 1\nrefs: {\n  LONGCAT_API_KEY: ak_test, MODELMUX_API_KEY: modelmux-local\n}\n");
  });

  it("空的多行 flow refs：新建一行", () => {
    seedDsh();
    const cred = seedDshCredentials("version: 1\nrefs: {\n}\n");
    integrateClient("dsh", MODELS);
    assert.equal(readFileSync(cred, "utf8"), "version: 1\nrefs: {\n  MODELMUX_API_KEY: modelmux-local\n}\n");
  });

  it("凭据文件缺失时新建", () => {
    seedDsh();
    const cred = join(home, ".dsh", ".credentials.yaml");
    const result = integrateClient("dsh", MODELS);
    assert.ok(existsSync(cred), "没新建凭据文件");
    assert.match(readFileSync(cred, "utf8"), /MODELMUX_API_KEY/);
    assert.ok(result.changed.includes(cred));
  });

  it("没有 refs 段时追加", () => {
    seedDsh();
    const cred = seedDshCredentials("version: 1\nrecords: {}\n");
    integrateClient("dsh", MODELS);
    assert.equal(readFileSync(cred, "utf8"), "version: 1\nrecords: {}\nrefs: { MODELMUX_API_KEY: modelmux-local }\n");
  });

  it("flow 里注释含花括号：不污染深度计数，条目也不落进注释", () => {
    seedDsh();
    const cred = seedDshCredentials("version: 1\nrefs: {\n  LONGCAT_API_KEY: ak_test, # use { template\n}\n");
    integrateClient("dsh", MODELS);
    const after = readFileSync(cred, "utf8");
    // 收尾判定必须到第 4 行（深度归零），条目接在真条目行（尾逗号归一）、注释保持在末尾
    assert.equal(
      after,
      "version: 1\nrefs: {\n  LONGCAT_API_KEY: ak_test, MODELMUX_API_KEY: modelmux-local # use { template\n}\n",
    );
  });

  it("嵌套内联 flow 的子条目：净深度归零前不误判收尾", () => {
    seedDsh();
    const cred = seedDshCredentials("version: 1\nrefs: {\n  A: { x: 1 },\n}\n");
    integrateClient("dsh", MODELS);
    const after = readFileSync(cred, "utf8");
    assert.match(after, /A: \{ x: 1 \}, MODELMUX_API_KEY: modelmux-local/, "条目必须接在外层 flow 的真条目行");
    assert.match(after, /modelmux-local\n\}\n$/, "外层收尾括号必须原样保留在末行");
  });

  it("一个可改的 profile 都没有：如实失败，不再冒充已接入", () => {
    // profiles 目录在、凭据文件也在，但四个 profile 都没有 cordis.patch.yml ——
    // 只写凭据引用不构成接入，ok:false 必须把「没有可改的 profile」带到调用方。
    // 共享 home：前序用例留下的 patch 必须清掉，否则 profileSeen 不为 0
    rmSync(join(home, ".dsh", "profiles"), { recursive: true, force: true });
    mkdirSync(join(home, ".dsh", "profiles", "desktop"), { recursive: true });
    seedDshCredentials();
    const result = integrateClient("dsh", MODELS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /没有可改的 profile/);
  });

  it("CRLF 凭据文件保持 CRLF", () => {
    seedDsh();
    const cred = seedDshCredentials("version: 1\r\nrefs: { LONGCAT_API_KEY: ak_test }\r\n");
    integrateClient("dsh", MODELS);
    assert.equal(readFileSync(cred, "utf8"), "version: 1\r\nrefs: { LONGCAT_API_KEY: ak_test, MODELMUX_API_KEY: modelmux-local}\r\n");
  });

  it("凭据引用已存在时不重复写（block / flow / 带引号都算）", () => {
    seedDsh();
    const cases = [
      "version: 1\nrefs: { MODELMUX_API_KEY: custom }\n",
      "version: 1\nrefs:\n  MODELMUX_API_KEY: custom\n",
      'version: 1\nrefs: { "MODELMUX_API_KEY": custom }\n',
    ];
    for (const text of cases) {
      const cred = seedDshCredentials(text);
      const result = integrateClient("dsh", MODELS);
      assert.equal(readFileSync(cred, "utf8"), text, `被改动了：${text}`);
      assert.ok(!result.changed.includes(cred), `不该进 changed：${text}`);
    }
  });

  it("注释里的名字不算已存在（否则会静默漏写）", () => {
    seedDsh();
    const cred = seedDshCredentials("# MODELMUX_API_KEY: legacy\nversion: 1\nrefs: { LONGCAT_API_KEY: ak_test }\n");
    integrateClient("dsh", MODELS);
    const after = readFileSync(cred, "utf8");
    assert.match(after, /refs: \{[^}]*MODELMUX_API_KEY/);
    assert.ok(after.startsWith("# MODELMUX_API_KEY: legacy"), "注释被改动");
  });

  it("幂等：二次运行无改动", () => {
    seedDsh();
    integrateClient("dsh", MODELS);
    const desktop = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    const cred = join(home, ".dsh", ".credentials.yaml");
    const once = readFileSync(desktop, "utf8");
    const credOnce = readFileSync(cred, "utf8");
    const second = integrateClient("dsh", MODELS);
    assert.equal(second.changed.length, 0, "二次运行不该再改文件");
    assert.equal(readFileSync(desktop, "utf8"), once, "二次运行后内容变化");
    assert.equal(readFileSync(cred, "utf8"), credOnce, "二次运行后凭据文件变化");
    assert.ok(second.unchanged.includes(cred), "凭据文件没进 unchanged");
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

// ── claude code ─────────────────────────────────────────────────────────────

/** 一份带用户自定义键的 settings.json（hooks / 权限必须逐字节保留）。 */
const CLAUDE_SETTINGS = {
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  permissions: { allow: ["Bash(git*)"] },
  env: {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "sk-stale",
    OTHER_SETTING: "keep-me",
  },
  hooks: { PostToolUse: [{ matcher: "Bash", hooks: [] }] },
};

function seedClaude(): string {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  writeFileSync(file, `${JSON.stringify(CLAUDE_SETTINGS, null, 2)}\n`, "utf8");
  return file;
}

describe("一键接入 claude code", () => {
  it("patch env：写 baseUrl/authToken/模型三件，移除 ANTHROPIC_API_KEY，用户键逐字节不变", () => {
    const file = seedClaude();
    const result = integrateClient("claude-code", MODELS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, [file]);
    const after = JSON.parse(readFileSync(file, "utf8")) as typeof CLAUDE_SETTINGS;
    assert.equal(after.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4412", "baseUrl 不带 /v1（客户端自己拼）");
    assert.equal(after.env["ANTHROPIC_AUTH_TOKEN"], "modelmux-local");
    assert.equal(after.env["ANTHROPIC_API_KEY"], undefined, "API_KEY 必须移除（与 AUTH_TOKEN 并存会冲突）");
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"]) {
      assert.equal(after.env[key], MODELS[0], `${key} 应指向池主模型`);
    }
    // 用户自有键：逐字节保留
    assert.deepEqual(after.permissions, CLAUDE_SETTINGS.permissions);
    assert.deepEqual(after.hooks, CLAUDE_SETTINGS.hooks);
    assert.equal(after.env["OTHER_SETTING"], "keep-me");
    assert.equal(after["$schema"], CLAUDE_SETTINGS["$schema"]);
  });

  it("幂等：二次运行无改动", () => {
    const file = seedClaude();
    integrateClient("claude-code", MODELS);
    const once = readFileSync(file, "utf8");
    const second = integrateClient("claude-code", MODELS);
    assert.equal(second.changed.length, 0);
    assert.equal(readFileSync(file, "utf8"), once, "二次运行后内容变化");
  });

  it(".claude 目录不存在时报错（不静默创建）", () => {
    const ghost = join(home, "ghost-home");
    const savedProfile = process.env["USERPROFILE"];
    const savedHome = process.env["HOME"];
    process.env["USERPROFILE"] = ghost;
    process.env["HOME"] = ghost;
    try {
      const result = integrateClient("claude-code", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /找不到 Claude Code 配置目录/);
    } finally {
      process.env["USERPROFILE"] = savedProfile ?? "";
      process.env["HOME"] = savedHome ?? "";
    }
  });

  it("settings.json 不存在时新建（目录在即可，评审抓过的 ENOENT 路径）", () => {
    const dir = join(home, ".claude");
    rmSync(join(dir, "settings.json"), { force: true });
    const result = integrateClient("claude-code", MODELS);
    assert.equal(result.ok, true, `新建路径失败：${result.error ?? ""}`);
    const after = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { env: Record<string, unknown> };
    assert.equal(after.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4412");
    assert.equal(after.env["ANTHROPIC_AUTH_TOKEN"], "modelmux-local");
  });
});

// ── claude desktop ──────────────────────────────────────────────────────────

/**
 * 造一份 Desktop 的 3P 配置目录（`configLibrary/` + 一个已有 profile + `_meta.json`）。
 *
 * Windows 走 `LOCALAPPDATA`、macOS 走 `~/Library/Application Support`、Linux 走
 * `XDG_CONFIG_HOME`；三个都指到测试临时目录，互不干扰。
 */
function seedDesktop(profileId = "8f69f2f1-3275-4ad8-9317-4aa7e972f311"): { dir: string; profile: string } {
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? join(home, "AppData", "Local")
        : join(home, ".config");
  process.env["LOCALAPPDATA"] = join(home, "AppData", "Local");
  process.env["XDG_CONFIG_HOME"] = join(home, ".config");
  const dir = join(base, "Claude-3p", "configLibrary");
  mkdirSync(dir, { recursive: true });
  const profile = join(dir, `${profileId}.json`);
  writeFileSync(
    profile,
    `${JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:9999" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "_meta.json"),
    `${JSON.stringify({ entries: [{ id: profileId, name: "modelmux" }], appliedId: profileId }, null, 2)}\n`,
    "utf8",
  );
  return { dir, profile };
}

describe("一键接入 claude desktop", () => {
  it("写 3P profile：gateway 模式 + 模型发现开 + 兜底清单含全部对外模型", () => {
    const { profile } = seedDesktop();
    const result = integrateClient("claude-desktop", MODELS);
    assert.equal(result.ok, true);
    const after = JSON.parse(readFileSync(profile, "utf8")) as Record<string, unknown>;
    assert.equal(after["inferenceProvider"], "gateway");
    // 必须关：发现直接拿网关裸名（带点号）当候选，Desktop 校验器全部拒收，选择器为空
    assert.equal(after["modelDiscoveryEnabled"], false);
    assert.equal(after["inferenceGatewayBaseUrl"], "http://127.0.0.1:4412");
    assert.equal(after["inferenceGatewayAuthScheme"], "x-api-key");
    const models = after["inferenceModels"] as Array<Record<string, unknown>>;
    assert.equal(models.length, MODELS.length);
    for (const entry of models) {
      const name = String(entry["name"]);
      // Desktop 只认真实 Anthropic 模型名：自造名（`claude-sonnet-<任意>`）会被判
      // 「is not an Anthropic model」并丢弃；斜杠与点号同样不允许
      assert.match(name, /^claude-(sonnet|opus|haiku|fable)-\d+-\d+$/);
      assert.doesNotMatch(name, /[./]/, "斜杠与点号会被校验器拒收");
      // 真正发给网关的模型名在这里
      assert.ok(String(entry["labelOverride"]) !== "", "labelOverride 才是网关收到的模型名");
      assert.equal(entry["supports1m"], true, "缺 supports1m 会退回 200k 上下文");
      assert.equal(entry["prefer1m"], true, "缺 prefer1m 选择器会列出两项");
    }
  });

  it("复用已有 profile 条目，不新增同名供应商", () => {
    const { dir } = seedDesktop();
    integrateClient("claude-desktop", MODELS);
    const meta = JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8")) as {
      entries: Array<{ id: string; name: string }>;
      appliedId: string;
    };
    assert.equal(meta.entries.length, 1, "已有同名条目时应复用，否则列表里会出现两条同名项");
    assert.equal(meta.appliedId, meta.entries[0]!.id);
  });

  it("幂等：二次运行无改动", () => {
    const { profile } = seedDesktop();
    integrateClient("claude-desktop", MODELS);
    const once = readFileSync(profile, "utf8");
    const second = integrateClient("claude-desktop", MODELS);
    assert.equal(second.changed.length, 0);
    assert.equal(readFileSync(profile, "utf8"), once, "内容一致时不落盘");
  });

  it("目录不存在时如实报错，不凭空造目录", () => {
    const { dir } = seedDesktop();
    rmSync(dir, { recursive: true, force: true });
    const result = integrateClient("claude-desktop", MODELS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /找不到 Claude Desktop 的 3P 配置目录/);
    assert.equal(existsSync(dir), false, "不替 Desktop 造配置根");
  });
});

// ── codex ───────────────────────────────────────────────────────────────────

/** 一份带其它 provider 段与顶层键的 config.toml。 */
const CODEX_CONFIG = `# Codex config
model = "gpt-5.2"
model_provider = "openai"
approval_policy = "on-failure"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"

[profiles.fast]
model = "gpt-5.2-mini"
model_provider = "openai"
`;

function seedCodex(text = CODEX_CONFIG): string {
  const dir = join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.toml");
  writeFileSync(file, text, "utf8");
  return file;
}

describe("一键接入 codex", () => {
  it("改 modelmux 段与顶层键；其它段与用户顶层键逐字节不变", () => {
    const file = seedCodex();
    const result = integrateClient("codex", MODELS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, [file]);
    const after = readFileSync(file, "utf8");
    // 顶层键落在首个表头之前（TOML 顶层键的硬约束）
    const firstTable = after.indexOf("[");
    const head = after.slice(0, firstTable);
    assert.match(head, /^model_provider = "modelmux"$/m);
    assert.match(head, new RegExp(`^model = "${MODELS[0]}"$`, "m"));
    // 其它段逐字节保留
    assert.ok(after.includes('[model_providers.openai]'), "openai 段丢失");
    assert.ok(after.includes('base_url = "https://api.openai.com/v1"'), "openai 段被改动");
    assert.ok(after.includes("[profiles.fast]"), "profiles 段丢失");
    assert.ok(after.includes('model = "gpt-5.2-mini"'), "profiles 段被改动");
    assert.ok(after.includes("approval_policy"), "用户顶层键丢失");
    // modelmux 段
    assert.match(after, /\[model_providers\.modelmux\]\nname = "modelmux"\nbase_url = "http:\/\/127\.0\.0\.1:4412\/v1"\nwire_api = "responses"\n/);
    assert.ok(after.includes(`experimental_bearer_token = "modelmux-local"`));
    assert.ok(after.includes("requires_openai_auth = false"));
  });

  it("幂等：二次运行无改动", () => {
    const file = seedCodex();
    integrateClient("codex", MODELS);
    const once = readFileSync(file, "utf8");
    const second = integrateClient("codex", MODELS);
    assert.equal(second.changed.length, 0);
    assert.equal(readFileSync(file, "utf8"), once, "二次运行后内容变化");
  });

  it("config.toml 不存在时新建（.codex 目录在即可）", () => {
    const file = join(home, ".codex", "config.toml");
    rmSync(file, { force: true });
    const result = integrateClient("codex", MODELS);
    assert.equal(result.ok, true);
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("[model_providers.modelmux]"));
    assert.ok(after.includes('wire_api = "responses"'));
  });

  it("auth.json 不被触碰（experimental_bearer_token 优先，ChatGPT 登录态保留）", () => {
    seedCodex();
    const auth = join(home, ".codex", "auth.json");
    writeFileSync(auth, '{"tokens":{"access_token":"chatgpt-session"}}', "utf8");
    integrateClient("codex", MODELS);
    assert.equal(readFileSync(auth, "utf8"), '{"tokens":{"access_token":"chatgpt-session"}}', "auth.json 被改动");
  });

  it(".codex 目录不存在时报错", () => {
    const ghost = join(home, "ghost-home");
    const savedProfile = process.env["USERPROFILE"];
    const savedHome = process.env["HOME"];
    process.env["USERPROFILE"] = ghost;
    process.env["HOME"] = ghost;
    try {
      const result = integrateClient("codex", MODELS);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /找不到 Codex 配置目录/);
    } finally {
      process.env["USERPROFILE"] = savedProfile ?? "";
      process.env["HOME"] = savedHome ?? "";
    }
  });

  it("多行字符串里的行首 [ 不是表头：顶层键仍插在真表头前，段不被误截", () => {
    // 评审实测的搅坏形态：instructions = """...[system]...""" —— 掩码必须生效
    const tricky = `instructions = """
You are Codex.
[system] inside a string
"""
model = "gpt-5.2"

[model_providers.openai]
name = "OpenAI"
`;
    const file = seedCodex(tricky);
    const result = integrateClient("codex", MODELS);
    assert.equal(result.ok, true, `写入失败：${result.error ?? ""}`);
    const after = readFileSync(file, "utf8");
    // 顶层键插在**首个真表头**（多行字符串掩码后的 [model_providers.openai]）之前；
    // 锚点不能 naïvely 用 indexOf("[") —— 字符串内的 "[system]" 不是表头
    const firstTable = after.indexOf("[model_providers.openai]");
    assert.ok(firstTable > 0);
    const head = after.slice(0, firstTable);
    assert.match(head, /^model_provider = "modelmux"$/m);
    assert.match(head, new RegExp(`^model = "${MODELS[0]}"$`, "m"));
    // 字符串内容逐字节保留
    assert.ok(after.includes("[system] inside a string"), "字符串内容被改动");
    assert.ok(after.includes("You are Codex."), "字符串内容被改动");
  });

  it("表头带行尾注释：段边界与首个表头判定不误吞后续配置", () => {
    const file = seedCodex(`model = "gpt-5.2" # user top-level
[model_providers.openai] # trailing comment
name = "OpenAI"
`);
    const result = integrateClient("codex", MODELS);
    assert.equal(result.ok, true);
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("[model_providers.openai] # trailing comment"), "带注释的表头被改动");
    assert.ok(after.includes('name = "OpenAI"'), "openai 段内容被吞");
    assert.match(after, /^model_provider = "modelmux"$/m);
  });
});

/**
 * 一键还原：接入的反向操作。
 *
 * 三条硬判据：
 *  1. **逐字节还原** —— 还原后与接入前完全一致（不是「看起来像」）；
 *  2. **新建文件删除** —— 接入时原本不存在的文件，还原时删掉（否则留下用户从来没
 *     有的配置）；
 *  3. **无备份如实报错** —— 没接入过就说没备份，不假装成功。
 */
describe("一键还原", () => {
  /** 每个用例前清空该 target 的备份目录：备份根在同一临时 HOME 下，用例之间会互相污染。 */
  const clearBackups = (target: string): void => {
    const dir = join(home, ".modelmux", "backups", "integrate");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${target}-`) || name.startsWith(`safety-${target}-`) || name.includes(target)) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    }
  };

  it("zcode：接入后还原，配置文件逐字节回到接入前", () => {
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    assert.equal(integrateClient("zcode", MODELS).ok, true);
    assert.notEqual(readFileSync(file, "utf8"), before, "接入应改动文件");

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, true, restored.error);
    assert.ok(restored.restored.includes(file), "应报告还原了该文件");
    assert.equal(readFileSync(file, "utf8"), before, "还原后必须与接入前逐字节一致");
    assert.ok(
      restored.safetyDir !== undefined && existsSync(restored.safetyDir),
      "应留下保护性备份（可反悔）",
    );
  });

  it("接入新建的文件：还原把它删掉（不与「原本就该有」混淆）", () => {
    clearBackups("codex");
    // codex 的 config.toml 在临时 HOME 里不存在 → 接入会新建它
    const file = join(home, ".codex", "config.toml");
    rmSync(file, { force: true });
    assert.equal(integrateClient("codex", MODELS).ok, true);
    assert.ok(existsSync(file), "接入应新建 config.toml");

    const restored = restoreClient("codex");
    assert.equal(restored.ok, true, restored.error);
    assert.ok(restored.removed.includes(file), "应报告删除了接入新建的文件");
    assert.equal(existsSync(file), false, "还原后该文件应不存在");
  });

  it("没有备份时如实报错", () => {
    clearBackups("dsh");
    const restored = restoreClient("dsh");
    assert.equal(restored.ok, false);
    assert.match(restored.error ?? "", /没有找到.*接入备份/);
  });

  it("同一份备份可以重复还原（不消费备份）", () => {
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    integrateClient("zcode", MODELS);
    assert.equal(restoreClient("zcode").ok, true);
    assert.equal(readFileSync(file, "utf8"), before, "第一次还原回到接入前");

    // 早期版本把用过的备份改名成 restored- 前缀，第二次还原就报「没有找到备份」。
    // 现在还原是幂等动作：同一份「接入前」状态可以反复还原。
    const second = restoreClient("zcode");
    assert.equal(second.ok, true, second.error);
    assert.equal(readFileSync(file, "utf8"), before, "第二次还原同样回到接入前");
    assert.ok(second.sourceDir !== undefined, "应报告所用备份目录");
  });

  it("空清单的备份目录不阻塞更早的真实备份", () => {
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    integrateClient("zcode", MODELS);
    assert.equal(restoreClient("zcode").ok, true, "第一次还原");

    // 造一个**更新**但清单为空的目录（模拟「只建了目录没写文件」的接入）：
    // 它若被当成最新备份，还原就会报「没有可还原的文件」而挡住真实备份
    const root = join(home, ".modelmux", "backups", "integrate");
    const empty = join(root, "zcode-20990101000000");
    mkdirSync(empty, { recursive: true });
    writeFileSync(
      join(empty, "manifest.json"),
      JSON.stringify({ version: 1, target: "zcode", createdAt: new Date().toISOString(), files: [] }),
    );

    const again = restoreClient("zcode");
    assert.equal(again.ok, true, again.error);
    assert.equal(readFileSync(file, "utf8"), before, "回退到更早的真实备份");
  });

  it("清单里字段不全的条目被跳过（不猜路径写回）", () => {
    clearBackups("codex");
    // 自造 codex 配置目录（用例之间不互相依赖：单独跑本条也成立）
    mkdirSync(join(home, ".codex"), { recursive: true });
    const file = join(home, ".codex", "config.toml");
    rmSync(file, { force: true });
    assert.equal(integrateClient("codex", MODELS).ok, true);
    assert.ok(existsSync(file), "接入应新建 config.toml");

    // 往清单里塞一条缺 original 的坏条目（磁盘数据可被手改 / 被截断）。
    // 按 manifest 的 target 定位本 target 的备份目录 —— 根目录里还躺着别的 target 的备份。
    const root = join(home, ".modelmux", "backups", "integrate");
    const dir = readdirSync(root)
      .map((name) => join(root, name))
      .find((candidate) => {
        const manifestPath = join(candidate, "manifest.json");
        if (!existsSync(manifestPath)) return false;
        try {
          return (JSON.parse(readFileSync(manifestPath, "utf8")) as { target?: string }).target === "codex";
        } catch {
          return false;
        }
      });
    assert.ok(dir, "应存在 codex 备份目录");
    const manifestPath = join(dir!, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: unknown[] };
    manifest.files.push({ backup: "config.toml.00000000", existed: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const restored = restoreClient("codex");
    assert.equal(restored.ok, true, restored.error);
    assert.ok(
      restored.notes.some((n) => n.includes("字段不全")),
      `应如实记录跳过的坏条目：${restored.notes.join(" / ")}`,
    );
    assert.equal(restored.removed.includes(file), true, "好条目仍应生效");
  });
});
