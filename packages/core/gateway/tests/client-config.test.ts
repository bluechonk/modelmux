/**
 * mx connect 的配置改写回归：claude settings.json 的 env upsert 与 CCR 残留清理、
 * codex config.toml 的文本级段 upsert、备份与 --restore 回滚、zcode 只读检查。
 * 全部走注入的临时 home，不碰真实用户配置。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  checkZcode,
  connectClaude,
  connectCodex,
  restoreClient,
} from "../dist/runtime/client-config.js";

let home = "";
let root = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mx-connect-home-"));
  root = mkdtempSync(join(tmpdir(), "mx-connect-root-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function claudeSettings(): string {
  return join(home, ".claude", "settings.json");
}

function codexConfig(): string {
  return join(home, ".codex", "config.toml");
}

describe("mx connect claude", () => {
  beforeEach(() => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeSettings(),
      JSON.stringify({
        apiKeyHelper: "C:\\...\\claude-code-router\\bin\\key.cmd",
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_MODEL: "modelmux/loomy/deepseek-v4.1-flash[1m]",
          CCR_CLAUDE_CODE_MODEL: "x",
          CODEXL_CLAUDE_CODE_MODEL: "y",
        },
        model: "anthropic/claude-ccr-h6d6f64656c6d75782f6361747061772f6c6f6e676361742d322e30",
        theme: "dark",
      }),
      "utf8",
    );
  });

  it("env 三处 URL 切到网关、AUTH_TOKEN 占位、CCR 残留与编码 model 清除", () => {
    const outcome = connectClaude({ home, baseUrl: "http://127.0.0.1:4412", root });
    assert.ok(outcome.backupPath && existsSync(outcome.backupPath!), "有备份");
    const s = JSON.parse(readFileSync(claudeSettings(), "utf8")) as Record<string, unknown>;
    const env = s["env"] as Record<string, string>;
    assert.equal(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4412");
    assert.equal(env["ANTHROPIC_API_BASE_URL"], "http://127.0.0.1:4412");
    assert.equal(env["CLAUDE_AGENT_API_BASE_URL"], "http://127.0.0.1:4412");
    assert.equal(env["ANTHROPIC_AUTH_TOKEN"], "modelmux");
    assert.equal(env["CCR_CLAUDE_CODE_MODEL"], undefined);
    assert.equal(env["CODEXL_CLAUDE_CODE_MODEL"], undefined);
    assert.equal(env["ANTHROPIC_MODEL"], "modelmux/loomy/deepseek-v4.1-flash[1m]", "未显式给 --model 时保留既有值");
    assert.equal(s["apiKeyHelper"], undefined, "CCR apiKeyHelper 删除");
    assert.equal(s["model"], undefined, "CCR 编码 model id 删除");
    assert.equal(s["theme"], "dark", "无关键不动");
  });

  it("--model 显式覆盖 ANTHROPIC_MODEL；幂等重跑零改动", () => {
    connectClaude({ home, baseUrl: "http://127.0.0.1:4412", model: "catpaw/longcat-2.0", root });
    const env = (JSON.parse(readFileSync(claudeSettings(), "utf8")) as Record<string, unknown>)["env"] as Record<string, string>;
    assert.equal(env["ANTHROPIC_MODEL"], "catpaw/longcat-2.0");
    const again = connectClaude({ home, baseUrl: "http://127.0.0.1:4412", model: "catpaw/longcat-2.0", root });
    assert.equal(again.changes.length, 0, "幂等：第二次无改动");
  });

  it("--restore 从最新备份恢复原配置", () => {
    connectClaude({ home, baseUrl: "http://127.0.0.1:4412", root });
    const done = restoreClient("claude", root, home);
    assert.ok(done, "有备份可恢复");
    const s = JSON.parse(readFileSync(claudeSettings(), "utf8")) as Record<string, unknown>;
    assert.equal((s["env"] as Record<string, string>)["ANTHROPIC_BASE_URL"], "http://127.0.0.1:3456", "恢复到 CCR 原值");
  });

  it("配置不存在时报错而非静默创建", () => {
    rmSync(claudeSettings());
    assert.throws(() => connectClaude({ home, baseUrl: "http://127.0.0.1:4412", root }), /未找到/);
  });
});

describe("mx connect codex", () => {
  beforeEach(() => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexConfig(),
      [
        'model_provider = "claude-code-router"',
        'model = "modelmux/loomy/deepseek-v4.1-flash"',
        'model_catalog_json = "C:\\\\Users\\\\x\\\\ccr-model-catalog.json"',
        "",
        "[model_providers.claude-code-router]",
        'name = "Claude Code Router"',
        'base_url = "http://127.0.0.1:3456/v1"',
        'wire_api = "responses"',
      ].join("\n"),
      "utf8",
    );
  });

  it("provider 切换 + 段 upsert + catalog 指向网关生成文件", () => {
    const outcome = connectCodex({
      home,
      baseUrl: "http://127.0.0.1:4412",
      catalogPath: "C:\\Users\\x\\.modelmux\\codex-model-catalog.json",
      root,
    });
    assert.ok(outcome.backupPath);
    const text = readFileSync(codexConfig(), "utf8");
    assert.match(text, /^model_provider = "modelmux"$/m);
    assert.match(text, /model_catalog_json = "C:\\\\Users\\\\x\\\\\.modelmux\\\\codex-model-catalog\.json"/m);
    assert.match(text, /\[model_providers\.modelmux\]\nname = "modelmux"\nbase_url = "http:\/\/127\.0\.0\.1:4412\/v1"\nwire_api = "responses"/);
    assert.ok(text.includes("[model_providers.claude-code-router]"), "旧段保留（用户可切回）");
  });

  it("重复 connect 幂等（零改动）；--restore 恢复原配置", () => {
    connectCodex({ home, baseUrl: "http://127.0.0.1:4412", catalogPath: "C:\\c.json", root });
    const again = connectCodex({ home, baseUrl: "http://127.0.0.1:4412", catalogPath: "C:\\c.json", root });
    assert.equal(again.changes.length, 0, "幂等");
    const done = restoreClient("codex", root, home);
    assert.ok(done);
    const text = readFileSync(codexConfig(), "utf8");
    assert.match(text, /^model_provider = "claude-code-router"$/m);
  });
});

describe("mx connect zcode（只读）", () => {
  it("已接入的供应商被识别且文件零改动", () => {
    const dir = join(home, ".zcode", "v2");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "provider_config.json");
    const original = JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId: "new-provider", config: { api: { baseUrl: "http://127.0.0.1:4412/v1" } } }] } },
    });
    writeFileSync(path, original, "utf8");
    const outcome = checkZcode(home, "http://127.0.0.1:4412");
    assert.match(outcome.guide[0]!, /已指向本网关/);
    assert.equal(readFileSync(path, "utf8"), original, "文件零改动");
  });

  it("未接入时给桌面端操作指引", () => {
    const outcome = checkZcode(home, "http://127.0.0.1:4412");
    assert.match(outcome.guide.join("\n"), /桌面端/);
  });
});
