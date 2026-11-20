/**
 * Switch（shadcn/ui 源码复制版，皮肤走本仓令牌桥）。
 *
 * 与官方版的差异：
 *   - 本仓口径：开 = 品牌蓝轨、关 = 中性 overlay 轨，钮恒白（对齐 iOS / Element 的
 *     通用做法）—— 红绿留给状态语义（在线 / 异常），不挪作「开 / 关」；
 *   - 触控垫：Root 即 button，窄屏撑 36×36（触控下限），桌面收窄回轨道尺寸
 *     保持行高密度；轨道色与滑块位移由 group-data-[state] 从 Root 映射到内层
 *     （Radix 的 data-state 只挂在 Root 上）；
 *   - 轨道跟随 Root 收窄：触控垫 36px 时内层恒 40px 会溢出 4px（行内右缘被裁、
 *     容器 scrollWidth 多 4），故窄屏轨道 `w-9`、桌面 `md:w-10`。
 */

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "../../lib/utils";

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>): ReactElement {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch inline-grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-55 md:h-[22px] md:w-10",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="relative block h-[22px] w-9 rounded-full border border-line-strong transition-colors group-data-[state=unchecked]/switch:bg-overlay group-data-[state=checked]/switch:bg-switch-on md:w-10"
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className={cn(
            "pointer-events-none absolute left-[3px] top-[3px] block size-4 rounded-full bg-white transition-all group-data-[state=checked]/switch:left-[15px] md:group-data-[state=checked]/switch:left-[19px]",
          )}
        />
      </span>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
