/**
 * 轻量下拉选择：替代原生 `<select>`（操作系统绘制的弹层在深色主题下是亮色高亮块）。
 *
 * 骨架是 shadcn Select（Radix Select：combobox 语义、typeahead、翻向与滚动由原语
 * 接管，替代原手写 217 行的 listbox 键盘机）。选项是「渠道 / 日期」量级，不做搜索。
 *
 * 本仓口径（原实现裁决保留）：
 *   - `fixedWidth`：触发器宽度按**最宽选项**量出后固定 —— 筛选栏里三个下拉并排，
 *     宽度一变就把相邻控件挤开；内容左对齐（shadcn 口径，定宽仅锁宽度不锁对齐）；
 *   - `widthBasis`：定宽基准文字（渠道按全部在册、日期按完整 YYYY-MM-DD）；
 *   - value 不在选项集里时回落第一个选项（显示与提交都用回落值）。
 */

import { useLayoutEffect, useRef, useState, type ReactElement } from "react";

import { Select as SelectRoot, SelectContent, SelectItem, SelectTrigger } from "./ui/select";

export interface SelectOption {
  value: string;
  label: string;
}

/** 触发器内「箭头 + 间隙 + 内边距 + 边框」的固定占位（px）。 */
const TRIGGER_CHROME_W = 12 + 6 + 16 + 2;

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
  /** 定宽时触发器的宽度（px）；undefined = 未测量 / 不固定。 */
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

  // value 不在选项集里 → 回落第一个选项（与原实现一致：显示与提交都用回落值）
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="relative">
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
      <SelectRoot value={current?.value ?? ""} onValueChange={onChange}>
        <SelectTrigger
          aria-label={label}
          style={fixedWidth && triggerWidth !== undefined ? { width: `${triggerWidth}px` } : undefined}
          className={fixedWidth ? "tap w-fit" : "tap"}
        >
          {/* 定宽保留（切换选项不移位），内容左对齐 —— shadcn 口径 */}
          <span>{current?.label ?? "—"}</span>
        </SelectTrigger>
        <SelectContent className="max-h-64">{options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}</SelectContent>
      </SelectRoot>
    </div>
  );
}
