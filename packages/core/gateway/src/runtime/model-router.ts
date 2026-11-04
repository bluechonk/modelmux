/**
 * 入站模型路由注册表：默认模型 + 别名表（`~/.modelmux/router.json`）。
 *
 * 约束：本文件只管注册表读写（最底层，不许反向依赖 pool/http）；裸名与别名的
 * 解析在 `pool/inbound-model.ts`（要查渠道目录索引）。注册表无敏感信息，
 * 复用 writeJsonSecret 只为拿到它的原子写与目录自建。
 *
 * 文档：docs/CLIENT-INTEGRATION.md
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { rootDir } from "./paths.js";
import { writeJsonSecret } from "./secret-file.js";

export interface RouterConfig {
  /**
   * 裸模型名兜底池 id（`<cid>/<模型>`）。
   *
   * Claude Code / Codex 不带 ANTHROPIC_MODEL 类配置时会发厂商默认模型名
   * （如 `claude-sonnet-4-5`），池里永远不会有 —— 兜到默认模型才能「接上就能用」。
   */
  default?: string;
  /** 别名 → 池 id。键在解析时大小写不敏感；值必须是池 id 形态。 */
  aliases?: Record<string, string>;
}

function routerPath(): string {
  return join(rootDir(), "router.json");
}

/** 读注册表：缺失 / 损坏一律当空（路由配置不该让网关起不来）。 */
export function readRouterConfig(): RouterConfig {
  try {
    if (!existsSync(routerPath())) return {};
    const raw: unknown = JSON.parse(readFileSync(routerPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const rec = raw as Record<string, unknown>;
    const out: RouterConfig = {};
    if (typeof rec["default"] === "string") out.default = rec["default"];
    if (rec["aliases"] && typeof rec["aliases"] === "object" && !Array.isArray(rec["aliases"])) {
      const aliases: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec["aliases"] as Record<string, unknown>)) {
        if (typeof v === "string") aliases[k.toLowerCase()] = v;
      }
      out.aliases = aliases;
    }
    return out;
  } catch {
    return {};
  }
}

/** 原子写注册表（0600）。 */
export function writeRouterConfig(config: RouterConfig): void {
  writeJsonSecret(routerPath(), config);
}

/**
 * 控制台写入前的服务端校验；返回 null = 通过，否则是给人看的错误文案。
 *
 * 只做形态校验（池 id 必须含 `/` 且两段非空）；渠道/模型是否真实存在由
 * 请求时的解析路径兜底（400 unknown_model），这里不查目录 —— 避免控制台
 * 保存被目录缓存的新鲜度卡住。
 */
export function validateRouterConfig(config: RouterConfig): string | null {
  const poolIdShape = (value: string | undefined): boolean =>
    typeof value === "string" && value.includes("/") && !value.startsWith("/") && !value.endsWith("/");
  if (config.default !== undefined && !poolIdShape(config.default)) {
    return "默认模型必须是 <渠道>/<模型> 形态";
  }
  for (const [alias, target] of Object.entries(config.aliases ?? {})) {
    if (!alias.trim()) return "存在空别名";
    if (!poolIdShape(target)) return `别名 ${alias} 的目标必须是 <渠道>/<模型> 形态`;
  }
  return null;
}
