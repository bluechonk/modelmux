/**
 * Switch（shadcn/ui 源码复制版，皮肤走本仓令牌桥）。
 *
 * 与官方版的差异：
 *   - ZCode 口径：开 = accent 反色轨道（深白轨黑钮 / 浅黑轨白钮），关 = 次级灰轨 + 前景钮；
 *     开关表达「动作已生效」而不是「状态健康」，健康绿留给状态点与 pill；
 *   - 触控垫：Root 即 button，窄屏撑 36×36（触控下限），桌面收窄回轨道尺寸
 *     保持行高密度；轨道色与滑块位移由 group-data-[state] 从 Root 映射到内层
 *     （Radix 的 data-state 只挂在 Root 上）。
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
        className="relative block h-[22px] w-10 rounded-full transition-colors group-data-[state=unchecked]/switch:bg-overlay group-data-[state=checked]/switch:bg-brand"
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className={cn(
            "pointer-events-none absolute left-[3px] top-[3px] block size-4 rounded-full transition-all group-data-[state=checked]/switch:left-[19px] group-data-[state=checked]/switch:bg-on-brand group-data-[state=unchecked]/switch:bg-ink",
          )}
        />
      </span>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
