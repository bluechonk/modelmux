/**
 * 顶栏版本胶囊 + 极简更新小卡。
 *
 * 常态：灰字胶囊（hover 只亮文字，边框恒中性）；有新版本时右上角亮一枚黄点（静默不打断）。
 * 点开：有新版本 → 「新版本 + 前往下载页」一行小卡（默认浏览器打开 Release 页）；
 * 无新版本 → 「当前为最新版」一行提示，约 1.8s 自动消失。不展示发布说明。
 * 数据来自快照的 `update`（网关后台每天检测一次，见 runtime/update-check.ts）。
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "../lib/api";

export function UpdateCard(): ReactElement | null {
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const version = state.data?.version ?? "";
  const update = state.data?.update ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 「当前为最新版」是纯提示，1.8s 自动收起；有新版本的小卡带按钮，保持打开等交互
  useEffect(() => {
    if (!open || update !== null) return;
    const timer = setTimeout(() => setOpen(false), 1800);
    return () => clearTimeout(timer);
  }, [open, update]);

  // 版本缺失（旧网关 / 加载中）时不渲染，不留空壳
  if (version === "") return null;

  return (
    <div ref={wrapRef} className="no-drag relative hidden min-[1000px]:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={update !== null ? `当前版本 v${version}，发现新版本 ${update.version}` : `当前版本 v${version}`}
        className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 font-mono text-xs text-ink-faint transition-colors hover:text-ink"
      >
        v{version}
        {update !== null && (
          <span
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full border-2 border-surface bg-warn"
            aria-hidden="true"
          />
        )}
      </button>
      {open && update !== null && (
        <div
          role="dialog"
          aria-label="发现新版本"
          className="absolute right-0 top-full z-30 mt-1.5 flex items-center gap-2.5 whitespace-nowrap rounded-xl border border-line bg-canvas px-3 py-2 text-left shadow-xl"
        >
          <span className="inline-flex items-center gap-2 text-xs text-ink">
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-warn" aria-hidden="true" />
            新版本
            <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
              {update.version}
            </span>
          </span>
          <a
            href={update.url}
            target="_blank"
            rel="noreferrer"
            className="flex-none rounded-lg bg-free px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            前往下载页
          </a>
        </div>
      )}
      {open && update === null && (
        <div
          role="status"
          className="absolute right-0 top-full z-30 mt-1.5 whitespace-nowrap rounded-xl border border-line bg-canvas px-3 py-2 text-left text-xs shadow-xl"
        >
          <span className="font-mono font-medium text-ink">v{version}</span>
          <span className="ml-2 text-free">当前为最新版</span>
        </div>
      )}
    </div>
  );
}
