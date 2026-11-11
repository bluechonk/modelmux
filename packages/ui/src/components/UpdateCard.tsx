/**
 * 顶栏版本胶囊 + 更新卡片。
 *
 * 有新版本时胶囊右侧出现一个橙点（不打断）；点开卡片看发布说明与三个动作：
 * 前往发布页 / 稍后提醒（今天不再提示）/ 跳过此版本。
 * 数据来自快照的 `update`（网关后台每天检测一次，见 runtime/update-check.ts）。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "../lib/api";

export function UpdateCard(): ReactElement | null {
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const qc = useQueryClient();
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

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    await fn();
    setOpen(false);
    await qc.invalidateQueries({ queryKey: ["state"] });
  };

  // 版本缺失（旧网关 / 加载中）时不渲染，不留空壳
  if (version === "") return null;


  return (
    <div ref={wrapRef} className="no-drag relative hidden min-[900px]:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={update ? `当前版本 v${version}，发现新版本 ${update.version}` : `当前版本 v${version}`}
        className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 font-mono text-xs text-ink-faint"
      >
        v{version}
        {update && <span className="h-1.5 w-1.5 flex-none rounded-full bg-warn" aria-hidden="true" />}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="版本更新"
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-line bg-canvas p-3 text-left shadow-xl"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-ink">发现新版本</span>
            <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
              {update?.version}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="关闭"
              className="ml-auto px-1 leading-none text-ink-faint hover:text-ink"
            >
              ×
            </button>
          </div>
          <div className="mb-3 max-h-36 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
            {update?.notes?.trim() || "（该版本未附发布说明）"}
          </div>
          <div className="flex gap-2">
            <a
              href={update?.url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-lg bg-free px-2 py-1.5 text-center text-xs font-medium text-white hover:opacity-90"
            >
              前往发布页
            </a>
            <button
              type="button"
              onClick={() => void act(() => api.commands.snoozeUpdate())}
              className="flex-1 rounded-lg border border-line px-2 py-1.5 text-xs text-ink hover:bg-raised"
            >
              稍后提醒
            </button>
            <button
              type="button"
              onClick={() => void act(() => api.commands.skipUpdate(update?.version ?? ""))}
              className="flex-1 rounded-lg px-2 py-1.5 text-xs text-ink-faint hover:text-ink"
            >
              跳过此版本
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
