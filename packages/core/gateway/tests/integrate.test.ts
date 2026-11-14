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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { integrateClient, restoreClient } from "../dist/app/integrate.js";
import { poolModelMetas } from "../dist/pool/pool-targets.js";

const MODELS = ["deepseek-v4.1-flash", "qwen3.8-flash"];
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
    const metas = poolModelMetas(["deepseek-v4.1-flash"]);
    const meta = metas.get("deepseek-v4.1-flash");
    assert.ok(meta !== undefined, "池元数据应能取到 deepseek-v4.1-flash");
    // 元数据可能因渠道未注册而回落默认值 —— 两种情况都必须**包含 text**
    assert.ok(meta.inputModalities.includes("text"), "任何模型的 input 都必须含 text");
    // 图片支持由上游目录声明；本机网关实测 deepseek-v4.1-flash 为 ["text","image"]
    // （见 /v1/models）。此处只断言「若元数据声明了 image，它就会被保留」。
    if (meta.inputModalities.includes("image")) {
      assert.deepEqual(
        [...meta.inputModalities],
        ["text", "image"],
        "图片模型的模态应为 text + image",
      );
    }
  });

  it("凭据文件原本不存在：接入新建它，还原必须把它删掉", () => {
    // `seedDsh` 会清掉 `.credentials.yaml`，所以这里就是「用户从没配过 dsh 凭据」。
    seedDsh();
    const cred = join(home, ".dsh", ".credentials.yaml");
    assert.equal(existsSync(cred), false, "测试前提：凭据文件应不存在");

    const result = integrateClient("dsh", MODELS);
    assert.equal(result.ok, true);
    assert.equal(existsSync(cred), true, "接入应新建凭据文件");
    assert.ok(
      readFileSync(cred, "utf8").includes("MODELMUX_API_KEY"),
      "新建的凭据文件应含 apiKeyEnv 指向的引用",
    );

    // 还原：这个文件是接入的产物，不该留在用户目录里
    const restored = restoreClient("dsh");
    assert.equal(restored.ok, true);
    assert.equal(
      existsSync(cred),
      false,
      "还原应删掉接入新建的凭据文件 —— 否则 ~/.dsh 下永久残留一个用户从没有过的文件",
    );
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

/** 该 target 最近一次的接入备份目录（按 manifest 的 target 字段定位）。 */
function findBackupDir(target: string): string {
  const root = join(home, ".modelmux", "backups", "integrate");
  const dir = readdirSync(root)
    .map((name) => join(root, name))
    .find((candidate) => {
      const manifestPath = join(candidate, "manifest.json");
      if (!existsSync(manifestPath)) return false;
      try {
        return (JSON.parse(readFileSync(manifestPath, "utf8")) as { target?: string }).target === target;
      } catch {
        return false;
      }
    });
  assert.ok(dir, `应存在 ${target} 备份目录`);
  return dir!;
}

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
  /**
   * 摘除式终态断言：还原后配置里**不应有任何 modelmux 供应商痕迹**，
   * 且用户的第三方供应商（longcat / DeepSeek）原样保留。
   */
  const assertStripped = (file: string): void => {
    const root = JSON.parse(readFileSync(file, "utf8")) as {
      config?: { providerConfigRules?: { providerRules?: Array<Record<string, unknown>> }, providerOrder?: string[], modelConfigRules?: { providerModelRules?: Array<Record<string, unknown>> } },
    };
    const rules = root.config?.providerConfigRules?.providerRules ?? [];
    const dump = JSON.stringify(rules);
    assert.ok(
      !rules.some((r) => r.providerId === "new-provider" || r.providerName === "modelmux"),
      "不应残留 modelmux 供应商规则; rules=" + dump,
    );
    const order = root.config?.providerOrder ?? [];
    assert.ok(!order.includes("new-provider"), "providerOrder 不应残留 modelmux");
    const modelRules = root.config?.modelConfigRules?.providerModelRules ?? [];
    assert.ok(!modelRules.some((r) => r.providerId === "new-provider"), "不应残留 modelmux 的模型启用规则");
    assert.ok(
      rules.some((r) => r.providerId === "deepseek"),
      "第三方供应商应原样保留; rules=" + dump,
    );
    assert.ok(
      modelRules.some((r) => r.providerId === "new-provider-2"),
      "第三方模型的启用规则应原样保留",
    );
  };

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
    assert.ok(restored.restored.includes(file), "应报告还原了该文件");
    // 摘除式语义：备份内容是接入态，还原 = 用户配置回来 + 接入痕迹摘除
    //（不是逐字节回放备份）—— 关闭后客户端不再指向网关。
    assertStripped(file);
    assert.ok(
      restored.safetyDir !== undefined && existsSync(restored.safetyDir),
      "应留下保护性备份（可反悔）",
    );
  });

  it("没有备份时如实报错", () => {
    clearBackups("dsh");
    const restored = restoreClient("dsh");
    assert.equal(restored.ok, false);
    assert.match(restored.error ?? "", /没有找到.*接入备份/);
  });

  it("dsh：接入后还原，patch 摘除 modelmux 段与 acp 条目、其它条目原样保留", () => {
    clearBackups("dsh");
    seedDsh();
    assert.equal(integrateClient("dsh", MODELS).ok, true, "接入 dsh");
    const desktop = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    const acpFile = join(home, ".dsh", "profiles", "acp", "cordis.patch.yml");
    assert.equal(restoreClient("dsh").ok, true);

    const desktopText = readFileSync(desktop, "utf8");
    assert.ok(!desktopText.includes("modelmux:"), "desktop patch 不应残留 modelmux 供应商段");
    assert.ok(!desktopText.includes("baseURL: http://127.0.0.1:4412"), "desktop patch 不应残留网关地址");
    assert.ok(desktopText.includes("llm-pi-ai"), "llm-pi-ai 条目保留（fixture 预置）");
    assert.ok(desktopText.includes("ui-chat"), "ui-chat 条目原样保留");
    assert.ok(!existsSync(acpFile) || !readFileSync(acpFile, "utf8").includes("modelmux"), "acp patch 不应残留 modelmux");
  });

  it("同一份备份可以重复还原（不消费备份）", () => {
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    integrateClient("zcode", MODELS);
    assert.equal(restoreClient("zcode").ok, true);
    assertStripped(file);

    // 早期版本把用过的备份改名成 restored- 前缀，第二次还原就报「没有找到备份」。
    // 现在还原是幂等动作：同一份「接入前」状态可以反复还原。
    const second = restoreClient("zcode");
    assert.equal(second.ok, true, second.error);
    assertStripped(file);
    assert.ok(second.sourceDir !== undefined, "应报告所用备份目录");
  });

  it("重复接入（清单同步）后还原，仍逐字节回到接入前（不是回到接入态）", () => {
    // 2026-11-14 实拍确认的「假关闭」：已接入态下再点接入 / 自动同步模型清单，
    // 旧版会把**当前接入态**备份成新的 <target>-* —— 它时间戳最新，成为还原源，
    // 还原等于把接入态写回去：开关关了、客户端却仍指向网关。
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    assert.equal(integrateClient("zcode", MODELS).ok, true, "第一次接入");
    const afterFirst = readFileSync(file, "utf8");
    // 第二次用**不同的**对外清单（模拟模型池变更后的自动同步）——写入内容确实变化
    assert.equal(integrateClient("zcode", [MODELS[0]!]).ok, true, "重复接入（同步）");
    assert.notEqual(readFileSync(file, "utf8"), afterFirst, "清单同步应改写文件");

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, true, restored.error);
    assertStripped(file);
    assert.ok(!restored.error, "清单同步后的还原同样要摘干净");
  });

  // 摘除式语义下不再有「假备份」概念：任何一份 <target>-* 备份都是合法还原源
  //（备份内容是接入态也没关系 —— 终态由「还原 + 摘除」决定，与选哪份无关）。

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
    assertStripped(file);
  });

  it("清单里字段不全的条目被跳过（不猜路径写回）", () => {
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    assert.equal(integrateClient("zcode", MODELS).ok, true);
    assert.notEqual(readFileSync(file, "utf8"), before, "接入应改写配置");

    // 往清单里塞一条缺 original 的坏条目（磁盘数据可被手改 / 被截断）。
    // 按 manifest 的 target 定位本 target 的备份目录 —— 根目录里还躺着别的 target 的备份。
    const dir = findBackupDir("zcode");
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: unknown[] };
    manifest.files.push({ backup: "provider_config.json.00000000", existed: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, true, restored.error);
    assert.ok(
      restored.notes.some((n) => n.includes("字段不全")),
      `应如实记录跳过的坏条目：${restored.notes.join(" / ")}`,
    );
    assert.equal(restored.restored.includes(file), true, "好条目仍应生效");
    assertStripped(file);
  });

  it("备份文件缺失时还原如实报失败（不假装成功）", () => {
    clearBackups("zcode");
    seedZcode();
    assert.equal(integrateClient("zcode", MODELS).ok, true);

    const dir = findBackupDir("zcode");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      files: Array<{ backup: string }>;
    };
    const entry = manifest.files.find((f) => f.backup.startsWith("provider_config.json"));
    assert.ok(entry, "清单里应有 provider_config.json 条目");
    rmSync(join(dir, entry!.backup), { force: true });

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, false, "备份文件缺失必须报失败");
    assert.match(restored.error ?? "", /还原失败/);
    assert.ok(
      restored.notes.some((n) => n.includes("备份文件缺失")),
      `应记录缺失的备份文件：${restored.notes.join(" / ")}`,
    );
  });

  it("清单损坏时如实记 notes（还原走反推，不静默降级）", () => {
    clearBackups("zcode");
    const file = seedZcode();
    const before = readFileSync(file, "utf8");
    assert.equal(integrateClient("zcode", MODELS).ok, true);

    const dir = findBackupDir("zcode");
    writeFileSync(join(dir, "manifest.json"), "{ 不是合法 JSON", "utf8");

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, true, restored.error);
    assert.ok(
      restored.notes.some((n) => n.includes("备份清单解析失败")),
      `应如实记录清单损坏：${restored.notes.join(" / ")}`,
    );
    // 反推要回到原路径（清单坏了也不能把内容写到别处）
    assertStripped(file);
  });

  it("空清单的备份目录也留原因：不说「没有备份」的假话", () => {
    clearBackups("zcode");
    const root = join(home, ".modelmux", "backups", "integrate");
    const empty = join(root, "zcode-20990101000000");
    mkdirSync(empty, { recursive: true });
    writeFileSync(
      join(empty, "manifest.json"),
      JSON.stringify({ version: 1, target: "zcode", createdAt: new Date().toISOString(), files: [] }),
    );

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, false);
    assert.match(restored.error ?? "", /候选目录不可用/);
    assert.match(restored.error ?? "", /清单为空或没有可还原条目/);
  });

  it("清单 target 与请求不符时跳过该目录，并在 error 里说明原因", () => {
    clearBackups("zcode");
    seedZcode();
    assert.equal(integrateClient("zcode", MODELS).ok, true);

    // 手工改清单 target 模拟「别家备份被挪进来」
    const dir = findBackupDir("zcode");
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { target: string };
    manifest.target = "dsh";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const restored = restoreClient("zcode");
    assert.equal(restored.ok, false, "唯一备份被跳过 → 没有可用源");
    assert.match(restored.error ?? "", /候选目录不可用/);
    assert.match(restored.error ?? "", /target 是 dsh/);
  });
});
