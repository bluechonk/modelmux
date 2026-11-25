/**
 * 用户级设置：`<root>/setting.json`（跨会话记住的用户偏好：主题 + 渠道开关）。
 *
 * 为什么放 runtime：主题由 http 层写、渠道开关由 http 层的命令面写、app 层的快照读
 * —— 分层只允许向下依赖，落 runtime 三边都够得着。读容错：文件缺失 / 损坏 / 字段
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
  /**
   * 被关闭的渠道：账号池隐藏其卡片、选路跳过它（设置弹窗的渠道开关）。
   *
   * 关闭 = 隐藏/不放量，不是注销：凭据与登录态保留，勾回来即恢复。
   * 开关是本机全局设置（setting.json），与 fs/pg 存储形态无关。
   */
  disabled_channels: string[];
}

const DEFAULTS: UserSettings = {
  theme: "system",
  disabled_channels: [],
};

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** 渠道 id 形状校验：非法项从设置里丢弃，不让坏值污染选路。 */
const CID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

function normalizeDisabled(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v === "string" && CID_RE.test(v)) seen.add(v);
    if (seen.size >= 64) break;
  }
  return [...seen];
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
  const record = parsed as Record<string, unknown>;
  const theme = record["theme"];
  return {
    theme: isThemeMode(theme) ? theme : DEFAULTS.theme,
    disabled_channels: normalizeDisabled(record["disabled_channels"]),
  };
}

/** 合并写入用户设置（原子写 0600）；返回合并后的完整设置。 */
export function saveUserSettings(patch: Partial<UserSettings>): UserSettings {
  const merged = { ...loadUserSettings(), ...patch };
  writeJsonFile(rootSettingPath(), merged);
  return merged;
}

/** 渠道是否启用（设置弹窗的勾选状态；未记录 = 启用）。单次判断用。 */
export function isChannelEnabled(cid: string): boolean {
  return !loadUserSettings().disabled_channels.includes(cid);
}

/**
 * 关闭渠道集合（热路径用）：`poolCandidates` 逐渠道过滤、账号池列表逐卡判断，
 * 每渠道调一次 `isChannelEnabled` 就是每渠道一次同步读盘 + JSON.parse。
 * 调用方在循环外取一次，循环内只做 `set.has(cid)`。
 */
export function disabledChannelSet(): Set<string> {
  return new Set(loadUserSettings().disabled_channels);
}

/** 开/关一个渠道：只改 `disabled_channels`，凭据与登录态一概不动。 */
export function setChannelEnabled(cid: string, enabled: boolean): UserSettings {
  const current = loadUserSettings();
  const next = new Set(current.disabled_channels);
  if (enabled) next.delete(cid);
  else next.add(cid);
  return saveUserSettings({ disabled_channels: [...next] });
}
