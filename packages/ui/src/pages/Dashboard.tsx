/**
 * 仪表盘页：紧凑头部 + 接入端点（composer 形态）+ 一行统计 + 可用模型区。
 *
 * ## 为什么是 composer 形态
 *
 * 参照 Codex / ChatGPT 的首屏：一块大的圆角输入盒占据视觉中心，周围大量留白。
 * 这里最高频的动作是「把 base_url 抄走」，所以端点做成首屏主体；
 * 统计退到下方一行内联数据，不抢视觉权重。没有 hero 大标题 ——
 * ChatGPT 的空状态问候语只在真的空着时才出现，这里是常驻工作区。
 *
 * 模型区在 `components/ModelExplorer.tsx`：渠道分组表 / 扁平表两种视图。
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Pause, Play, RotateCw } from "lucide-react";
import { useState, type ReactElement } from "react";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { api } from "../lib/api";

/**
 * 无倍率概念（订阅制）的渠道集合：**从服务端能力位推导**，不硬编码渠道名。
 *
 * 服务端在快照的 `channel_caps` 里给出每个渠道的 `billing` 能力位
 * （`billing=false` = 订阅制，没有积分/倍率字段）。前端据此把这些渠道的模型
 * 按「免费」显示 —— 再接一个订阅制渠道，前端不用改。
 */

/** 仪表盘页：接入端点 + 网关控制 + 统计；模型列表已拆到 /models（见 Models.tsx）。
 *
 * 网关控制面板放「播放 / 暂停 / 重启」：重启 = worker 自断、监督者重生，
 * 页面短暂断开后自动恢复；暂停 = 网关进程整体退出，本页随之不可达，
 * 恢复只能在本机终端 `mx start` —— 这是架构使然，不是限制没做
 * （Web 控制台本身就是网关进程托管的一部分）。
 */
export function Dashboard(): ReactElement {
  const { data: state, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });
  const toast = useToast();
  /** 网关控制：正在执行的操作（按钮禁用 + 旋转），null = 空闲。 */
  const [busyAction, setBusyAction] = useState<"restart" | "stop" | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const control = (action: "restart" | "stop"): void => {
    setBusyAction(action);
    void api
      .gatewayControl(action)
      .then(() => {
        if (action === "restart") toast.success("正在重启网关，页面将短暂断开后自动恢复…");
      })
      .catch((err: unknown) => toast.error(String(err)))
      .finally(() => setBusyAction(null));
  };

  // 提示统一走 toast：查询失败与网关错误都弹错误提示，
  // 页面本体不再渲染自绘的常驻错误横幅。两者都是轮询驱动的持续状态 ——
  // 按**错误内容**去重（同一错误不反复弹），内容变化或恢复后再弹新的。
  const lastToastedError = useRef("");
  useEffect(() => {
    if (error) {
      const text = `加载失败：${String(error)}`;
      if (text !== lastToastedError.current) {
        lastToastedError.current = text;
        toast.error(text);
      }
      return;
    }
    const gatewayError = state?.gateway_error ?? "";
    if (!gatewayError) {
      lastToastedError.current = "";
      return;
    }
    const text = `网关错误：${gatewayError}`;
    if (text !== lastToastedError.current) {
      lastToastedError.current = text;
      toast.error(text);
    }
  }, [error, state?.gateway_error, toast]);

  if (isLoading) return <Skeleton />;
  if (error) {
    return (
      <div className="space-y-4">
        <Skeleton />
        <div className="px-1 text-sm text-ink-faint">加载失败，正在自动重试…（详情见右下角提示）</div>
      </div>
    );
  }
  if (!state) return <div className="text-ink-faint">（无数据）</div>;

  // 渠道数：池 id 的前缀去重（细节视图在 /models 的 ModelExplorer 里）
  const channelCount = new Set(
    state.models.map((full) => full.slice(0, Math.max(0, full.indexOf("/")))),
  ).size;
  const running = state.ui_state === "running";
  const totalModels = state.models.length;

  return (
    <div>
      {/* composer 形态的接入区：一整块圆角盒，端点逐行可复制。
          窄屏只留 `base_url`：`chat_url` 是它的下游路径、`endpoints` 是它的拆分，
          都是派生信息 —— 宽度不够时先砍它们（窄屏做减法）。 */}
      <section className="panel mb-7 overflow-hidden">
        <div className="space-y-1 p-4 sm:p-5">
          <EndpointRow label="base_url" value={state.base_url} />
          <div className="hidden sm:block">
            <EndpointRow label="chat_url" value={state.chat_url} />
          </div>
          <div className="hidden md:block">
            <div className="flex flex-col gap-1.5 pt-1 md:flex-row md:items-start md:gap-4">
              <span className="shrink-0 pt-0.5 text-[13px] text-ink-faint md:pt-1 md:w-24">endpoints</span>
              <div className="flex flex-wrap gap-1.5">
                {state.endpoints.map((e) => (
                  <span key={e} className="pill bg-overlay font-mono text-ink-soft">
                    {e}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="border-t border-line px-4 py-2.5 text-[13px] text-ink-faint sm:px-5">
          <span>
            {channelCount} 个渠道 · {totalModels} 个模型
            {/* 填模型形态的说明是操作指引，窄屏让位给数据本身 */}
            <span className="hidden sm:inline">
              <span> · 模型填</span>
              <span className="font-mono text-ink-soft"> 渠道/模型</span>
              <span> 形态即可</span>
            </span>
          </span>
        </div>
      </section>

      {/* 统计：一行内联数据，不是四张卡。
          窄屏只留「网关」与「可用模型」——「供给渠道」「接入端点」是派生计数，
          信息量低于宽度成本。 */}
      <div className="mb-9 flex flex-wrap items-center gap-x-6 gap-y-3 px-1 sm:gap-x-8">
        <StatInline
          label="网关"
          value={running ? "运行中" : state.ui_state}
          tone={running ? "free" : "muted"}
        />
        <StatInline label="可用模型" value={String(totalModels)} />
        <StatInline
          label="供给渠道"
          value={String(channelCount)}
          className="hidden sm:flex"
        />
        <StatInline
          label="接入端点"
          value={String(state.endpoints.length)}
          className="hidden md:flex"
        />
        <button
          type="button"
          onClick={() => void refetch()}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
        >
          <RotateCw className={`h-3.5 w-3.5 ${isRefetching ? "animate-spin" : ""}`} />
          刷新
        </button>
      </div>

      {/* 网关控制：常驻状态 + 播放/暂停/重启（原侧栏底部的「网关」行迁到这里） */}
      <section className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="pill bg-overlay text-ink">网关</span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-free" : "bg-warn"}`} />
          <span className="text-xs text-ink-soft">{running ? "运行中" : state.ui_state}</span>
          <span className="break-all font-mono text-[11px] text-ink-faint">{state.base_url}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-faint"
          >
            <Play className="h-3.5 w-3.5" />
            播放
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => setConfirmStop(true)}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            <Pause className="h-3.5 w-3.5" />
            暂停
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => control("restart")}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            <RotateCw className={`h-3.5 w-3.5 ${busyAction === "restart" ? "animate-spin" : ""}`} />
            重启
          </button>
          {busyAction !== null && <span className="text-[11px] text-ink-faint">处理中…</span>}
        </div>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          启动与停止的对称性不在 web 侧：网关停止后本页面随即不可访问，
          「播放」也就无处可点 —— 恢复需要在本机终端执行{" "}
          <code className="font-mono text-ink-faint">mx start</code>。
          重启会短暂断开页面，1 秒左右由监督进程拉起后自动恢复。
        </p>
      </section>

      {confirmStop && (
        <ConfirmDialog
          title="暂停网关？"
          body="暂停后网关进程将退出，本页面会立即不可访问；恢复需要在本机终端执行 mx start。确定要暂停吗？"
          confirmLabel="暂停"
          busy={busyAction === "stop"}
          returnFocusTo={null}
          onConfirm={() => {
            setConfirmStop(false);
            control("stop");
          }}
          onCancel={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}

/** 端点行：标签 + 值（等宽字体，可长文本换行）+ 复制按钮。
    窄屏**堆叠**（标签在上、值独占一行）：宽屏时标签固定 96px，值列被压到几像素，
    URL 会逐字换行（实测 480px 下完全不可读）。 */
function EndpointRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-lg px-1 py-1.5 transition-colors hover:bg-overlay/40 sm:flex-row sm:items-center sm:gap-4">
      <span className="shrink-0 text-[13px] text-ink-faint sm:w-24">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink-soft">{value || "—"}</span>
      <CopyInline value={value} label={`复制 ${label}`} />
    </div>
  );
}

/** 行内复制按钮：复制后短暂显示对勾（剪贴板不可用时静默失败）。 */
function CopyInline({ value, label }: { value: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默失败
    }
  };
  return (
    <button
      type="button"
      aria-label={label}
      disabled={!value}
      onClick={() => void copy()}
      className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-30"
    >
      {copied ? <Check className="h-3 w-3 text-free" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** 统计项：标签 + 等宽数值（一行数据里的一格）。
    `className` 用于窄屏隐藏派生计数（`hidden sm:flex`）。 */
function StatInline({
  label,
  value,
  tone,
  className = "",
}: {
  label: string;
  value: string;
  tone?: "free" | "muted";
  className?: string;
}): ReactElement {
  return (
    <span className={`flex items-baseline gap-2 ${className}`}>
      <span className="text-xs text-ink-faint">{label}</span>
      <span
        className={`font-mono text-sm font-medium tabular-nums ${
          tone === "free" ? "text-free" : "text-ink"
        }`}
      >
        {value}
      </span>
    </span>
  );
}

/** 加载骨架：接入盒占位。 */
export function Skeleton(): ReactElement {
  return <div className="mb-7 h-32 animate-pulse rounded-2xl border border-line bg-raised" />;
}
