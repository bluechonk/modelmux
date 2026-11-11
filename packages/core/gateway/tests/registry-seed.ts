/**
 * 测试用：往当前 `MODELMUX_HOME` 写一份模型注册表。
 *
 * 候选渠道由**注册表**声明（不再从渠道目录枚举），所以每个测试要在建渠道后
 * 把「哪些渠道提供哪个模型」写进 `<root>/models.json`，与线上行为一致。
 *
 * 不覆盖已存在的文件：多个测试共用一个 HOME 时，先写的表继续有效。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 一份默认表：三个模型各挂若干测试桩渠道。 */
export interface SeedModel {
  contextWindow: number;
  maxOutput: number;
  inputModalities?: string[];
  channels: Record<string, string>;
}

export function seedRegistry(models: Record<string, SeedModel>, home = process.env["MODELMUX_HOME"]): void {
  const root = home ?? join(tmpdir(), "modelmux-test-registry");
  mkdirSync(root, { recursive: true });
  const file = join(root, "models.json");
  const doc = {
    version: 1,
    models: Object.fromEntries(
      Object.entries(models).map(([id, m]) => [
        id,
        {
          contextWindow: m.contextWindow,
          maxOutput: m.maxOutput,
          inputModalities: m.inputModalities ?? ["text"],
          channels: m.channels,
        },
      ]),
    ),
  };
  if (existsSync(file)) return; // 不覆盖已有表
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/** 一份最小表：只有 `deepseek-v4.1-flash`，挂在给定渠道上。 */
export function seedDeepseek(cids: Record<string, string>, home?: string): void {
  seedRegistry(
    {
      "deepseek-v4.1-flash": {
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        channels: cids,
      },
    },
    home,
  );
}

/** 注册表文档（与共享层 `ModelRegistry` 同形）。 */
interface RegistryDoc {
  version: number;
  models: Record<string, { contextWindow: number; maxOutput: number; inputModalities: string[]; channels: Record<string, string> }>;
}

/** 默认规格（测试只关心路由，不关心窗口数值）。 */
const SPEC: Record<string, { contextWindow: number; maxOutput: number }> = {
  "deepseek-v4.1-flash": { contextWindow: 1_000_000, maxOutput: 128_000 },
  "glm-5.3-flash": { contextWindow: 1_000_000, maxOutput: 32_000 },
  "qwen3.8-flash": { contextWindow: 1_000_000, maxOutput: 32_000 },
};

/**
 * 声明「某渠道提供某模型」——测试桩建渠道时调用。
 *
 * 与线上同口径：候选渠道来自注册表，桩必须把自己的供给写进去。
 * 模型名按规范表归一（`DeepSeek-V4.1-Flash` / `sn-deepseek-v4-1-flash` 都能命中）。
 *
 * 注册表落到 `<root>/models.json`，并**按 worker 线程**把读取指向它 ——
 * `node --test` 并行跑测试文件时 `process.env` 跨线程共享，靠 env 会互相覆盖
 * （实测 chat-stream / queue-retry 因此串味）；模块级覆盖在线程内独立。
 */
export function registerChannelSupply(
  cid: string,
  exposed: readonly (string | readonly [exposed: string, upstream: string])[],
  home = process.env["MODELMUX_HOME"],
): void {
  const root = home ?? join(tmpdir(), "modelmux-test-registry");
  mkdirSync(root, { recursive: true });
  const file = join(root, "models.json");
  let doc: RegistryDoc = { version: 1, models: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as typeof doc;
      if (parsed?.models) doc = parsed;
    } catch {
      /* 损坏的表按空表重建 */
    }
  }
  for (const item of exposed) {
    // 两种形态：`"model"`（上游写法与对外名相同）或 `["对外写法", "上游写法"]`
    const [raw, upstream] = Array.isArray(item) ? item : [item, item];
    const key = canonicalKey(raw);
    if (!key) continue;
    const spec = SPEC[key] ?? { contextWindow: 1_000_000, maxOutput: 128_000 };
    const row = doc.models[key] ?? { ...spec, inputModalities: ["text"], channels: {} };
    // 同一渠道声明多个等价写法时取**第一条**（上游 slug 大小写敏感，后写覆盖会静默改掉真名）
    if (row.channels[cid] === undefined) row.channels[cid] = upstream;
    doc.models[key] = row;
  }
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/** 测试里用的模型名归一（与池层同口径：大小写 / `sn-` 包装 / `-Official` 尾饰）。 */
function canonicalKey(raw: string): string | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/^(sn-|z-ai-|bytedance-)/, "")
    .replace(/(\d)-(\d)/g, "$1.$2")
    .replace(/-official$/, "")
    .replace(/-\d{4}$/, "")
    .replace(/-latest$/, "");
  return key in SPEC ? key : null;
}

