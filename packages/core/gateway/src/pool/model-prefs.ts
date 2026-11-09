/**
 * 模型级渠道偏好（`<root>/model-prefs.json`）：每个对外模型指定「优先走哪家」。
 *
 * 为什么需要它：选路原本只按「剩余额度 × 速度 × 可靠性」自动挑，用户无法表达
 * 「这个模型我就要走这家」。偏好在**候选排序里置顶**，其余渠道仍按原优先级排在后面 ——
 * 被偏好的渠道不可用时（冷却 / 额度耗尽 / 请求失败）自然顺延，不需要额外的开关。
 *
 * 落点与字段契约见 docs/MODEL-PREFS.md（若存在）与 docs/STORAGE-CONVENTION.md。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalOf } from "./model-family.js";
import { rootFile } from "../runtime/paths.js";

/** 偏好文件名（根级，与 `pool-usage.json` / `models.json` 并列）。 */
export const MODEL_PREFS_FILE = "model-prefs.json";

/** 空值语义：`null` = 不指定（回到自动选路）。 */
export type ModelPrefs = Record<string, string | null>;

/** 读偏好；文件缺失或损坏返回空表（不猜、不修补）。 */
export function loadModelPrefs(): ModelPrefs {
  const path = rootFile(MODEL_PREFS_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ModelPrefs = {};
    for (const [id, cid] of Object.entries(parsed as Record<string, unknown>)) {
      // 只保留「字符串或 null」的值；脏值（数字、对象）视为未指定
      out[id] = typeof cid === "string" && cid !== "" ? cid : null;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写偏好（原子替换，权限 0600：里面只有渠道名，不含凭据）。 */
export function saveModelPrefs(prefs: ModelPrefs): void {
  const path = rootFile(MODEL_PREFS_FILE);
  writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 某模型当前偏好的渠道；未指定返回 `null`。 */
export function preferredChannelOf(model: string): string | null {
  const canonical = canonicalOf(model);
  if (!canonical) return null;
  const hit = loadModelPrefs()[canonical];
  return hit ?? null;
}

/**
 * 设置 / 清除某模型的偏好。
 *
 * `cid` 为 `null` 时清除（回到自动选路）。这里**不校验 cid 是否存在** —— 偏好是
 * 用户意图，渠道包可能后装；选路时它不在候选里就自然落空。
 */
export function setPreferredChannel(model: string, cid: string | null): void {
  const canonical = canonicalOf(model);
  if (!canonical) throw new Error(`unknown model ${model}`);
  const prefs = loadModelPrefs();
  prefs[canonical] = cid;
  saveModelPrefs(prefs);
}
