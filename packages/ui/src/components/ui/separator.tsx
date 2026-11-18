/**
 * Separator（shadcn/ui 源码复制版，Radix Separator）。
 *
 * 语义分隔（role="separator"）：读屏器能报「分区」。账号行的分隔**不用它**——
 * 那里是防闪白的 inset 投影口径（2026-11-14 实测），布局边框（卡底条）也不换。
 */

import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>): ReactElement {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-line data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
