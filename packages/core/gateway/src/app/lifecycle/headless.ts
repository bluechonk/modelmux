/**
 * 无窗口（headless）运行时：`login` / `serve` 子命令的实现。
 *
 * 与桌面窗口模式平行的入口层：登录/网关/控制台逻辑全部复用
 * auth-flow / cred / gateway / console，只把界面替换为 stdout 输出
 * （人类可读，或 `--json` 事件行供插件解析）与内存状态机。
 *
 * 渠道差异由注册的 `Channel` 提供。
 */

import { createInterface, type Interface } from "node:readline";

import * as authFlow from "../../auth/auth-flow.js";
import { startAutoSignin } from "../../auth/auto-signin.js";
import { captureActive, syncPool } from "../../runtime/account-pool.js";
import { runInChannel } from "../../runtime/channel-context.js";
import { channels, getChannel, hasChannel, channelCapabilities, type Channel } from "../../runtime/channel.js";
import * as console_ from "../../http/console/console.js";
import * as gateway from "../../http/server.js";
import { REPO_UI_PREFIX } from "../../runtime/cli-consts.js";
import { appendChannel, appendError, appendGateway } from "../../runtime/log-store.js";
import { credentialsPath } from "../../runtime/paths.js";
import { getPoolModelMeta } from "../../pool/pool-targets.js";

/** 输出一行 JSON 事件。解析方应跳过无法解析的行（第三方库也可能打印 stdout）。 */
function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

/**
 * 终端粘贴通道：把用户粘回来的回调链接喂给等待中的登录流程。
 *
 * 背景：微信回调页线上是 404，授权码只出现在浏览器地址栏 —— 没有浏览器的进程
 * 拿不到那个跳转，只能靠用户把链接粘回来。Web 端有输入框（`pasteCallback` 命令），
 * CLI 端就收**标准输入的一行**。
 *
 * 两种取法：
 * - TTY：用 `readline` 的 `line` 事件（按行交付，用户粘一整条 URL 回车即可）；
 * - 非 TTY（管道 / 重定向）：用 `data` 事件自己按行切分。
 *
 * ⚠ 非 TTY 也要能收：`mx relogin loomy < callback.txt` 这种用法很常见，
 * 只在 TTY 下生效等于把管道场景整个废掉。
 */
class StdinPasteReader {
  private pending: string | undefined;
  private readonly rl: Interface | null = null;
  private buffer = "";
  /** 非 TTY 分支的 data 监听（收尾时按引用摘掉）。 */
  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.pending = line;
      idx = this.buffer.indexOf("\n");
    }
  };

  constructor() {
    if (process.stdin.isTTY) {
      this.rl = createInterface({ input: process.stdin });
      this.rl.on("line", (line: string) => {
        const text = line.trim();
        if (text) this.pending = text;
      });
      return;
    }
    // 管道 / 重定向：按行切分自己收
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdin.resume();
  }

  /** 取走一行用户输入（只消费一次）；没有则返回 undefined。 */
  take(): string | undefined {
    const v = this.pending;
    this.pending = undefined;
    return v;
  }

  /** 收尾：关掉 readline / 摘掉 data 监听，避免进程挂着不退。 */
  close(): void {
    this.rl?.close();
    if (!this.rl) process.stdin.off("data", this.onData);
  }
}

/** `auth-flow.LoginUi` 协议的无界面实现：状态打到 stdout。 */
class StdoutLoginUi implements authFlow.LoginUi {
  authUrl = "";
  /** 本轮二维码图片 URL（CLI 下要打印出来，否则用户根本扫不到码）。 */
  private qrUrl = "";
  /**
   * CLI 端的粘贴通道（标准输入）。
   *
   * ⚠ **必须显式开启**（`enableStdinPaste`）：`serve` 模式也是无观察者的，
   * 若在构造时就接管 stdin，长驻守护进程会吃掉终端输入（用户没法再敲命令）。
   * 只有 `login` / `relogin` 这种「前台等人操作」的流程才该开。
   */
  private stdinPaste: StdinPasteReader | undefined;
  constructor(
    private readonly jsonMode: boolean,
    /** 多渠道路由时带上渠道 id，便于解析方区分（单渠道为 undefined）。 */
    private readonly cid?: string,
    /**
     * 额外观察者。控制台触发的登录没有终端可看，必须把状态同步进
     * `ServiceState`，否则 `GET /web/api/state` 的 auth_url 恒为空 ——
     * 页面承诺「授权链接通过轮询获取」却永远等不到。
     */
    private readonly observer?: authFlow.LoginUi,
  ) {}

  /**
   * 开启终端粘贴通道（`login` / `relogin` 用）。
   *
   * Web 端有自己的输入框（`pasteCallback` 命令），有观察者时不抢 stdin。
   */
  enableStdinPaste(): void {
    if (this.observer || this.stdinPaste) return;
    this.stdinPaste = new StdinPasteReader();
  }

  /**
   * 二维码图片 URL。
   *
   * ⚠ **CLI 下必须真的打印出来**：只转发给 observer 的话，终端里就永远拿不到
   * 扫码入口（控制台有 observer 会渲染 `<img>`，CLI 没有）。
   * 「扫码必须用这一张」——它对应本轮长轮询的 uuid，授权页每次加载都会换 uuid。
   */
  setQr(url: string): void {
    this.qrUrl = url;
    this.observer?.setQr?.(url);
    if (this.jsonMode) {
      emit({ event: "login", state: "login", message: "scan the QR code with WeChat", qr_url: url });
    } else {
      this.printQr(url);
    }
  }

  /** 打印二维码图片 URL（stdout 模式；裸 URL 单独成行便于 Ctrl+点击）。 */
  private printQr(url: string): void {
    console.log("[login] 二维码图片（用微信扫这一张，不要去开授权页）：");
    console.log(url);
  }

  /** 取走用户粘回的回调链接（转发给观察者；CLI 下从 stdin 收）。 */
  takePastedCallback(): string | undefined {
    return this.observer?.takePastedCallback?.() ?? this.stdinPaste?.take();
  }

  /** 登录结束后关掉 stdin 监听（否则进程挂着不退）。 */
  closePasteReader(): void {
    this.stdinPaste?.close();
  }

  setState(state: string, message = "", url = "", qr = ""): void {
    if (url) this.authUrl = url;
    if (qr) {
      this.qrUrl = qr;
      this.observer?.setQr?.(qr);
      if (!this.jsonMode) this.printQr(qr);
    }
    this.observer?.setState(state, message, url);
    const tag = this.cid ? `[${this.cid}] ` : "";
    if (this.jsonMode) {
      const event: Record<string, unknown> = { event: "login", state, message };
      if (this.cid) event["cid"] = this.cid;
      if (url) event["auth_url"] = url;
      if (qr) event["qr_url"] = qr;
      emit(event);
    } else {
      console.log(`[login] ${tag}${state}: ${message}`);
      // 裸 URL 单独成行：终端里可 Ctrl+点击直接打开，也可整行复制（带前缀会被一起复制走）
      if (url) console.log(url);
    }
  }
}

/** serve 模式的状态机 + 控制台桥（无界面部分）。 */
class ServiceState {
  readonly base: string;
  readonly baseUrl: string;
  readonly chatUrl: string;
  private uiState = "probing"; // 状态取值（英文枚举）：probing / login / error / running
  private stateMessage = "";
  private authUrl = "";
  private qrUrl = "";
  private gatewayError = "";
  private modelsShown: string[] = [];
  /** 用户粘回的回调链接（一次性消费，见 `takePastedCallback`）。 */
  private pastedCallback = "";
  retryRequested = false;
  quitting = false;

  constructor(addr: string) {
    const described = gateway.describe(addr);
    this.base = described.base;
    this.baseUrl = `${described.url}/v1`;
    this.chatUrl = `${described.url}/v1/chat/completions`;
  }

  setState(state: string, message = "", url = ""): void {
    this.uiState = state;
    this.stateMessage = message;
    if (url) this.authUrl = url; // 后续状态不带 url 时沿用上一条授权链接
    else if (state !== "login") this.authUrl = ""; // 登录结束/失败后清掉旧授权链接
    if (state !== "login") this.clearQr();
    if (state === "running") this.gatewayError = "";
  }

  /** 设置本轮扫码的二维码图片 URL（真正该给用户扫的那张）。 */
  setQr(url: string): void {
    this.qrUrl = url;
  }

  /** 登录结束后清掉上一轮的二维码，避免界面显示已过期的码。 */
  clearQr(): void {
    this.qrUrl = "";
  }

  /** 供登录流程取走用户粘回的回调链接（只消费一次）。 */
  takePastedCallback(): string | undefined {
    const v = this.pastedCallback;
    this.pastedCallback = "";
    return v || undefined;
  }

  /** Web 端提交回调链接（用户在 404 页复制地址栏后粘进来）。 */
  submitPastedCallback(raw: string): void {
    this.pastedCallback = raw;
  }

  setGatewayError(error: string): void {
    this.gatewayError = error;
  }

  snapshot(): console_.UiSnapshot {
    const base = console_.emptySnapshot();
    return {
      ...base,
      ui_state: this.uiState,
      message: this.stateMessage,
      auth_url: this.authUrl,
      qr_url: this.qrUrl,
      base_url: this.baseUrl,
      chat_url: this.chatUrl,
      models: [...this.modelsShown],
      model_info: Object.fromEntries(this.modelsShown.map((id) => [id, getPoolModelMeta(id)])),
      channel_caps: Object.fromEntries(
        channels().map((channel) => [channel.config.cid, channelCapabilities(channel.config)]),
      ),
      gateway_error: this.gatewayError,
    };
  }

  setModels(ids: string[]): void {
    this.modelsShown = ids;
  }
}

/**
 * 登录后入池（幂等）。
 *
 * ⚠ 必须包 `runInChannel`：`captureActive` / `syncPool` 内部走 `cred.load()` →
 * `paths.*`，而这些在多渠道模式下靠 ALS 上下文才知道为谁解析。
 *
 * 入池失败**不影响登录结果**（登录本身已成功），但必须留痕：静默吞掉时症状是
 * 「登录了但池子是空的」，外部无从判断。
 */
function captureIntoPool(cid: string): void {
  try {
    runInChannel(cid, () => {
      // 登录成功即入池并恢复健康度（重新授权同一账号也要把 error 清掉）
      captureActive(cid);
      syncPool(cid);
    });
  } catch (err) {
    console.error(`[login] account pool sync failed (${cid}): ${String(err)}`);
  }
}

/** 无窗口完成登录并保存凭证；成功返回 0。 */
export async function runLogin(options: {
  force?: boolean;
  json?: boolean;
  realm?: string;
  /** 渠道 id（多渠道路由时必须给；单渠道可省）。 */
  cid?: string;
  /** 微信扫码登录（渠道声明 `cred.loginWechat` 才支持，如 loomy）。 */
  wechat?: boolean;
  /**
   * 状态观察者：把登录状态额外同步给调用方（控制台需要它填 `auth_url`）。
   * 省略时行为与以前一致，只打 stdout。
   */
  observer?: authFlow.LoginUi;
} = {}): Promise<number> {
  const { force = false, json = false, realm = "auto", cid, wechat = false, observer } = options;
  const target = getChannel(cid);
  const { cred } = target;
  if (force) {
    try {
      const fs = await import("node:fs");
      fs.unlinkSync(credentialsPath(cid));
    } catch {
      /* 本来就没有 */
    }
  }

  // 微信路径：渠道自己声明了 loginWechat 才能走（共享层不含渠道知识）
  if (wechat) {
    const loginWechat = cred.loginWechat;
    if (!loginWechat) {
      console.error(`[login] channel ${target.config.cid} does not support --wechat login`);
      return 1;
    }
    const ui = new StdoutLoginUi(json, cid, observer);
    // CLI 下开终端粘贴通道：回调页是 404，授权码只在浏览器地址栏里，
    // 用户粘回终端才能让流程收尾（无观察者时这是唯一出路）。
    ui.enableStdinPaste();
    if (json) emit({ event: "start", mode: "login", force, realm, wechat: true, ...(cid ? { cid } : {}) });
    let ok = false;
    try {
      await runInChannel(target.config.cid, () =>
        loginWechat.call(cred, cred.resolveBaseUrl(realm), {
          // ⚠ auth_url 只是「授权页在哪」；扫码必须用 onQr 给的那张 —— 授权页每次
          // 加载都会新生成 uuid，扫那一张的码与本轮长轮询不是同一个会话。
          onUrl: (url: string) => ui.setState("login", "open this URL if you need the authorization page", url),
          onQr: (qr: string) => ui.setState("login", "scan the QR code with WeChat and confirm on your phone", "", qr),
          onStatus: (msg: string) => ui.setState("login", msg),
          // 长轮询拿不到时的兜底：让界面能把用户粘回的回调链接喂进来。
          // ⚠ 走 `ui` 而不是直接摸 `observer`：CLI 下没有 observer，但 stdin
          // 也是一条能用的粘贴通道（否则终端用户根本无处可贴）。
          pasteCode: () => ui.takePastedCallback?.(),
        }),
      );
      ok = true;
    } catch (err) {
      ui.setState("error", `wechat login failed: ${String(err)}`);
    } finally {
      ui.closePasteReader();
    }
    if (ok && target) {
      captureIntoPool(target.config.cid);
      ui.setState("done", "登录成功，账号已入池。", "", "");
    }
    if (json) {
      const done: Record<string, unknown> = { event: "done", ok };
      if (ui.authUrl) done["auth_url"] = ui.authUrl;
      if (ok) {
        try {
          // ⚠ 必须包渠道上下文：渠道的 `cred.load()` 内部用无参 `paths.*` 解析落点，
          // 裸调在仓库级多渠道模式下会抛错 → uid/domain/obtained_at **永远缺失**。
          const c = runInChannel(target.config.cid, () => cred.load());
          done["uid"] = c.uid;
          done["domain"] = c.domain;
          done["obtained_at"] = (c as { obtainedAt?: string }).obtainedAt ?? "";
        } catch {
          /* 读不到就不附 */
        }
      }
      emit(done);
    } else if (ok) {
      console.log("[login] done.");
    }
    return ok ? 0 : 1;
  }

  const ui = new StdoutLoginUi(json, cid, observer);
  // 同上：CLI 前台登录要能接收用户粘回的回调链接。
  ui.enableStdinPaste();
  if (json) emit({ event: "start", mode: "login", force, realm, ...(cid ? { cid } : {}) });

  // 已有凭据且未 force：login 是幂等的，不会重新授权 —— 必须明确说清，
  // 否则用户看到 "done" 以为重登成功，实际用的还是旧凭据（实测踩过：
  // codearts token 过期后 `login` 秒回 done，浏览器根本没开）。
  if (!force) {
    let existing: ReturnType<typeof cred.load> | null = null;
    try {
      existing = runInChannel(target.config.cid, () => cred.load());
    } catch {
      /* 未登录：走正常登录流程 */
    }
    if (existing) {
      const uid = (existing as { uid?: string }).uid ?? "";
      if (json) {
        emit({ event: "done", ok: true, already_logged_in: true, note: "use `relogin` to re-authorize" });
      } else {
        console.log(
          `[login] 已有凭据${uid ? `（uid ${uid}）` : ""}，未做任何操作；` +
            `要重新授权（如 token 过期）用：mx relogin ${cid ?? "<cid>"}`,
        );
      }
      return 0;
    }
  }

  const ok = await runInChannel(target.config.cid, () =>
    authFlow.ensureLogin(ui, {
      interactive: true,
      baseUrl: cred.resolveBaseUrl(realm),
      ...(cid !== undefined ? { cid } : {}),
    }),
  ).finally(() => {
    // 登录结束（成败都算）：关掉 stdin 监听，否则进程挂着不退。
    ui.closePasteReader();
  });

  // 登录即入池：把刚拿到的凭证收进账号池（幂等；失败不影响登录结果）。
  // ⚠ 必须包 `runInChannel`：`syncPool` 内部走 `cred.load()` → `paths.*`，
  // 而这些在多渠道模式下靠 ALS 上下文才知道为谁解析。
  if (ok && target) {
    captureIntoPool(target.config.cid);
    ui.setState("done", "登录成功，账号已入池。", "", "");
  } else {
    ui.setState("error", "登录失败，请重试。", "", "");
  }

  if (json) {
    const done: Record<string, unknown> = { event: "done", ok };
    if (ui.authUrl) done["auth_url"] = ui.authUrl;
    if (ok) {
      try {
        // ⚠ 必须包渠道上下文：渠道的 `cred.load()` 内部用无参 `paths.*` 解析落点，
        // 裸调在仓库级多渠道模式下会抛错 → uid/domain/obtained_at **永远缺失**。
        const c = runInChannel(target.config.cid, () => cred.load());
        done["uid"] = c.uid;
        done["domain"] = c.domain;
        // obtainedAt 是可选字段（契约只要求 accessToken/uid/domain）
        done["obtained_at"] = (c as { obtainedAt?: string }).obtainedAt ?? "";
      } catch {
        /* 读不到就不附 */
      }
    }
    emit(done);
  } else if (ok) {
    console.log("[login] done.");
  }
  return ok ? 0 : 1;
}

export interface ServeOptions {
  addr: string;
  verbose: boolean;
  ensureLogin?: boolean;
  forceLogin?: boolean;
  json?: boolean;
  consoleEnabled?: boolean;
  realm?: string;
  /** 渠道 id：指定则只服务该渠道；省略 = 全部已注册渠道（仓库级网关）。 */
  cid?: string;
}

/**
 * 无窗口运行：控制台（可选）+ 登录检查 + 网关，直到进程被终止。
 *
 * 默认只**被动探测**登录状态；`ensureLogin`/`forceLogin` 时未登录会引导
 * 交互授权 —— 授权链接打到 stdout（不自动打开浏览器，由用户自行打开）。
 *
 * 多渠道路由（未指定 `cid` 且注册了多个渠道）时：逐个渠道探测/引导登录，
 * **任一渠道登录成功即启动网关** —— 未登录的渠道在请求时由网关返回 503
 * `not_authenticated`，不影响其它渠道。
 */
export async function runServe(options: ServeOptions): Promise<number> {
  const {
    addr,
    verbose,
    ensureLogin = false,
    forceLogin = false,
    json = false,
    consoleEnabled = true,
    realm = "auto",
    cid,
  } = options;
  const targets: Channel[] = cid !== undefined ? [getChannel(cid)] : channels();
  const multi = targets.length > 1;
  const prefix = `[${gateway.serviceName(cid)}]`;
  const logCid = cid ?? (targets.length === 1 ? targets[0]!.config.cid : undefined);

  /** 运行日志同时落「按日 gateway.log / 渠道日志 / 错误日志」；控制台保留。 */
  const logLine = (message: string): void => {
    const line = `${prefix} ${message}`;
    appendGateway(line);
    if (logCid) {
      appendChannel(logCid, line);
    } else {
      // 多渠道路由：消息自带 `[cid]` 前缀时落到该渠道的日志目录
      const match = /^\[([a-z0-9][a-z0-9.-]*)\]/.exec(message);
      if (match && hasChannel(match[1])) appendChannel(match[1]!, line);
    }
    if (/(error|failed|timeout|reject|aborted|exception|unauthor)/i.test(line)) {
      appendError(line);
    }
    if (!json) console.error(line);
  };

  const state = new ServiceState(addr);
  if (json) emit({ event: "start", mode: "serve", addr, ui_prefix: REPO_UI_PREFIX, ...(cid ? { cid } : {}) });

  const bridge: console_.ControlBridge = {
    provider: () => state.snapshot(),
    setTheme: () => {}, // 无窗口模式没有主题
    retryLogin: () => {
      state.retryRequested = true;
    },
    // 控制台的「登录」按钮经此回调触发真实登录流程（本函数在 app 层，
    // 控制台层不认识它 —— 见 scripts/verify-layering.mjs）
    triggerLogin: (cid, force) => {
      // 把 state 当观察者传给登录流程：控制台没有 stdout 可看，
      // 授权链接必须落到 `/web/api/state`，否则页面永远等不到 auth_url。
      void runLogin({ cid, force, json: true, realm: "auto", observer: state }).catch(() => {
        // 登录失败会反映在后续 /web/api/state 的 auth_url 或 gateway_error 上
      });
    },
    // 用户把回调链接粘回来 → 交给正在跑的那轮登录（一次性 code 的兜底通道）
    submitCallback: (raw) => state.submitPastedCallback(raw),
  };
  // 单端口模式：控制台 handler 挂载进网关的 /web 前缀（不再起独立 server）。
  // `consoleEnabled=false`（--no-console）时不注入，网关保持纯 API 行为。
  const consoleHandler = consoleEnabled
    ? console_.createConsoleHandler(bridge, REPO_UI_PREFIX)
    : null;

  let running: gateway.RunningGateway | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.quitting = true;
    await running?.close().catch(() => {});
  };

  // 终止源统一化：SIGINT/SIGTERM/SIGHUP 与「监督者消失（IPC 断开）」都汇入 stopped，
  // 走同一条优雅停机。监督者场景：spawn 带 IPC fd（stdio 第 4 项），监督者被杀即触发
  // disconnect —— worker 干净离场、无人重生（见 docs/DAEMON-SUPERVISOR.md §4）。
  // 裸 `mx serve` 无 IPC，不挂此钩子，保持纯信号语义。
  let stopSignalled = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    stopSignalled = resolve;
  });
  let stopReason: string | undefined;
  process.on("SIGINT", stopSignalled);
  process.on("SIGTERM", stopSignalled);
  process.on("SIGHUP", stopSignalled);
  if (typeof process.send === "function") {
    // IPC 场景 = 有监督进程：① 父端主动断开（disconnect）可瞬时感知；
    // ② 但 Windows 下父进程被杀/自退不保证触发 disconnect（实测），故叠加
    //    应用层心跳超时 —— 收不到监督者的 supervisor-ping 即判父死，保证收敛。
    let lastPing = Date.now();
    process.on("message", (m: unknown) => {
      if (m && typeof m === "object" && (m as { type?: string }).type === "supervisor-ping") {
        lastPing = Date.now();
      }
    });
    process.once("disconnect", () => {
      stopReason = "supervisor-gone";
      stopSignalled();
    });
    const WATCHDOG_MS = 8_000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastPing > WATCHDOG_MS) {
        stopReason = "supervisor-gone";
        stopSignalled();
      }
    }, 2_000);
    watchdog.unref(); // 不阻碍 shutdown 后的事件循环清空退出
  }

  // 登录 + 网关：成功前按 retry 循环（未登录时控制台仍可用）
  const worker = async (): Promise<void> => {
    for (;;) {
      let anyOk = false;
      // 并行探测所有渠道登录态：单渠道卡网络/授权不再阻塞其余渠道与端口监听，
      // 把最慢启动从「串行累加」压到「单路最慢」（实测 30s → ~5s）。
      // 各路在 runInChannel(cid) 内独立运行（AsyncLocalStorage 上下文隔离），无共享可变状态。
      await Promise.all(
        targets.map((channel) => {
          const { cred } = channel;
          const ui = new StdoutLoginUi(json, multi ? channel.config.cid : cid);
          return runInChannel(channel.config.cid, () =>
            authFlow.ensureLogin(ui, {
              interactive: ensureLogin || forceLogin,
              passiveNoProbe: true,
              ...(ensureLogin || forceLogin ? { baseUrl: cred.resolveBaseUrl(realm) } : {}),
              cid: channel.config.cid,
            }),
          ).then((ok) => {
            if (ok) anyOk = true;
            if (multi && !json) {
              console.log(`${prefix} [${channel.config.cid}] ${ok ? "logged in" : "not logged in"}`);
            }
          });
        }),
      );
      if (state.quitting) return;
      if (anyOk) break;
      // 等「重试登录」意图（或进程被终止）
      while (!state.retryRequested && !state.quitting) {
        await new Promise((r) => setTimeout(r, 500));
      }
      state.retryRequested = false;
      if (state.quitting) return;
    }
    if (state.quitting) return;
    try {
      running = await gateway.start(addr, {
        verbose,
        logger: logLine,
        ...(consoleHandler ? { console: consoleHandler, consolePrefix: REPO_UI_PREFIX } : {}),
      });
    } catch (err) {
      state.setGatewayError(String(err));
      state.setState("error", `gateway start failed: ${String(err)}`);
      if (json) emit({ event: "error", message: `gateway start failed: ${String(err)}` });
      return;
    }
    state.setState("running");
    if (json) {
      emit({
        event: "ready",
        gateway: `http://${state.base}`,
        console: consoleEnabled ? `http://${state.base}${REPO_UI_PREFIX}/` : "",
      });
    }
    // 网关 ready 即挂自动签到：逐渠道（未登录跳过 / 台账已签跳过 / 连败 3 次当日熔断）
    startAutoSignin(logLine);

    // 目录保鲜：每天后台重拉一次各渠道模型目录（实现了 catalog.refresh 的渠道才拉），
    // 渠道上游加了新模型时无需手动 `--refresh`。失败静默保留旧表（下次再试）。
    const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
    const catalogTimer = setInterval(() => {
      if (state.quitting) return;
      for (const channel of targets) {
        const refresh = channel.catalog.refresh;
        if (!refresh) continue; // 内置表渠道没有远端目录层
        void runInChannel(channel.config.cid, () => refresh.call(channel.catalog)).catch(() => {
          /* 拉取失败：旧表继续用，下个周期再试 */
        });
      }
    }, CATALOG_REFRESH_MS);
    catalogTimer.unref?.(); // 不阻止进程退出
    // 运行态轮询本地 /v1/models 把可用模型喂给控制台
    for (;;) {
      if (state.quitting) return;
      try {
        const resp = await fetch(`http://${state.base}/v1/models`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.status === 200) {
          const payload = (await resp.json()) as { data?: Array<{ id?: string }> };
          const ids = (payload.data ?? []).map((m) => m.id ?? "").filter(Boolean);
          if (ids.length > 0) state.setModels(ids);
        }
      } catch {
        /* 轮询失败下轮再试 */
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  };

  void worker().catch((err) => {
    console.error(`${prefix} worker error: ${String(err)}`);
  });

  // 主线程阻塞直到终止源（信号 / 监督者消失）
  await stopped;

  await shutdown();
  if (json) emit({ event: "stopped", ...(stopReason ? { reason: stopReason } : {}) });
  return 0;
}
