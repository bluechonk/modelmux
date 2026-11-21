/**
 * 分段控件：单选一组同构选项。
 *
 * 骨架是 shadcn Tabs（Radix Tabs，键盘与 aria-selected 由原语接管）；
 * 选中态是**独立药丸** + accent 反转 —— 方块拼接只靠色差区分，窄屏读不出
 * 「哪个被选中」，药丸自带边界三态一眼可辨（视觉裁决见 docs/WEB-CONSOLE.md）。
 */

import type { ReactElement } from "react";

import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}): ReactElement {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} className="contents">
      <TabsList
        aria-label={label}
        className="h-auto gap-0.5 rounded-lg bg-muted p-0.5 text-ink-soft"
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.key}
            value={item.key}
            className="tap rounded-md px-3 py-1.5 text-xs text-ink-soft transition-colors data-[state=active]:bg-sel data-[state=active]:text-sel-ink hover:text-ink"
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
