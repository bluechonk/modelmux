/**
 * 轻量下拉选择：替代原生 `<select>`（操作系统绘制的弹层在深色主题下是亮色高亮块）。
 *
 * 关键约束：
 *   - 选项是「渠道 / 日期」量级（几条到几十条），不做虚拟滚动与搜索；
 *   - 声明了 `aria-haspopup="listbox"` 就必须兑现 listbox 键盘语义（↑/↓/Home/End/Enter/Esc），
 *     焦点留在触发器、用 `aria-activedescendant` 指向高亮项；
 *   - `fixedWidth`：触发器宽度按**最宽选项**量出后固定 —— 切换选项不会让按钮位移
 *     （筛选栏里三个下拉并排，宽度一变就把相邻控件挤开）。
 */

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

/** 触发器内「占位 + 箭头 + 间隙 + 内边距 + 边框」的固定占位（px）。 */
const TRIGGER_CHROME_W = 12 + 12 + 6 + 6 + 16 + 2;

export function Select({
  value,
  onChange,
  options,
  label,
  fixedWidth = false,
  widthBasis,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<SelectOption>;
  /** 无障碍名（按钮与列表共用，如「渠道」「日期」）。 */
  label: string;
  /** 宽度固定为基准文字的占用（并排筛选时切换选项不移位）。 */
  fixedWidth?: boolean;
  /**
   * 定宽基准文字；缺省用当前选项标签。选项集变化时宽度不变 ——
   * 渠道按**全部在册渠道**、日期按完整 `YYYY-MM-DD` 传，避免选项增减导致按钮位移。
   */
  widthBasis?: ReadonlyArray<string>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  /** 当前高亮下标（-1 = 无）。仅在展开时有效。 */
  const [activeIndex, setActiveIndex] = useState(-1);
  const baseId = useId();
  /** 固定宽度时触发器的宽度（px）；undefined = 未测量 / 不固定。 */
  const [triggerWidth, setTriggerWidth] = useState<number | undefined>(undefined);
  const measureRef = useRef<HTMLDivElement | null>(null);
  /** 定宽基准文字（缺省 = 当前选项标签）。 */
  const basis = widthBasis ?? options.map((o) => o.label);
  const basisKey = basis.join("\u0001");

  // 量最宽选项的文字占用（隐藏节点，字号与触发器一致）→ 触发器宽度恒定
  useLayoutEffect(() => {
    if (!fixedWidth) {
      setTriggerWidth(undefined);
      return;
    }
    const box = measureRef.current;
    if (!box) return;
    let max = 0;
    for (const el of box.querySelectorAll("[data-select-label]")) {
      max = Math.max(max, el.getBoundingClientRect().width);
    }
    setTriggerWidth(max + TRIGGER_CHROME_W);
    // 基准文字 join 成 key：数组每次渲染都是新引用，用内容做依赖
  }, [fixedWidth, basisKey]);

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
      {fixedWidth && (
        // 宽度测量用：与触发器同字号，基准文字逐行排列量每行占用
        <div ref={measureRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 invisible">
          {basis.map((text, index) => (
            <span key={index} data-select-label className="block whitespace-nowrap text-xs">
              {text}
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        // 高亮项通过 activedescendant 暴露给 AT（焦点仍留在触发器上）
        aria-activedescendant={open && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        style={fixedWidth && triggerWidth !== undefined ? { width: `${triggerWidth}px` } : undefined}
        className={`tap inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink`}
      >
        {/*
          定宽态：标签**水平居中**（左侧放一个与箭头等宽的占位，两侧对称才真正居中），
          箭头固定在右。缺省态保持左对齐（内容决定宽度，没有居中语义）。
        */}
        {fixedWidth && <span className="w-3 flex-none" aria-hidden="true" />}
        <span className={fixedWidth ? "flex-1 text-center" : undefined}>{current?.label ?? "—"}</span>
        <ChevronDown className={`h-3 w-3 flex-none transition-transform ${open ? "rotate-180" : ""}`} />
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
                className={`block w-full whitespace-nowrap px-3 py-1.5 text-center text-xs transition-colors ${
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