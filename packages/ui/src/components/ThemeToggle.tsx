/**
 * 主题切换（顶栏小太阳）：**两态快捷切换** —— 点一下在浅色 / 深色之间来回，取反的基准
 * 是当前生效主题；「跟随系统」是 setting.json 的默认值，一旦手动选过就以所选为准
 * （要回到跟随系统只能改 `~/.modelmux/setting.json`，见 docs/STORAGE-CONVENTION.md）。
 *
 * 三态选择的完整入口在设置页；顶栏这枚是高频快捷键。状态与写入逻辑见
 * `lib/use-theme-mode.ts`。
 */

import { Moon, Sun } from "lucide-react";
import type { ReactElement } from "react";

import { useThemeMode } from "../lib/use-theme-mode";

export function ThemeToggle(): ReactElement {
  const { resolved, select } = useThemeMode();

  const toggle = (): void => {
    // 当前深 → 切浅，当前浅 → 切深；跟随系统时按解析出的那档取反
    select(resolved === "dark" ? "light" : "dark");
  };

  const Icon = resolved === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`切换主题（当前${resolved === "dark" ? "深色" : "浅色"}，点击切到${
        resolved === "dark" ? "浅色" : "深色"
      }）`}
      className="no-drag tap-square grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-overlay hover:text-ink"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
