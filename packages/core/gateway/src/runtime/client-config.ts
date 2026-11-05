/**
 * 客户端配置一键接入（`mx connect`）：把 Claude Code / Codex 的 API 指向本网关，
 * 替代 CCR 的 profile 改写能力。zcode 只读检查 —— 桌面端持 provider_config.json 的
 * 内存副本，脚本写会互相覆盖（zcode-mx-test 技能红线），只能给桌面端操作指引。
 *
 * 约束：每次 connect 前把原配置备份到 `<root>/backups/connect/`，`--restore` 从最新
 * 备份恢复；所有函数接受显式 home 根（生产 = os.homedir()，测试注入临时目录）。
 * codex 的 config.toml 用**文本级 upsert**（段头锚定），不引入 TOML 解析依赖
 * （共享层零运行依赖契约）。
 *
 * 文档：docs/CLIENT-INTEGRATION.md
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 一次接入的变更摘要；`from`/`to` 不回显敏感值（token 类只报键名）。 */
export interface ConnectChange {
  key: string;
  from?: string;
  to?: string;
}

export interface ConnectOutcome {
  client: "claude" | "codex" | "zcode";
  backupPath?: string;
  changes: ConnectChange[];
  guide: string[];
}

function backupDir(root: string): string {
  return join(root, "backups", "connect");
}

function stampBackup(root: string, src: string, client: string): string {
  const dir = backupDir(root);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${client}-${new Date().toISOString().replace(/[:.]/g, "-")}${src.slice(src.lastIndexOf("."))}`);
  copyFileSync(src, target);
  return target;
}

/** 从备份目录（存储根）找某客户端的最新备份，恢复到该客户端在 home 下的原位。 */
export function restoreClient(
  client: "claude" | "codex",
  root: string,
  home: string,
): { restored: string; target: string } | null {
  const dir = backupDir(root);
  if (!existsSync(dir)) return null;
  const latest = readdirSync(dir)
    .filter((f) => f.startsWith(`${client}-`))
    .sort()
    .at(-1);
  if (!latest) return null;
  const source = join(dir, latest);
  const target = latest.includes(".toml")
    ? join(home, ".codex", "config.toml")
    : join(home, ".claude", "settings.json");
  mkdirSync(target.slice(0, target.lastIndexOf("\\")), { recursive: true });
  copyFileSync(source, target);
  return { restored: source, target };
}

// ── Claude Code（~/.claude/settings.json）───────────────────────────────────

interface ClaudeSettings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

const CCR_MODEL_ID = /^anthropic\/claude-ccr-h[0-9a-f]+$/;

export function connectClaude(options: {
  home: string;
  baseUrl: string;
  /** 显式指定 ANTHROPIC_MODEL；缺省保留既有值，两者皆无则删键交给路由层兜底。 */
  model?: string;
  root: string;
}): ConnectOutcome {
  const { home, baseUrl, root } = options;
  const settingsPath = join(home, ".claude", "settings.json");
  const changes: ConnectChange[] = [];
  if (!existsSync(settingsPath)) {
    throw new Error(`未找到 ${settingsPath} —— 先运行一次 claude 让它生成配置`);
  }
  const original = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(original) as ClaudeSettings;
  const env = (settings.env ??= {});

  const set = (key: string, value: string): void => {
    if (env[key] === value) return;
    changes.push({ key, from: env[key], to: value });
    env[key] = value;
  };
  for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL", "CLAUDE_AGENT_API_BASE_URL"]) {
    set(key, baseUrl);
  }
  // 占位 token：网关无鉴权，但 claude code 需要 auth 环境才发请求；固定值便于识别来源
  set("ANTHROPIC_AUTH_TOKEN", "modelmux");
  if (options.model) set("ANTHROPIC_MODEL", options.model);

  // CCR 残留清理：指向 CCR 安装目录的键在切走后失效，留着会让请求旁路或启动报错
  const helper = settings["apiKeyHelper"];
  if (typeof helper === "string" && helper.toLowerCase().includes("claude-code-router")) {
    changes.push({ key: "apiKeyHelper", from: "<CCR apiKeyHelper>" });
    delete settings["apiKeyHelper"];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("CCR_") || key.startsWith("CODEXL_")) {
      changes.push({ key, from: "<CCR 残留>" });
      delete env[key];
    }
  }
  if (typeof settings["model"] === "string" && CCR_MODEL_ID.test(settings["model"])) {
    changes.push({ key: "model", from: "<CCR 编码模型 id>" });
    delete settings["model"];
  }

  // 幂等重跑零改动时不备份：--restore 必须恢复到「切换前」的状态，切换后的
  // 快照混进备份会让最新备份失去回滚意义（实测抓过）
  if (changes.length === 0) {
    return { client: "claude", changes, guide: ["配置已是最新，无改动"] };
  }
  const backupPath = stampBackup(root, settingsPath, "claude");
  mkdirSync(settingsPath.slice(0, settingsPath.lastIndexOf("\\")), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return {
    client: "claude",
    backupPath,
    changes,
    guide: ["模型发现已开启（CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY）时 claude 会自动拉取模型清单"],
  };
}

// ── Codex（~/.codex/config.toml）────────────────────────────────────────────

/**
 * config.toml 的文本级 upsert：顶层标量行替换（无则插在首个段头之前），
 * `[model_providers.modelmux]` 段整段重写（段头锚定，不解析 TOML）。
 */
export function connectCodex(options: {
  home: string;
  baseUrl: string;
  /** 显式指定 model；缺省保留既有值。 */
  model?: string;
  catalogPath: string;
  root: string;
}): ConnectOutcome {
  const { home, baseUrl, catalogPath, root } = options;
  const configPath = join(home, ".codex", "config.toml");
  const changes: ConnectChange[] = [];
  if (!existsSync(configPath)) {
    throw new Error(`未找到 ${configPath} —— 先运行一次 codex 让它生成配置`);
  }
  let text = readFileSync(configPath, "utf8");

  const upsertTopLevel = (key: string, value: string): void => {
    const line = new RegExp(`^${key} = ".*"$`, "m");
    const match = line.exec(text);
    if (match) {
      if (match[0] === `${key} = "${value}"`) return;
      changes.push({ key, from: match[0], to: `${key} = "${value}"` });
      text = text.replace(line, `${key} = "${value}"`);
      return;
    }
    changes.push({ key, to: value });
    const firstSection = text.search(/^\[/m);
    text = firstSection >= 0
      ? text.slice(0, firstSection) + `${key} = "${value}"\n\n` + text.slice(firstSection)
      : `${text.replace(/\n*$/, "\n")}\n${key} = "${value}"\n`;
  };

  upsertTopLevel("model_provider", "modelmux");
  if (options.model) upsertTopLevel("model", options.model);
  upsertTopLevel("model_catalog_json", catalogPath.replace(/\\/g, "\\\\"));

  // [model_providers.modelmux] 段：锚定段头与下一个段头之间整段替换 / 末尾追加
  const sectionHeader = "[model_providers.modelmux]";
  const sectionPattern = /\n\[model_providers\.modelmux\]\n[\s\S]*?(?=\n\[|\s*$)/;
  const section = [
    "",
    sectionHeader,
    'name = "modelmux"',
    `base_url = "${baseUrl}/v1"`,
    'wire_api = "responses"',
    "",
  ].join("\n");
  if (sectionPattern.test(text)) {
    const before = text.match(sectionPattern)![0];
    if (before.trim() !== section.trim()) {
      changes.push({ key: "[model_providers.modelmux]", from: "<既有段落>", to: "<段落重写>" });
      text = text.replace(sectionPattern, section);
    }
  } else {
    changes.push({ key: "[model_providers.modelmux]", to: "新增段落" });
    text = text.replace(/\n*$/, "\n") + section;
  }

  // 幂等重跑零改动时不备份（与 connectClaude 同因：--restore 要恢复到切换前）
  if (changes.length === 0) {
    return { client: "codex", changes, guide: ["配置已是最新，无改动"] };
  }
  const backupPath = stampBackup(root, configPath, "codex");
  mkdirSync(configPath.slice(0, configPath.lastIndexOf("\\")), { recursive: true });
  writeFileSync(configPath, text, "utf8");
  return {
    client: "codex",
    backupPath,
    changes,
    guide: ["model_catalog_json 已指向网关生成的目录文件，池变化后重跑 `mx catalog` 刷新"],
  };
}

// ── zcode（只读检查）───────────────────────────────────────────────────────

/** 只读检查 provider_config.json 是否已指向本网关；绝不写文件（桌面端内存副本红线）。 */
export function checkZcode(home: string, baseUrl: string): ConnectOutcome {
  const configPath = join(home, ".zcode", "v2", "provider_config.json");
  const guide = [
    `zcode 的供应商配置由桌面端管理（脚本写 provider_config.json 会与桌面端内存副本互相覆盖），请在 zcode 桌面端操作：`,
    `  供应商设置 → 指向 ${baseUrl}/v1，API Key 任意非空值`,
    "  并把要用的模型加入该供应商的 personalModelIds 清单",
  ];
  if (!existsSync(configPath)) {
    return { client: "zcode", changes: [], guide };
  }
  try {
    const doc = JSON.parse(readFileSync(configPath, "utf8")) as { config?: { providerConfigRules?: Record<string, unknown> } };
    const groups = doc.config?.providerConfigRules ?? {};
    for (const group of Object.values(groups)) {
      for (const rule of Array.isArray(group) ? group : [group]) {
        const api = (rule as { config?: { api?: { baseUrl?: string } } })?.config?.api;
        if (api?.baseUrl?.includes("127.0.0.1:4412")) {
          guide.unshift(`检测到供应商「${(rule as { providerId?: string }).providerId ?? "?"}」已指向本网关（${api.baseUrl}）`);
          return { client: "zcode", changes: [], guide };
        }
      }
    }
  } catch {
    // 解析失败不影响指引（配置可能正在被桌面端写）
  }
  return { client: "zcode", changes: [], guide: ["当前 provider_config.json 里没有指向本网关的供应商。", ...guide] };
}
