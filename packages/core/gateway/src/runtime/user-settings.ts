/**
 * 用户级设置：`<root>/setting.json`（跨会话记住的用户偏好，目前只有主题）。
 *
 * 为什么放 runtime：主题由 http 层（POST /api/theme）写、由 app 层的快照读 ——
 * 分层只允许向下依赖，落 runtime 两边都够得着。读容错：文件缺失 / 损坏 / 字段
 * 非法一律回落默认值（不猜、不修），调用方不必 try/catch；写走 secret-file 的
 * 原子写（0600，与全部根级 JSON 一致）。
 */

import { readFileSync } from "node:fs";

import { rootSettingPath } from "./paths.js";
import { writeJsonFile } from "./secret-file.js";

/** 主题模式：跟随系统 / 深色 / 浅色（「跟随系统」由前端按 prefers-color-scheme 解析）。 */
export type ThemeMode = "system" | "dark" | "light";

const THEME_MODES: readonly ThemeMode[] = ["system", "dark", "light"];

export interface UserSettings {
  theme: ThemeMode;
}

const DEFAULTS: UserSettings = { theme: "system" };

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** 读用户设置：文件缺失 / 损坏 / 字段非法时逐项回落默认值。 */
export function loadUserSettings(): UserSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(rootSettingPath(), "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULTS };
  const theme = (parsed as Record<string, unknown>)["theme"];
  return { theme: isThemeMode(theme) ? theme : DEFAULTS.theme };
}

/** 合并写入用户设置（原子写 0600）；返回合并后的完整设置。 */
export function saveUserSettings(patch: Partial<UserSettings>): UserSettings {
  const merged = { ...loadUserSettings(), ...patch };
  writeJsonFile(rootSettingPath(), merged);
  return merged;
}
