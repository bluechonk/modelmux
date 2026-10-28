/**
 * 登录流程骨架：三类授权链路的**渠道无关骨架**（本地回调 / flow 轮询 / 设备码轮询）。
 *
 * 边界：骨架只负责**流程控制**（起本地端口、按间隔轮询、判终态、超时、退避）；
 * 请求怎么发、URL 怎么拼、响应怎么解析、token 怎么换都是渠道知识，由调用方回调注入。
 *
 * ⚠ 各渠道保留自己的 `login()` 与导出签名（如带本地回调服务器的渠道的
 * `startCallbackServer({pkce,keyPair,ticketId})`），薄包装转发到这里的骨架，
 * 以免破坏已有 import 站点与测试引用。
 */

import { createServer, type Server } from "node:http";

import { REPO_DEFAULT_ADDR, REPO_UI_PREFIX } from "../runtime/cli-consts.js";

// ── A. 本地回调服务器 ─────────────────────────────────────────────────────────

/** 本地回调服务器：等浏览器重定向回本机端口，取出 query 参数。 */
export interface CallbackServer {
  /** 实际监听端口（请求 0 或端口被占时会退到随机端口，**调用方须用此值重算 URL**）。 */
  readonly port: number;
  /** 等首个回调（超时抛错）。同名参数取第一个。 */
  wait(timeoutMs: number): Promise<Record<string, string>>;
  /** 关闭服务器（幂等；未等到回调时会让 wait 拒绝）。 */
  close(): void;
}

/**
 * 启动本地回调服务器。
 *
 * @param options.port      期望端口；被占用（EADDRINUSE/EACCES）时自动退到随机端口
 * @param options.pathPrefix 只处理该路径前缀的请求，其它回 404（缺省全部接受）
 * @param options.html      回给浏览器的页面（缺省一句「可以关闭本页」）
 */
export async function startCallbackServer(
  options: { port?: number; pathPrefix?: string; html?: string } = {},
): Promise<CallbackServer> {
  const { port = 0, pathPrefix, html = DEFAULT_CALLBACK_HTML } = options;

  let settle: (value: Record<string, string>) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const params = new Promise<Record<string, string>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // close() 可能早于 wait()：先吞掉，避免 unhandled rejection 噪音
  void params.catch(() => {});
  let settled = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (pathPrefix && !url.pathname.startsWith(pathPrefix)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in flat)) flat[key] = value; // 同名参数取第一个
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    if (!settled) {
      settled = true;
      settle(flat);
    }
  });

  let actualPort: number;
  try {
    actualPort = await listenOn(server, port);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    actualPort = await listenOn(server, 0);
  }

  return {
    port: actualPort,
    wait(timeoutMs: number): Promise<Record<string, string>> {
      return new Promise<Record<string, string>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`timed out waiting for the authorization callback (${Math.round(timeoutMs / 1000)}s)`));
          }
        }, timeoutMs);
        params.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    },
    close(): void {
      try {
        server.close();
        server.closeAllConnections?.();
      } catch {
        /* 已关闭 */
      }
      if (!settled) {
        settled = true;
        fail(new Error("callback server closed"));
      }
    },
  };
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address() as { port: number } | null;
      resolve(address?.port ?? port);
    });
  });
}

/**
 * 回调落地页：授权成功后浏览器**必然**落在 `redirect_uri` 上（OAuth 只能这么传授权码），
 * 所以这一页的作用是「尽量不被看见 + 看见时不误导」。
 *
 * 三件事：
 * 1. **立即尝试自关**（`window.close()`）—— 只有脚本打开的窗口能关掉，用户手开的标签页
 *    会被浏览器拒绝，那就留在成功态让用户自己关；
 * 2. **深色单页**：与 Web 控制台同一套令牌（近黑底 + 语义色），不是裸 `<h1>`；
 * 3. **给退路**：「返回控制台」直达 `/web/`，「关闭本页」再试一次自关。
 *
 * 为什么放在共享层而不是各渠道自写：落地页要与 Web 控制台同一套令牌与文案，
 * 各写一份的话，改一处（比如控制台地址变了）要改四处，失败态文案还会有多套口径。
 */
export type CallbackPageKind = "ok" | "fail";

/** 回调页图标（内联 SVG，无外部资源 —— 落地页必须离线可用）。 */
function callbackMarkSvg(kind: CallbackPageKind): string {
  const path =
    kind === "ok"
      ? '<path d="M20 6 9 17l-5-5"/>'
      : '<path d="M12 8v5"/><path d="M12 16.5v.01"/>' +
        '<path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>';
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    path +
    "</svg>"
  );
}

/** HTML 转义：失败原因来自上游/渠道，必须转义后才进页面。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 拼回调落地页。`detail` 只在失败态用（上游/渠道给的失败原因）。
 *
 * ⚠ 控制台地址取**仓库级默认**（`REPO_DEFAULT_ADDR`）：单渠道独立运行时端口可能不同，
 *    那时这个链接只是「指个方向」，点不动也不影响登录本身（登录早已完成）。
 */
export function callbackPageHtml(kind: CallbackPageKind, detail = ""): string {
  const ok = kind === "ok";
  const consoleUrl = `http://${REPO_DEFAULT_ADDR}${REPO_UI_PREFIX}/`;
  const title = ok ? "登录成功" : "登录未完成";
  const lead = ok
    ? "账号已入池，可以关闭本页。"
    : detail
      ? escapeHtml(detail)
      : "登录流程没有走完，请回到控制台查看原因。";
  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>modelmux · ${title}</title><style>` +
    ":root{color-scheme:dark}*{box-sizing:border-box}" +
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#212121;color:#ececec;" +
    "font:14px/1.6 ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",\"Noto Sans SC\",sans-serif}" +
    ".card{width:min(92vw,380px);padding:28px 26px 22px;border:1px solid #383838;border-radius:16px;background:#2f2f2f;text-align:center}" +
    ".mark{width:34px;height:34px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center}" +
    ".ok .mark{background:rgba(134,217,168,.14);color:#86d9a8}" +
    ".fail .mark{background:rgba(238,112,98,.14);color:#ee7062}" +
    ".mark svg{width:18px;height:18px}" +
    "h1{margin:0 0 6px;font-size:16px;font-weight:500}" +
    "p{margin:0 0 20px;color:#8e8e8e;font-size:13px}" +
    ".actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}" +
    ".btn{appearance:none;border:0;border-radius:999px;padding:8px 16px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}" +
    ".primary{background:#fff;color:#171717}" +
    ".ghost{background:#3a3a3a;color:#b4b4b4}.ghost:hover{color:#ececec}" +
    ".brand{margin-top:18px;color:#5a5a5a;font-size:11px;letter-spacing:.08em}" +
    "</style></head><body><div class=\"card " + kind + "\">" +
    `<div class="mark">${callbackMarkSvg(kind)}</div>` +
    `<h1>${title}</h1><p>${lead}</p>` +
    `<div class="actions"><a class="btn primary" href="${consoleUrl}">返回控制台</a>` +
    "<button class=\"btn ghost\" type=\"button\" onclick=\"closePage()\">关闭本页</button></div>" +
    '<div class="brand">MODELMUX</div></div>' +
    "<script>function closePage(){try{window.close()}catch(e){}}" +
    "closePage();setTimeout(closePage,400);</script></body></html>"
  );
}

/** `startCallbackServer` 的默认落地页。 */
const DEFAULT_CALLBACK_HTML = callbackPageHtml("ok");

// ── B. flow 轮询 ──────────────────────────────────────────────────────────────

/** 轮询一步的结果。 */
export type PollStep<T> =
  | { kind: "pending" } // 授权中，继续轮询
  | { kind: "retry"; message?: string } // 瞬时问题（5xx / 网络），继续轮询
  | { kind: "done"; value: T } // 拿到结果
  | { kind: "fatal"; error: Error }; // 终态失败，立即抛出

export interface PollFlowOptions<T> {
  /** 每次轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 总等待上限（毫秒）。 */
  windowMs: number;
  /** 执行一次轮询。抛错视为 `retry`（除非回调自行返回 fatal）。 */
  attempt: () => Promise<PollStep<T>>;
  /** 可注入的 sleep（测试用）。 */
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (message: string) => void;
}

/**
 * 通用轮询循环：按 `intervalMs` 反复调用 `attempt`，直到 `done` / `fatal` / 超时。
 *
 * ⚠ 终态判据由 `attempt` 决定（各渠道不同：ZCode 把非 408/429 的 4xx 当 fatal，
 * WorkBuddy 把「200 但还没 token」当 pending），骨架只负责循环与超时。
 * `attempt` 抛出的异常按 `retry` 处理（网络抖动不该终止登录）。
 */
export async function pollFlow<T>(options: PollFlowOptions<T>): Promise<T> {
  const { intervalMs, windowMs, attempt, onStatus } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + windowMs;

  while (Date.now() < deadline) {
    let step: PollStep<T>;
    try {
      step = await attempt();
    } catch (err) {
      onStatus?.(`poll failed (${String(err)}), retrying...`);
      step = { kind: "retry" };
    }
    if (step.kind === "done") return step.value;
    if (step.kind === "fatal") throw step.error;
    if (step.kind === "retry" && step.message) onStatus?.(step.message);
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for authorization (${Math.round(windowMs / 60000)} min)`);
}

// ── C. 设备码 / 扫码轮询 ──────────────────────────────────────────────────────

/** 设备码轮询一步的结果。 */
export type DevicePollStep<T> =
  | { kind: "pending" }
  | { kind: "slow_down" } // 服务端要求放慢 → 永久抬高本轮的轮询间隔
  | { kind: "done"; value: T }
  | { kind: "fatal"; error: Error };

export interface PollDeviceOptions<T> {
  /** 初始轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 设备码有效期（秒），来自上游。 */
  expiresInSec: number;
  /** 连续网络失败上限（超过即放弃）。 */
  maxConsecutiveFailures?: number;
  attempt: () => Promise<DevicePollStep<T>>;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (message: string) => void;
  /** slow_down 每次抬高的毫秒数（缺省 1000）。 */
  slowDownStepMs?: number;
}

/**
 * 设备码 / 扫码轮询：在 `pollFlow` 基础上加两条设备码特有的规则。
 *
 * - `slow_down`：**累积**抬高间隔（每次都加，不重置）—— 这是 RFC 8628 的要求，
 *   重置成固定值会在服务端持续限流时陷入死循环。
 * - 连续网络失败计数：超过上限即抛错，避免上游不可用时持续空转到超时。
 */
export async function pollDeviceCode<T>(options: PollDeviceOptions<T>): Promise<T> {
  const { expiresInSec, maxConsecutiveFailures = 5, onStatus, slowDownStepMs = 1000 } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + Math.max(1, expiresInSec) * 1000;
  let intervalMs = options.intervalMs;
  let failures = 0;

  for (;;) {
    if (Date.now() >= deadline) throw new Error("device-code authorization timed out; run login again");

    let step: DevicePollStep<T>;
    try {
      step = await options.attempt();
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= maxConsecutiveFailures) {
        throw new Error(`device-code polling failed ${failures} consecutive times: ${String(err)}`);
      }
      await sleep(intervalMs);
      continue;
    }

    if (step.kind === "done") return step.value;
    if (step.kind === "fatal") throw step.error;
    if (step.kind === "slow_down") {
      intervalMs += slowDownStepMs; // 必须真的累积
      onStatus?.(`server asked to slow down; poll interval now ${intervalMs / 1000}s`);
    }
    await sleep(intervalMs);
  }
}
