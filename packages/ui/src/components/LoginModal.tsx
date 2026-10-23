/**
 * 「添加账号」登录弹窗（模态）：渲染授权步骤时间线与二维码 / 授权链接。
 *
 * ⚠ 只有右上角的关闭按钮能关闭 —— 遮罩点击 / ESC 一律不关（登录进行中误触
 * 丢流程比关不掉更糟）。授权页渲染成**按钮**而不是裸 URL。
 */

import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Lightbulb,
  Loader2,
  QrCode,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

/** 登录态快照（后端 `GET /web/api/state` 的 `ui_state` / `auth_url` / `qr_url` 等字段）。 */
export interface LoginSnapshot {
  ui_state: string;
  message: string;
  auth_url: string;
  qr_url: string;
}

/** 步骤状态：未开始 / 进行中 / 已完成 / 失败。 */
type StepState = "todo" | "active" | "done" | "failed";

export function LoginModal({
  cid,
  display,
  snapshot,
  submitting,
  onStartLogin,
  onSubmitCallback,
  onClose,
}: {
  cid: string;
  display?: string;
  snapshot: LoginSnapshot | undefined;
  submitting: boolean;
  /** 弹窗打开时触发一次（走一次授权流程）。 */
  onStartLogin: (cid: string) => void;
  onSubmitCallback: (url: string) => void;
  onClose: () => void;
}): ReactElement {
  // 打开即触发一轮登录（父组件负责防重入）
  useEffect(() => {
    onStartLogin(cid);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开/换渠道时触发一次
  }, [cid]);

  const authUrl = snapshot?.auth_url ?? "";
  const qrUrl = snapshot?.qr_url ?? "";
  const message = snapshot?.message ?? "";
  const uiState = snapshot?.ui_state ?? "";
  const preparing = !authUrl && !qrUrl;
  const failed = uiState === "error";
  const done = uiState === "done";

  /** 点「复制授权链接」：只写剪贴板，**不**打开新窗口（主人 2026-10-23 要求）。 */
  const [authCopied, setAuthCopied] = useState(false);
  const copyAuthUrl = async (): Promise<void> => {
    if (authUrl === "") return;
    try {
      await navigator.clipboard.writeText(authUrl);
      setAuthCopied(true);
      setTimeout(() => setAuthCopied(false), 1800);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默失败，用户仍可手动复制下面那一行
    }
  };
  // 二维码流 3 步、授权链接流 4 步；标题栏据此给步骤提示
  const totalSteps = qrUrl ? 3 : 4;
  const stepLabel = failed
    ? "登录失败"
    : done
      ? "登录完成"
      : preparing
        ? "准备中"
        : `步骤 1 / ${totalSteps}`;
  const stepHint = failed
    ? "查看原因后可重新发起"
    : done
      ? "账号已自动入池"
      : preparing
        ? "正在准备登录会话"
        : qrUrl
          ? "扫码授权"
          : "浏览器授权";
  const stepTone = failed ? "text-danger" : done ? "text-free" : "text-brand";

  // 扫码流：扫码 → 手机确认 → 自动入池
  const qrSteps: Array<{ title: string; body: ReactNode; state: StepState }> = [
    {
      title: "用微信扫这张二维码",
      body: (
        <div className="flex justify-center">
          <img src={qrUrl} alt="登录二维码" className="h-44 w-44 rounded-lg bg-white p-2" />
        </div>
      ),
      state: done ? "done" : failed ? "failed" : "active",
    },
    { title: "在手机上确认登录", body: null, state: done ? "done" : "todo" },
    {
      title: "等待自动完成",
      body: (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
          {done ? (
            <Check className="h-3.5 w-3.5 text-free" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
          授权成功后账号会自动入池，本弹窗可随时关闭
        </span>
      ),
      state: done ? "done" : "todo",
    },
  ];

  // 授权链接流：**复制链接** → 自己粘到浏览器 → 登录授权 → 自动回调 → 手动兜底
  // ⚠ 不再用 window.open / target=_blank 弹新窗口（主人 2026-10-23 要求）：
  //    点击只做「复制到剪贴板」，由用户自己决定在哪个浏览器/窗口打开。
  const authSteps: Array<{ title: string; body: ReactNode; state: StepState }> = [
    {
      title: "复制授权链接",
      body: (
        <div className="space-y-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-canvas transition-colors hover:bg-brand/85 disabled:opacity-50"
            disabled={authUrl === ""}
            onClick={() => void copyAuthUrl()}
            aria-label="复制授权链接到剪贴板"
          >
            {authCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {authCopied ? "已复制，粘到浏览器打开" : "复制授权链接"}
          </button>
          <CopyableLink url={authUrl} label="授权链接" />
        </div>
      ),
      state: done ? "done" : failed ? "failed" : "active",
    },
    { title: "在官方页面完成登录 / 授权", body: null, state: done ? "done" : "todo" },
    {
      title: "自动回调（无需手动）",
      body: (
        <span className="text-[11px] leading-relaxed text-ink-faint">
          授权成功后页面会<strong className="text-ink-soft">自动跳回本地回调</strong>
          并完成登录。若浏览器拦截跳转，再复制地址栏链接到下一步。
        </span>
      ),
      state: done ? "done" : "todo",
    },
    {
      title: "手动粘贴回调链接（仅自动跳转失败时）",
      body: (
        <CallbackForm
          onSubmit={onSubmitCallback}
          submitting={submitting}
          placeholder="粘贴地址栏里的整条回调链接"
        />
      ),
      // 失败时把「手动兜底」提为当前步骤
      state: failed ? "active" : "todo",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`添加账号：${cid}`}
      // 刻意不绑 onClick 关闭：登录进行中误触遮罩会丢流程（需求：仅关闭键可关）
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_24px_64px_-28px_rgba(0,0,0,0.8)]">
        {/* 标题栏：渠道名 + 步骤提示 */}
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand">
            <QrCode className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">添加账号</span>
              <span className="pill bg-brand/12 font-mono text-brand">{cid}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
              {display && <span className="truncate">{display}</span>}
              <span className={stepTone}>{stepLabel}</span>
              <span className="text-ink-faint/70">{stepHint}</span>
            </div>
          </div>
          {/* 唯一的关闭入口 */}
          <button
            type="button"
            aria-label="关闭"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 步骤区 */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {qrUrl ? (
            <Steps items={qrSteps} />
          ) : authUrl ? (
            <Steps items={authSteps} />
          ) : (
            <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line bg-canvas/60 px-4 py-10 text-center">
              <Loader2 className="h-5 w-5 animate-spin text-brand" />
              <div className="text-sm text-ink-soft">正在准备登录会话…</div>
              <div className="text-[11px] text-ink-faint">授权链接与二维码生成后会立刻出现在这里</div>
            </div>
          )}

          {/* 温馨提醒 */}
          <div className="rounded-xl border border-warn/25 bg-warn/8 p-3 text-xs leading-relaxed text-warn/85">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-warn">
              <Lightbulb className="h-3.5 w-3.5" />
              温馨提醒
            </div>
            <ul className="list-disc space-y-1 pl-4 text-warn/75">
              <li>如果浏览器拦截了新窗口，回到步骤 1 再点一次「打开授权页」即可。</li>
              <li>授权成功后会自动跳回本地回调完成登录；若跳转被拦截，复制地址栏链接粘贴。</li>
              <li>登录成功后账号自动入池并设为生效；失败时本弹窗会显示原因。</li>
            </ul>
          </div>

          {/* 后端状态 / 错误 */}
          {message && (
            <div
              className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
                failed
                  ? "border-danger/30 bg-danger/10 text-danger"
                  : done
                    ? "border-free/25 bg-free/10 text-free"
                    : "border-line bg-canvas/60 text-ink-soft"
              }`}
            >
              {failed ? (
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : done ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
              )}
              <span className="min-w-0 break-words">{message || (failed ? "登录失败" : "进行中…")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 步骤时间线：状态徽标 + 标题 + 可选正文。 */
function Steps({
  items,
}: {
  items: Array<{ title: string; body: ReactNode; state: StepState }>;
}): ReactElement {
  return (
    <ol className="space-y-1">
      {items.map((item, i) => (
        <li key={item.title} className="flex gap-3">
          <div className="flex flex-col items-center">
            <StepBadge state={item.state} index={i + 1} />
            {i < items.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}
          </div>
          <div className="min-w-0 flex-1 pb-4">
            <div className={stepTitleClass(item.state)}>{item.title}</div>
            {item.body && <div className="mt-2">{stepBody(item.state, item.body)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 步骤徽标：已完成打勾 / 失败叉号 / 进行中带圈 / 待办弱化。 */
function StepBadge({ state, index }: { state: StepState; index: number }): ReactElement {
  if (state === "done") {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-free/12 text-free">
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-danger/12 text-danger">
        <X className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand/12 text-xs font-semibold text-brand ring-1 ring-brand/30">
        {index}
      </span>
    );
  }
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line bg-canvas text-xs font-semibold text-ink-faint">
      {index}
    </span>
  );
}

/** 步骤标题层级：当前步骤最重，已完成次之，待办最弱。 */
function stepTitleClass(state: StepState): string {
  if (state === "active") return "text-sm font-semibold text-ink";
  if (state === "failed") return "text-sm font-semibold text-danger";
  if (state === "done") return "text-sm font-medium text-ink-soft";
  return "text-sm font-medium text-ink-faint";
}

/** 步骤正文容器：当前步骤 / 失败步骤各自染色，其余保持中性。 */
function stepBody(state: StepState, body: ReactNode): ReactNode {
  if (state === "active") {
    return <div className="rounded-xl border border-brand/25 bg-brand/8 p-3">{body}</div>;
  }
  if (state === "failed") {
    return <div className="rounded-xl border border-danger/25 bg-danger/8 p-3">{body}</div>;
  }
  return body;
}

/** 可点击复制的链接：等宽字体 + 复制反馈（剪贴板不可用时静默失败）。 */
function CopyableLink({ url, label }: { url: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默失败，不打断浏览
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas/70 px-2.5 py-1.5">
      <span className="shrink-0 text-[11px] text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">{url}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`复制${label}`}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-brand"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-free" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

/** 回调链接粘贴表单。 */
function CallbackForm({
  onSubmit,
  submitting,
  placeholder,
}: {
  onSubmit: (url: string) => void;
  submitting: boolean;
  placeholder: string;
}): ReactElement {
  const [value, setValue] = useState("");
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <label htmlFor="login-callback-url" className="block text-[11px] text-ink-faint">
        回调链接（整条 URL）
      </label>
      <div className="flex gap-2">
        <input
          id="login-callback-url"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-brand/50 focus:outline-none"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-brand px-3 py-2 text-xs font-medium text-canvas transition-colors hover:bg-brand/85 disabled:opacity-50"
          disabled={submitting || !value.trim()}
        >
          完成登录
        </button>
      </div>
    </form>
  );
}
