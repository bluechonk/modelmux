/**
 * 设置弹窗：顶栏齿轮打开，左锚点（通用 / 外观 / 关于）+ 右内容。
 *
 * 与「添加账号」登录弹窗同一套 Radix Dialog 骨架，但关闭策略相反：
 * 设置不是流程态，ESC 与点遮罩都应当关闭（登录弹窗刻意不关）。
 * 右列用小字分组标签分节（偏好设置 / 显示 / 信息），行首带图标；
 * 窄屏（<sm）锚点折成顶部一行横滑，不挤压内容列。
 */

import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Info, Loader2, Palette, Power, RefreshCw, RotateCw, ScrollText, Server, Settings, Tag, X } from "lucide-react";
import { useEffect, useState, type ComponentType, type ReactElement, type ReactNode } from "react";

import { Segmented } from "./Segmented";
import { Switch } from "./Switch";
import { CopyButton } from "./CopyButton";
import { GithubMark } from "./GithubMark";
import { api } from "../lib/api";
import { errorText } from "../lib/log-format";
import { useRefreshInterval, type RefreshPage } from "../lib/refresh-interval";
import { REPO_URL } from "../lib/site";
import { useThemeMode } from "../lib/use-theme-mode";
import type { ThemeMode } from "../lib/theme";
import { useToast } from "./Toast";

/** 桌面壳判定：preload 桥只在壳的渲染层存在（浏览器里没有）。 */
const IS_DESKTOP = typeof window !== "undefined" && window.modelmuxWindow !== undefined;
/**
 * autostart 能力判定：**按方法检测，不能只看桥存在**。
 * 旧壳（v0.1.5）的桥没有 autostart 方法，直接调用会同步抛 TypeError ——
 * 它发生在 useEffect 里，React 会把整棵树卸载，页面直接黑屏（实测 2026-11-15）。
 */
const CAN_AUTOSTART = IS_DESKTOP && typeof window.modelmuxWindow?.getAutostart === "function";

const THEME_ITEMS: ReadonlyArray<{ key: ThemeMode; label: string }> = [
  { key: "system", label: "跟随系统" },
  { key: "dark", label: "深色" },
  { key: "light", label: "浅色" },
];

type SectionKey = "general" | "look" | "about";

/** 行首 / 锚点图标：lucide 组件与 GithubMark 都只吃 className，共用同一形态。 */
type IconType = ComponentType<{ className?: string }>;

const SECTION_ITEMS: ReadonlyArray<{ key: SectionKey; label: string; icon: IconType }> = [
  { key: "general", label: "通用", icon: RefreshCw },
  { key: "look", label: "外观", icon: Palette },
  { key: "about", label: "关于", icon: Info },
];

/** 分区内的一行设置：图标 + 左标题说明、右控件；两端结构，窄屏先让说明换行。 */
function ModalRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: IconType;
  title: string;
  description: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] bg-overlay text-ink-soft"
          aria-hidden="true"
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-sm text-ink">{title}</div>
          <div className="mt-0.5 text-xs text-ink-faint">{description}</div>
        </div>
      </div>
      <div className="ml-auto flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

/** 刷新间隔一行：档位分段控件，只能选设定值（最小值由 lib 钳制）。 */
function IntervalRow({
  icon,
  page,
  title,
  description,
}: {
  icon: IconType;
  page: RefreshPage;
  title: string;
  description: string;
}): ReactElement {
  const { interval, options, select } = useRefreshInterval(page);
  return (
    <ModalRow icon={icon} title={title} description={description}>
      <Segmented
        items={options.map((ms) => ({ key: String(ms), label: `${ms / 1000}s` }))}
        value={String(interval)}
        onChange={(next) => select(Number(next))}
        label={title}
      />
    </ModalRow>
  );
}

export function SettingsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  // `["state"]` 轮询归布局层所有，这里只订阅同一份缓存（同 GatewayStatus）
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const toast = useToast();
  const { mode, select } = useThemeMode();
  const [section, setSection] = useState<SectionKey>("general");

  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  /** 手动检查发现的新版本（模态卡数据）；null = 未打开。 */
  const [updateDialog, setUpdateDialog] = useState<{ version: string; url: string } | null>(null);

  useEffect(() => {
    if (!CAN_AUTOSTART) return;
    let alive = true;
    void window
      .modelmuxWindow!.getAutostart()
      .then((v) => {
        if (alive) setAutostart(v);
      })
      .catch((err) => toast.error(`开机自启动状态读取失败：${errorText(err)}`));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast 引用稳定；仅挂载时读一次
  }, []);

  const toggleAutostart = async (): Promise<void> => {
    if (!CAN_AUTOSTART || autostart === null) return;
    const next = !autostart;
    setAutostart(next); // 乐观更新，失败回滚
    try {
      await window.modelmuxWindow!.setAutostart(next);
    } catch (err) {
      setAutostart(!next);
      toast.error(`开机自启动设置失败：${errorText(err)}`);
    }
  };

  const checkUpdate = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await api.commands.checkUpdate();
      if (!res.ok) {
        toast.error(`检查更新失败：${res.error ?? "未知错误"}`);
        return;
      }
      const version = typeof res["version"] === "string" ? res["version"] : "";
      const url = typeof res["url"] === "string" ? res["url"] : "";
      if (res["available"] === true && version !== "" && url !== "") {
        setUpdateDialog({ version, url });
      } else {
        toast.success("当前为最新版本");
      }
    } catch (err) {
      toast.error(`检查更新失败：${errorText(err)}`);
    } finally {
      setChecking(false);
    }
  };

  const base_url = state.data?.base_url ?? "";
  const version = state.data?.version ?? "";
  const passiveUpdate = state.data?.update ?? null;
  const webUrl = base_url ? `${base_url.replace(/\/v1\/?$/, "")}/web/` : "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(600px,85vh)] w-[min(96vw,48rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
          aria-describedby={undefined}
        >
          <div className="flex flex-none items-center gap-3 px-5 pb-3 pt-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-overlay text-ink-soft">
              <Settings className="h-4 w-4" aria-hidden="true" />
            </span>
            <Dialog.Title className="flex-1 text-sm font-medium text-ink">设置</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭设置"
                className="tap-square grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5 sm:flex-row sm:gap-4">
            {/* 左锚点（tablist）：窄屏折成顶部一行横滑，不挤压内容列 */}
            <nav
              role="tablist"
              aria-label="设置分区"
              aria-orientation="vertical"
              className="no-scrollbar flex flex-none gap-1 overflow-x-auto sm:w-[150px] sm:flex-col sm:overflow-visible"
            >
              {SECTION_ITEMS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`settings-tab-${key}`}
                  aria-selected={section === key}
                  aria-controls="settings-panel"
                  onClick={() => setSection(key)}
                  className={`tap flex flex-none items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                    section === key ? "bg-overlay text-ink" : "text-ink-soft hover:bg-overlay/40 hover:text-ink"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </nav>

            {/* 去卡化：小字分组标签 + 行直接铺在弹窗里（弹窗本身已是浮层，不再套一层容器边框） */}
            <div
              role="tabpanel"
              id="settings-panel"
              aria-labelledby={`settings-tab-${section}`}
              className="no-scrollbar min-w-0 flex-1 overflow-y-auto pt-1"
            >
              {section === "general" && (
                <div>
                  <div className="mb-2.5 text-xs font-medium text-ink-faint">偏好设置</div>
                  <div className="divide-y divide-line">
                    {CAN_AUTOSTART && (
                      <ModalRow icon={Power} title="开机自启动" description="登录 Windows 后自动启动并收进托盘">
                        <Switch
                          checked={autostart === true}
                          disabled={autostart === null}
                          onChange={() => void toggleAutostart()}
                          label={`开机自启动，${autostart === null ? "读取中" : autostart ? "已开启" : "已关闭"}`}
                        />
                      </ModalRow>
                    )}
                    <IntervalRow icon={RefreshCw} page="accounts" title="账号池刷新间隔" description="渠道卡与额度的刷新节奏" />
                    <IntervalRow icon={ScrollText} page="logs" title="请求日志刷新间隔" description="日志列表与统计的刷新节奏" />
                  </div>
                </div>
              )}

              {section === "look" && (
                <div>
                  <div className="mb-2.5 text-xs font-medium text-ink-faint">显示</div>
                  <div className="divide-y divide-line">
                    <ModalRow icon={Palette} title="主题" description="跟随系统或固定深浅">
                      <Segmented items={THEME_ITEMS} value={mode} onChange={select} label="主题模式" />
                    </ModalRow>
                  </div>
                </div>
              )}

              {section === "about" && (
                <div>
                  <div className="mb-2.5 text-xs font-medium text-ink-faint">信息</div>
                  <div className="divide-y divide-line">
                    {base_url && (
                      <ModalRow icon={Server} title="网关地址" description="客户端接入地址">
                        <span className="inline-flex max-w-full items-center gap-1 overflow-hidden rounded-lg border border-line bg-canvas py-0.5 pl-2.5 pr-0.5 font-mono text-xs text-ink-soft">
                          <span className="truncate">{base_url}</span>
                          <CopyButton value={base_url} label="复制 base_url" />
                        </span>
                      </ModalRow>
                    )}
                    <ModalRow icon={GithubMark} title="GitHub" description="源码仓库与版本发布">
                      <a
                        href={REPO_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="tap inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 font-mono text-xs text-ink transition-colors hover:bg-overlay"
                      >
                        <GithubMark className="h-3.5 w-3.5" />
                        bluechonk/modelmux
                      </a>
                    </ModalRow>
                    {IS_DESKTOP && webUrl && (
                      <ModalRow icon={ExternalLink} title="Web 控制台" description="在默认浏览器打开本页">
                        <a
                          href={webUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="no-drag tap inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink transition-colors hover:bg-overlay"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          在浏览器打开
                        </a>
                      </ModalRow>
                    )}
                    {version && (
                      <ModalRow
                        icon={Tag}
                        title="版本"
                        description={passiveUpdate ? `检测到新版本 ${passiveUpdate.version}` : "当前安装的版本"}
                      >
                        <span className="font-mono text-xs text-ink">v{version}</span>
                        {passiveUpdate && (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
                            <a
                              href={passiveUpdate.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs font-medium text-warn hover:underline"
                            >
                              新版 {passiveUpdate.version}
                            </a>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => void checkUpdate()}
                          disabled={checking}
                          className="tap inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink transition-colors hover:bg-overlay disabled:cursor-default disabled:opacity-60"
                        >
                          {checking ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                              检查中…
                            </>
                          ) : (
                            <>
                              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                              检查更新
                            </>
                          )}
                        </button>
                      </ModalRow>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {/* 检查更新结果：嵌套在设置弹窗之上的模态卡（非破坏性信息 + 明确主操作） */}
      <Dialog.Root
        open={updateDialog !== null}
        onOpenChange={(next) => {
          if (!next) setUpdateDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-[60] w-[min(360px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-raised p-5 shadow-2xl"
            aria-describedby={undefined}
          >
            <Dialog.Title className="flex items-baseline gap-2 text-base text-ink">
              发现新版本
              <span className="rounded-md bg-overlay px-1.5 py-0.5 font-mono text-xs text-ink-soft">
                {updateDialog?.version}
              </span>
            </Dialog.Title>
            <p className="mt-2 text-xs leading-6 text-ink-faint">
              当前 v{version} → 最新 {updateDialog?.version}。前往 GitHub Release 页下载安装包
              （安装器会自动替换，凭据保留在 ~/.modelmux 不丢）。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setUpdateDialog(null)}
                className="tap rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-overlay hover:text-ink"
              >
                下次再说
              </button>
              <a
                href={updateDialog?.url}
                target="_blank"
                rel="noreferrer"
                className="tap inline-flex items-center rounded-lg bg-overlay px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-line-strong"
              >
                前往下载页
              </a>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Dialog.Root>
  );
}
