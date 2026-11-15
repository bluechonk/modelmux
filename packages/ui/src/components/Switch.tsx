/**
 * 开关（`role="switch"` + `aria-checked`）：接入开关与开机自启动共用。
 *
 * 开 = 状态绿（与「已接入」文字同语义，深浅两套都有对比），关 = overlay 灰。
 * 不用品牌反白：深色下白轨道在一排深卡上过于刺眼，且与其它语义色各说各话。
 * 触控垫：`.tap-square`（< md 时 min 44×44）放在**按钮**上、视觉轨道缩进里面 ——
 * `.tap` 直接加在 22px 高的轨道按钮上会把轨道撑成 44px 圆饼、滑块贴顶（2026-11-14 实测）。
 */

import type { ReactElement } from "react";

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
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      aria-label={label}
      className={`tap-square grid flex-none place-items-center disabled:cursor-default ${
        disabled ? "opacity-55" : ""
      }`}
    >
      <span
        className={`relative block h-[22px] w-10 rounded-full transition-colors ${
          checked ? "bg-free" : "bg-overlay"
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full transition-all ${
            checked ? "left-[19px] bg-canvas" : "left-[3px] bg-ink-faint"
          }`}
        />
      </span>
    </button>
  );
}
