/**
 * 分段控件（区间 / 热力图粒度 / 设置页主题共用）：单选一组同构选项。
 *
 * 选中态是**独立药丸**（圆角块浮在容器底上），不是填满格子的方块：
 * 方块拼接时选中与未选中只靠色差区分，窄屏下一组按钮读不出「哪个被选中」；
 * 药丸自带边界，与容器留出细缝，三态（选中 / hover / 默认）一眼可辨。
 */

import type { ReactElement } from "react";

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
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-canvas p-0.5"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={value === item.key}
          onClick={() => onChange(item.key)}
          className={`tap rounded-lg px-3 py-1.5 text-xs transition-colors ${
            value === item.key ? "bg-brand text-canvas" : "text-ink-soft hover:text-ink"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
