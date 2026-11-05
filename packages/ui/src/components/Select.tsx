/**
 * 轻量下拉选择：替代原生 `<select>`。
 *
 * 为什么不用原生 select：弹层由操作系统绘制，深色主题下是亮色高亮块（与整套 UI 割裂），
 * 且无法跟随项目的描边 / 圆角 / 字号。这里只做「按钮 + 绝对定位列表」的最小实现。
 *
 * 约束：选项数量是「渠道 / 日期」量级（几条到几十条），不做虚拟滚动与搜索；
 * 弹层 `absolute` 定位、点外部或 Esc 关闭，选项是原生按钮（键盘可达）。
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<SelectOption>;
  /** 无障碍名（按钮与列表共用，如「渠道」「日期」）。 */
  label: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="tap inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
      >
        {current?.label ?? "—"}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-40 mt-1 max-h-64 min-w-full overflow-auto rounded-lg border border-line-strong bg-raised py-1 shadow-xl"
        >
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors ${
                  option.value === value
                    ? "bg-overlay text-ink"
                    : "text-ink-soft hover:bg-overlay/60 hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}