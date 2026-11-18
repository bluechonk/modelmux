/**
 * 开关（`role="switch"` + `aria-checked`）：接入开关与开机自启动共用。
 *
 * 骨架是 shadcn Switch（Radix Switch）；轨道色沿用本仓裁决 —— 开 = 状态绿
 * （与「已接入」同语义），不用品牌反白：深色下白轨道在一排深卡上刺眼。
 * 触控垫在 ui/switch.tsx 内实现：Root 即 button，窄屏 36×36、桌面回轨道尺寸。
 */

import type { ReactElement } from "react";

import { Switch as SwitchUI } from "./ui/switch";

export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  /** 无障碍名称（含当前状态）。 */
  label: string;
}): ReactElement {
  return (
    <SwitchUI checked={checked} disabled={disabled} onCheckedChange={() => onChange()} aria-label={label} />
  );
}
