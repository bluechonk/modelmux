/**
 * 轻量下拉选择：替代原生 `<select>`（操作系统绘制的弹层在深色主题下是亮色高亮块）。
 *
 * 关键约束：
 *   - 选项是「渠道 / 日期」量级（几条到几十条），不做虚拟滚动与搜索；
 *   - 声明了 `aria-haspopup="listbox"` 就必须兑现 listbox 键盘语义（↑/↓/Home/End/Enter/Esc），
 *     焦点留在触发器、用 `aria-activedescendant` 指向高亮项。
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";

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
  const listRef = useRef<HTMLUListElement | null>(null);
  /** 当前高亮下标（-1 = 无）。仅在展开时有效。 */
  const [activeIndex, setActiveIndex] = useState(-1);
  const baseId = useId();

  // 展开时从当前选中项开始高亮（不存在就落在第一项）
  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }
    const i = options.findIndex((o) => o.value === value);
    setActiveIndex(i >= 0 ? i : 0);
  }, [open, options, value]);

  // 高亮项滚入可视区（长列表里方向键连按时不能把选中项移出视野）
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

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

  /** 触发器上的键盘处理：↑/↓ 移动高亮，Enter/Space 选定，Esc 关闭。 */
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      // 关闭态：↓ / ↑ / Enter / Space 都负责展开（与原生 select 一致）
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, (i < 0 ? -1 : i) + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, (i < 0 ? options.length : i) - 1));
        return;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      case "Enter":
      case " ": {
        e.preventDefault();
        const picked = options[activeIndex];
        if (picked) onChange(picked.value);
        setOpen(false);
        return;
      }
      case "Tab":
        // 焦点离开等于放弃选择（不吞 Tab —— 键盘用户要能走下去）
        setOpen(false);
        return;
      default:
        return;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        // 高亮项通过 activedescendant 暴露给 AT（焦点仍留在触发器上）
        aria-activedescendant={open && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className="tap inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
      >
        {current?.label ?? "—"}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-40 mt-1 max-h-64 min-w-full overflow-auto rounded-lg border border-line-strong bg-raised py-1 shadow-xl"
        >
          {options.map((option, index) => (
            <li key={option.value} id={`${baseId}-opt-${index}`}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors ${
                  option.value === value
                    ? "bg-overlay text-ink"
                    : index === activeIndex
                      ? "bg-overlay/60 text-ink"
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