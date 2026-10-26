/**
 * 「添加账号」登录弹窗（模态）：渲染授权步骤时间线、二维码，或两步登录的输入卡。
 *
 * ## 三种形态
 *
 * - **两步登录**（`login_input` 非空，如 loomy 短信验证码）：只渲染输入卡 ——
 *   提示 + 输入框 + 提交/取消。**不渲染步骤时间线**：用户要的就是「填这个框」，
 *   再摆一条用不上的授权步骤只会让人以为流程走错了。
 * - **扫码**（`qr_url`）：二维码 + 确认步骤。
 * - **授权链接**（`auth_url`）：复制链接 + 官方页完成 + 自动回调，**三步**
 *   （第四步「手动粘贴回调链接」已删：控制台与网关同机，回调必然到得了本机端口，
 *   粘贴框只是多余的入口 —— 2026-10-26 主人要求）。
 *
 * ## 为什么只有右上角的关闭按钮能关闭
 *
 * 遮罩点击 / ESC 一律不关（登录进行中误触丢流程比关不掉更糟），关闭时调
 * `onCancelInput` 让等待输入的渠道收尾。
 */

import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  QrCode,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { LoginInputRequest } from "../lib/types";

/** 登录态快照（后端 `GET /web/api/state` 的 `ui_state` / `auth_url` / `qr_url` 等字段）。 */
export interface LoginSnapshot {
  ui_state: string;
  message: string;
  auth_url: string;
  qr_url: string;
  /** 待回答的输入请求（两步登录）；`null` = 没有。 */
  login_input: LoginInputRequest | null;
}

/** 步骤状态：未开始 / 进行中 / 已完成 / 失败。 */
type StepState = "todo" | "active" | "done" | "failed";

/**
 * 共享层在拿到授权链接前推的准备文案（`auth-flow.ts`）。
 *
 * 两步登录等输入时它还在状态机上，但用户此刻要做的不是「等链接」——
 * 显示它只会误导，故在输入卡出现时把它藏掉。
 */
const PREPARING_MESSAGE = "正在获取授权链接...";

export function LoginModal({
  cid,
  display,
  snapshot,
  submitting,
  onStartLogin,
  onSubmitInput,
  onCancelInput,
  onClose,
}: {
  cid: string;
  display?: string;
  snapshot: LoginSnapshot | undefined;
  submitting: boolean;
  /** 弹窗打开时触发一次（走一次授权流程）。 */
  onStartLogin: (cid: string) => void;
  /** 两步登录：把用户填的内容交回后端。 */
  onSubmitInput: (value: string) => void;
  /** 关闭弹窗：让等待输入的渠道收尾（避免挂到超时）。 */
  onCancelInput: () => void;
  onClose: () => void;
}): ReactElement {
  // 打开即触发一轮登录（父组件负责防重入）
  useEffect(() => {
    onStartLogin(cid);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开/换渠道时触发一次
  }, [cid]);

  const authUrl = snapshot?.auth_url ?? "";
  const qrUrl = snapshot?.qr_url ?? "";
  const loginInput = snapshot?.login_input ?? null;
  const message = snapshot?.message ?? "";
  const uiState = snapshot?.ui_state ?? "";

  /**
   * **准备期骨架守卫**：弹窗挂载到「本轮第一个状态更新到达」之间，只画骨架。
   *
   * 不这么做的话，弹窗一打开就会闪出**上一轮**残留的 `done` / `error` /
   * 旧授权链接（后端 `triggerLogin` 是异步启动的，最长一个轮询周期 3s 里
   * 状态机里还是旧值 —— 2026-10-26 主人反馈「一开始就显示登录成功」）。
   */
  const mountState = useRef(uiState);
  const [pristine, setPristine] = useState(true);
  /**
   * 手机验证码登录的两个输入值挂在**弹窗**上：后端每换一次 `login_input`
   * （phone → code）都会重渲染，挂在子组件上会被清掉。
   */
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  /** 点过「获取验证码」：按钮转「已发送」，失败后解禁让用户重发。 */
  const [phoneSent, setPhoneSent] = useState(false);
  /** 本轮是否出现过「要手机号」的请求 —— 出现即按手机表单渲染，不再画骨架。 */
  const [phoneStep, setPhoneStep] = useState(false);
  useEffect(() => {
    if (uiState !== mountState.current || authUrl !== "" || qrUrl !== "" || loginInput) {
      setPristine(false);
    }
  }, [uiState, authUrl, qrUrl, loginInput]);
  useEffect(() => {
    if (loginInput?.kind === "phone") setPhoneStep(true);
  }, [loginInput?.kind]);
  // 发码失败就让用户能重发（否则按钮卡在「已发送」，只能关掉弹窗重来）
  useEffect(() => {
    if (uiState === "error") setPhoneSent(false);
  }, [uiState]);

  // 扫码流 2 步、授权链接流 3 步；标题栏据此给步骤提示
  /** 既没有授权链接/二维码，也没有待回答的输入 = 正在处理（准备中或渠道在发码）。 */
  const busy = !authUrl && !qrUrl && !loginInput;
  /** 本轮是手机验证码登录（渠道要过手机号/验证码）—— 用三行表单，不画步骤时间线。
   *  ⚠ 判据里带上 `loginInput.kind`：`phoneStep` 是 effect 里置的，
   *  首帧还没置上，只靠它会在第一次要输入时闪一下骨架。 */
  const phoneForm =
    (phoneStep || loginInput?.kind === "phone" || loginInput?.kind === "code") &&
    !authUrl &&
    !qrUrl;
  const failed = uiState === "error";
  const done = uiState === "done";
  const totalSteps = qrUrl ? 2 : 3;
  // 两步登录没有「授权步骤」，侧栏不能写「步骤 1/3 · 浏览器授权」——那会让人
  // 以为流程走错了（渠道此刻在等用户填手机号/验证码）。
  const stepLabel = loginInput
    ? "两步登录"
    : failed
      ? "登录失败"
      : done
        ? "登录完成"
        : busy
          ? "处理中"
          : `步骤 1 / ${totalSteps}`;
  // 渠道在做事时（如「正在发送验证码...」）把它直接写进侧栏 —— 别让侧栏说
  // 「正在准备登录会话」，主区却在转圈说另一件事。
  const stepHint = loginInput
    ? "按提示填写手机号与验证码"
    : failed
      ? "查看原因后可重新发起"
      : done
        ? "账号已自动入池"
        : message
          ? message
          : busy
            ? "正在准备登录会话"
            : qrUrl
              ? "扫码授权"
              : "浏览器授权";
  const stepTone = failed ? "text-danger" : done ? "text-free" : "text-ink";

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
            className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-[#171717] transition-colors hover:bg-brand-deep disabled:opacity-50"
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
          并完成登录。控制台与网关在同一台机器上，回调必然到得了本机端口 ——
          不需要手动粘贴任何链接。
        </span>
      ),
      state: done ? "done" : "todo",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`添加账号：${cid}`}
      // 刻意不绑 onClick 关闭：登录进行中误触遮罩会丢流程（需求：仅关闭键可关）
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]">
        {/* 标题栏：标题 + 关闭键（DeepSeek 设置弹窗的同构标题栏） */}
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-lg font-medium text-ink">添加账号</h2>
          {/* 唯一的关闭入口：顺带通知后端别再等输入（否则渠道挂到超时） */}
          <button
            type="button"
            aria-label="关闭"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
            onClick={() => {
              onCancelInput();
              onClose();
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 两栏：左侧渠道与步骤概览，右侧当前流程。
            窄屏**堆叠**（渠道行横排 + 底部描边）：左栏固定 224px 在 480px 下会把
            右侧挤到 ~200px，步骤正文与输入框都不可用。 */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex w-full shrink-0 items-start gap-3 border-b border-line px-4 py-3 md:w-56 md:flex-col md:gap-1 md:border-b-0 md:border-r md:px-3 md:py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg bg-overlay px-3 py-2.5 md:flex-none">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-overlay text-ink-soft">
                <QrCode className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate font-mono text-[13px] font-medium text-ink">{cid}</div>
                <div className="truncate text-[11px] text-ink-faint">{display ?? "渠道账号"}</div>
              </div>
            </div>
            <div className="mt-0 text-[11px] leading-relaxed text-ink-faint md:mt-2 md:px-3">
              <div className={stepTone}>{stepLabel}</div>
              <div className="mt-0.5 text-ink-faint/70">{stepHint}</div>
            </div>
          </aside>

          {/* 右侧：步骤区。准备期（含骨架守卫期间）画占位，不画上一轮的残留 */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            {pristine ? (
              <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line px-4 py-10 text-center">
                <Loader2 className="h-5 w-5 animate-spin text-ink-soft" />
                <div className="text-sm text-ink-soft">正在准备登录会话…</div>
                <div className="text-[11px] text-ink-faint">授权链接或二维码生成后会立刻出现在这里</div>
              </div>
            ) : phoneForm ? (
              /* 手机验证码登录：三行表单（手机号 / 验证码 + 获取验证码 / 登录 + 取消）。
                 后端两次顺序的 `requestInput`（先手机号 → 发码 → 再验证码）映射到三行：
                 要手机号那步「获取验证码」可点、验证码框与「登录」禁用；码发下来后二者解禁。
                 「获取验证码」点完到后端接手之间的空窗也走这里（`phoneStep` 已置位），
                 不退回骨架 —— 用户刚点了按钮，界面不能看起来没反应。 */
              <PhoneLoginForm
                phone={phone}
                code={code}
                onPhone={setPhone}
                onCode={setCode}
                codePending={loginInput?.kind === "code"}
                sent={phoneSent || loginInput?.kind === "code"}
                sending={submitting}
                onSubmitPhone={() => {
                  setPhoneSent(true);
                  onSubmitInput(phone);
                }}
                onSubmitCode={() => onSubmitInput(code)}
                onCancel={() => {
                  onCancelInput();
                  onClose();
                }}
              />
            ) : qrUrl ? (
              <Steps items={qrSteps} />
            ) : authUrl ? (
              <Steps items={authSteps} />
            ) : (
              /* 渠道在做耗时动作（如发码）但还没给出下一步：把它的进度文案显示出来，
                 而不是干巴巴的骨架 —— 否则用户会以为点了没反应（2026-10-26 主人反馈）。 */
              <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line px-4 py-10 text-center">
                <Loader2 className="h-5 w-5 animate-spin text-ink-soft" />
                <div className="text-sm text-ink-soft">{message || "正在准备登录会话…"}</div>
                <div className="text-[11px] text-ink-faint">
                  {message ? "这一步可能要几秒，请稍候" : "授权链接或二维码生成后会立刻出现在这里"}
                </div>
              </div>
            )}

            {/* 温馨提醒：中性底 + 细字，不用黄色警示块（这里不是错误） */}
            <div className="rounded-xl bg-raised p-3.5 text-xs leading-relaxed text-ink-faint">
              <div className="mb-1.5 flex items-center gap-1.5 font-medium text-ink-soft">
                <Info className="h-3.5 w-3.5" />
                提醒
              </div>
              <ul className="list-disc space-y-1 pl-4">
                <li>授权链接只会复制到剪贴板，由你自己决定在哪个浏览器打开。</li>
                <li>授权成功后会自动跳回本地回调完成登录，不需要手动粘贴任何链接。</li>
                <li>登录成功后账号自动入池并设为生效；失败时本弹窗会显示原因。</li>
              </ul>
            </div>

            {/*
              后端状态 / 错误。四种情况不显示：
              - 准备期（那还是上一轮的残留文案）；
              - 文案是共享层的「正在获取授权链接...」（与用户要做的事无关）；
              - 手机表单自己已经把状态显示出来了（按钮「发送中…/已发送」）；
              - 验证码那一步（此刻该看的是输入框，不是上一句「正在发送验证码...」）。
            */}
            {!pristine &&
              message !== PREPARING_MESSAGE &&
              loginInput?.kind !== "code" &&
              (failed || !!loginInput || !phoneForm) &&
              message && (
              <div
                className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
                  failed
                    ? "border-danger/30 bg-danger/10 text-danger"
                    : done
                      ? "border-free/25 bg-free/10 text-free"
                      : "border-line text-ink-soft"
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
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-[#171717]">
        {index}
      </span>
    );
  }
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-xs font-semibold text-ink-faint">
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
    return <div className="rounded-xl bg-raised p-3">{body}</div>;
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
    <div className="flex items-center gap-2 rounded-lg bg-canvas/60 px-2.5 py-1.5">
      <span className="shrink-0 text-[11px] text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">{url}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`复制${label}`}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
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

/**
 * 手机验证码登录表单（如 loomy）：**一个三行表单**，不是分两步的两张卡。
 *
 * ```
 * 手机号 (+86）
 * [________________________]
 * 验证码
 * [____________]  [获取验证码]
 * [   登录   ]  [   取消   ]
 * ```
 *
 * 后端仍是两次顺序的 `requestInput`（先要手机号 → 发码 → 再要验证码），
 * 这里把它映射到表单的三行：
 * - `codePending`（后端在等验证码）：验证码框与「登录」解禁；
 * - `sent`（点过「获取验证码」）：按钮变「已发送」并禁用 —— 否则用户会再点一次。
 *
 * 两个输入的值都挂在**弹窗**上（不是卡片上），否则后端换一次输入请求
 * 就会把用户刚填的内容清掉。
 */
function PhoneLoginForm({
  phone,
  code,
  onPhone,
  onCode,
  codePending,
  sent,
  sending,
  onSubmitPhone,
  onSubmitCode,
  onCancel,
}: {
  phone: string;
  code: string;
  onPhone: (value: string) => void;
  onCode: (value: string) => void;
  /** 后端已发出验证码（`login_input.kind === "code"`）。 */
  codePending: boolean;
  /** 点过「获取验证码」：按钮显示「已发送」并禁用。 */
  sent: boolean;
  /** 正在把输入交给后端（点完按钮到后端接手之间）。 */
  sending: boolean;
  onSubmitPhone: () => void;
  onSubmitCode: () => void;
  onCancel: () => void;
}): ReactElement {
  const canSend = phone.trim().length > 0 && !sent && !sending;
  const canLogin = codePending && code.trim().length > 0 && !sending;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canLogin) onSubmitCode();
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="login-phone" className="block text-[13px] font-medium text-ink">
          手机号 (+86)
        </label>
        <input
          id="login-phone"
          inputMode="tel"
          autoComplete="tel"
          autoFocus
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-canvas/60 px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="11 位手机号"
          value={phone}
          onChange={(e) => onPhone(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="login-code" className="block text-[13px] font-medium text-ink">
          验证码
        </label>
        {/* 第二行：左验证码输入框，右「获取验证码」 */}
        <div className="flex items-center gap-2">
          <input
            id="login-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            disabled={!codePending}
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas/60 px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-50"
            placeholder={codePending ? "6 位验证码" : "先获取验证码"}
            value={code}
            onChange={(e) => onCode(e.target.value)}
          />
          <button
            type="button"
            disabled={!canSend}
            onClick={onSubmitPhone}
            className="shrink-0 rounded-full bg-overlay px-4 py-2 text-[13px] font-medium text-ink-soft transition-colors hover:bg-overlay/70 hover:text-ink disabled:opacity-50"
          >
            {sending && !sent ? "发送中…" : sent ? "已发送" : "获取验证码"}
          </button>
        </div>
      </div>

      {/* 第三行：左「登录」，右「取消」 */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={!canLogin}
          className="rounded-full bg-brand px-5 py-2 text-[13px] font-medium text-[#171717] transition-colors hover:bg-brand-deep disabled:opacity-50"
        >
          {sending && codePending ? "登录中…" : "登录"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={sending}
          className="rounded-full px-4 py-2 text-[13px] text-ink-soft transition-colors hover:bg-overlay hover:text-ink disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </form>
  );
}
