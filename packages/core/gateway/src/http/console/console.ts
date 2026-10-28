/**
 * 控制台 API 服务：`/api/*` 提供只读状态快照与写动作；`/` 与 `/assets/*` 静态托管 UI。
 *
 * 与网关分开：网关的 `/` 返回 JSON 是既有契约不能混入别的端点；控制台必须在
 * **登录完成前**就可用，而此时网关还没启动。
 *
 * 端点：`GET /`（SPA 首页）· `GET /assets/*` · `GET /web/api/state` · `GET /api/logs` ·
 * `GET /api/logs/payload` · `POST /api/theme` ·
 * `POST /api/retry-login` · `POST /api/commands`（web-command-handler.ts）
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, extname, join, resolve, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { serviceName } from "../server.js";
import type { LoginInputRequest } from "../../runtime/channel.js";
import { queryAccessLogs, readPayloads, type AccessOutcome } from "../../runtime/log-store.js";

export type { LoginInputRequest };

export const DEFAULT_UI_HOST = "127.0.0.1";

const THEME_MODES = new Set(["system", "dark", "light"]);

/**
 * UI 静态产物根：按**候选顺序**探测，取第一个含 index.html 的目录。
 *
 * 两种运行形态的 `import.meta.url` 落点不同：
 * - 编译后独立运行：`core/gateway/dist/http/console/console.js` → 上溯两级取 `dist/ui`
 * - bundle 后（`npm i -g` 的 mx）：整包内联进 `cli/dist/cli.bundle.js` → 平级取 `cli/dist/ui`
 *
 * 环境变量 `MODELMUX_WEB_UI_ROOT` 可显式覆盖（排查 / 自定义部署用）。
 */
function resolveWebUiRoot(): string {
  const override = process.env["MODELMUX_WEB_UI_ROOT"];
  if (override) return resolve(override);
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "ui"), // bundle：cli/dist/cli.bundle.js → cli/dist/ui
    resolve(here, "..", "..", "..", "core", "gateway", "dist", "ui"), // cli/dist/cli.bundle.js → core/gateway/dist/ui
    resolve(here, "..", "..", "ui"), // 兜底：独立运行 → core/gateway/dist/ui
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  // 都不存在时返回首选，让 404 提示带上一个可诊断的路径
  return candidates[0]!;
}

const WEB_UI_ROOT = resolveWebUiRoot();
const WEB_UI_INDEX = join(WEB_UI_ROOT, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** 渠道能力位（键 = cid）。 */
export interface ChannelCaps {
  /**
   * 该渠道有没有额度/倍率概念。
   *
   * `false` = 订阅制（上游不按积分/倍率计费）—— 前端据此把该渠道的模型按「免费」显示，
   * 而**不是**硬编码渠道名（每接一个订阅制渠道，前端不该跟着改一次）。
   */
  billing: boolean;
}

/** 状态快照；`ui_state` 取值 probing / login / error / running。 */
export interface UiSnapshot {
  ui_state: string;
  message: string;
  /** 授权页 URL。⚠ **不要在这里扫码**（每次加载都是新的二维码会话）。 */
  auth_url: string;
  /**
   * 二维码图片 URL（`<img src>` 直接内嵌）。
   *
   * ⚠ 扫码**必须**用这张：它对应登录流程本轮长轮询的 uuid。用 `auth_url`
   * 那个页面上显示的二维码属于另一次会话，轮询永远等不到「已确认」。
   */
  qr_url: string;
  base_url: string;
  chat_url: string;
  endpoints: string[];
  models: string[];
  /**
   * 待回答的输入请求（渠道两步登录，如 loomy 的短信验证码）；`null` = 当前没有。
   *
   * 界面拿到它就把登录弹窗切成**输入卡**（提示 + 输入框 + 提交/取消），
   * 提交走 `submitInput` 动作；界面关闭时也要调它，否则等待中的渠道会一直挂着。
   */
  login_input: LoginInputRequest | null;
  /**
   * 每模型附加信息（键 = 池模型 id）：消耗倍率与营销角标。
   *
   * 倍率为 null 表示该渠道目录没有提供；前端据此不渲染倍率标签。
   */
  model_info: Record<string, import("../../pool/pool-targets.js").PoolModelMeta>;
  /**
   * 各渠道的能力位（键 = cid）。
   *
   * 为什么要下发：前端要区分「该渠道没有倍率概念（订阅制）」。靠**能力位**而不是
   * 前端硬编码渠道名 —— 否则每接一个订阅制渠道，前端就得跟着改一次。
   */
  channel_caps: Record<string, ChannelCaps>;
  theme_mode: string;
  resolved_theme: string;
  gateway_error: string;
}

export function emptySnapshot(): UiSnapshot {
  return {
    ui_state: "probing",
    message: "",
    auth_url: "",
    qr_url: "",
    base_url: "",
    chat_url: "",
    endpoints: ["/v1/chat/completions", "/v1/models", "/health"],
    models: [],
    login_input: null,
    model_info: {},
    channel_caps: {},
    theme_mode: "system",
    resolved_theme: "dark",
    gateway_error: "",
  };
}

/**
 * HTTP 层 ↔ 运行层之间的桥。
 */
export interface ControlBridge {
  provider?: () => UiSnapshot;
  setTheme?: (mode: string) => void;
  retryLogin?: () => void;
  /**
   * 触发某渠道的交互式登录（浏览器授权）。
   *
   * 由上层（headless / 单渠道 CLI）注入实现 —— 控制台层不认识登录流程本身，
   * 避免 http → app 的层级违例（见 `scripts/verify-layering.mjs`）。
   */
  triggerLogin?: (cid: string, force: boolean) => void;
  /**
   * 提交用户粘回的回调链接（一次性 code 的兜底通道）。
   *
   * 回调页线上是 404（微信只校验域名、官方客户端在内嵌窗口拦跳转），
   * 故没有浏览器的进程只能靠用户把地址栏那条链接粘回来。
   */
  submitCallback?: (raw: string) => void;
  /**
   * 提交用户在登录弹窗里输入的内容（渠道两步登录用，如 loomy 的短信验证码）。
   *
   * 与 `submitCallback` 同构：界面不认识登录流程，只把用户给的字符串转交上去。
   */
  submitInput?: (value: string) => void;
  /**
   * 用户关掉了登录弹窗（两步登录不再等输入）。
   *
   * 不取消的话，等待输入的渠道会一直挂到超时（10 分钟）—— 期间那次登录请求
   * 既不算成功也不算失败，界面上也没法再回答它。
   */
  cancelInput?: () => void;
  /**
   * 控制台触发的网关生命周期操作（web 页面的播放/暂停/重启按钮）。
   *
   * `restart`：worker 主动自断，由监督者按退避**重生**（页面短暂失联后自愈）；
   * `stop`：worker 经 IPC 让监督者**永久退出**并自断 —— 页面随之不可达，
   * 恢复必须在本机终端 `mx start`（Web 控制台本身就是网关进程的一部分）。
   */
  gatewayControl?: (action: "restart" | "stop") => void;
}

export interface ConsoleServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function text(res: import("node:http").ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${body}\n`);
}

/** 查询参数里的整数：缺失或非数字时回落默认值（分页参数由界面给，不值得为坏值报错）。 */
function intParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** 静态文件服务（含路径穿越校验）。 */
function serveStatic(res: import("node:http").ServerResponse, relPath: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    // 畸形百分号编码（如 `%E0%A4%A`）会让 decodeURIComponent 抛 URIError；
    // 不接住就是 uncaughtException，控制台进程会随网关进程一起退出。
    text(res, 400, "Bad request");
    return;
  }
  const relative = decoded.replace(/^[\\\/]+/, "");
  if (relative.split("/").some((segment) => segment === "..")) {
    text(res, 403, "Forbidden");
    return;
  }
  const file = isAbsolute(relative)
    ? relative
    : resolve(WEB_UI_ROOT, relative);
  if (!file.startsWith(`${WEB_UI_ROOT}${sep}`) && file !== WEB_UI_ROOT) {
    text(res, 403, "Forbidden");
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    text(res, 404, "Not found");
    return;
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  // 内容哈希命名的资产可长缓存；其余（index.html 等）保持不缓存
  const cache = relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  res.end(readFileSync(file));
}

/** 写操作同源校验（比对 host:port，避免只比 hostname 时跨端口请求被放行）。 */
function isSameOrigin(req: import("node:http").IncomingMessage, host: string): boolean {
  const origin = req.headers["origin"];
  // 同源 POST 也会带 Origin（浏览器规范），缺失时才按「非浏览器客户端」放行
  if (typeof origin !== "string" || !origin) return true;
  try {
    const parsed = new URL(origin);
    const reqHost = req.headers["host"] ?? "";
    // 严格比较 host:port —— 只比 hostname 会让 127.0.0.1:其他端口 / https 变体穿透
    return parsed.host === reqHost || (parsed.hostname === host && parsed.port === new URL(`http://${reqHost}`).port);
  } catch {
    return false;
  }
}

/**
 * 把 console 路由体抽成**可挂载的 handler**，供两种形态复用：
 * - 独立进程（`mx web` / 单渠道调试）：`prefix = ""`，自带 server
 * - 挂载进网关（单端口模式）：`prefix = "/web"`，由 gateway 的 handler 转发
 *
 * 所有路由判断都带 `prefix`，因此同一份实现能同时服务根路径与子路径。
 */
export function createConsoleHandler(
  bridge: ControlBridge,
  prefix = "",
  host = DEFAULT_UI_HOST,
): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const p = (suffix: string): string => `${prefix}${suffix}`;

    // —— 静态（GET） ——
    if (path === p("/") && (req.method === "GET" || req.method === "HEAD")) {
      if (existsSync(WEB_UI_INDEX)) serveStatic(res, "index.html");
      else
        text(
          res,
          404,
          `UI 未构建。请运行 npm run build 后再试 mx web。（查找路径：${WEB_UI_ROOT}）`,
        );
      return;
    }
    const assetsPrefix = p("/assets/");
    if ((req.method === "GET" || req.method === "HEAD") && path.startsWith(assetsPrefix)) {
      // 只去掉前缀与开头的 `/`，**保留 `assets/` 目录段** ——
      // 用 slice(assetsPrefix.length) 会把目录段一起剥掉，导致查 ui/index-*.js（不存在）而 404。
      serveStatic(res, path.slice(prefix.length + 1));
      return;
    }

    // SPA 回退：React Router 在客户端负责路由（非 API 路径都回 index.html）
    if (!path.startsWith(p("/api/")) && (req.method === "GET" || req.method === "HEAD")) {
      serveStatic(res, WEB_UI_INDEX);
      return;
    }

    // —— API ——
    if (path === p("/api/state")) {
      let snapshot: UiSnapshot;
      try {
        snapshot = bridge.provider?.() ?? emptySnapshot();
      } catch {
        snapshot = emptySnapshot();
      }
      json(res, snapshot);
      return;
    }

    if (path === p("/api/logs")) {
      if (req.method !== "GET") {
        json(res, { ok: false, error: "use GET" }, 405);
        return;
      }
      // 与 `/api/state` 不同，这里**加同源校验**：日志含模型名与请求路径，
      // 比状态快照更不该被跨源页面读到（无 Origin 头时放行，curl / 脚本不受影响）。
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const outcomeRaw = q.get("outcome");
      const outcome: AccessOutcome | undefined =
        outcomeRaw === "success" || outcomeRaw === "failure" || outcomeRaw === "other"
          ? outcomeRaw
          : undefined;
      const streamRaw = q.get("stream");
      const page = queryAccessLogs({
        date: q.get("date") ?? undefined,
        outcome,
        cid: q.get("cid") ?? undefined,
        model: q.get("model") ?? undefined,
        stream: streamRaw === "true" ? true : streamRaw === "false" ? false : undefined,
        slow: q.get("slow") === "1" ? true : undefined,
        q: q.get("q") ?? undefined,
        limit: intParam(q.get("limit"), 100),
        offset: intParam(q.get("offset"), 0),
      });
      json(res, { ok: true, ...page });
      return;
    }

    if (path === p("/api/logs/payload")) {
      if (req.method !== "GET") {
        json(res, { ok: false, error: "use GET" }, 405);
        return;
      }
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const id = q.get("id") ?? "";
      const date = q.get("date") ?? undefined;
      const records = readPayloads(id, date);
      json(res, { ok: true, id, date: date ?? null, records });
      return;
    }

    if (path === p("/api/theme")) {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        let mode: unknown;
        try {
          mode = (JSON.parse(body || "{}") as Record<string, unknown>)["mode"];
        } catch {
          json(res, { ok: false, error: "invalid json" }, 400);
          return;
        }
        if (typeof mode !== "string" || !THEME_MODES.has(mode)) {
          json(res, { ok: false, error: "invalid mode" }, 400);
          return;
        }
        if (!bridge.setTheme) {
          json(res, { ok: false, error: "not ready" }, 503);
          return;
        }
        bridge.setTheme(mode);
        json(res, { ok: true });
      });
      return;
    }

    if (path === p("/api/retry-login")) {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      if (!bridge.retryLogin) {
        json(res, { ok: false, error: "not ready" }, 503);
        return;
      }
      bridge.retryLogin();
      json(res, { ok: true });
      return;
    }

    if (path === p("/api/commands")) {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      // 写操作需要同源。静态资产从 UI 发来的请求都同源（浏览器会带 Origin），
      // 这里只拦跨源；fetch 同源不会带 Origin，所以直接靠有 Origin 且不匹配拒绝。
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        void (async () => {
          let parsed: { action?: unknown; cid?: unknown; args?: unknown };
          try {
            parsed = JSON.parse(body || "{}") as { action?: unknown; cid?: unknown; args?: unknown };
          } catch {
            json(res, { ok: false, error: "invalid json" }, 400);
            return;
          }
          const { action, cid, args } = parsed;
          if (typeof action !== "string" || !action) {
            json(res, { ok: false, error: "参数 action 必填" }, 400);
            return;
          }
          const { createWebCommandHandler } = await import("./web-command-handler.js");
          // ⚠ 桥里的每个写动作都要在这里显式转发 —— 漏一个，命令处理器就报
          // 「未注入 xxx」（实测踩过：`submitInput` 漏转发，控制台点
          // 「发送验证码」后端直接回「不支持登录输入」）。
          const handle = createWebCommandHandler({
            ...(bridge.triggerLogin ? { triggerLogin: bridge.triggerLogin } : {}),
            ...(bridge.submitCallback ? { submitCallback: bridge.submitCallback } : {}),
            ...(bridge.submitInput ? { submitInput: bridge.submitInput } : {}),
            ...(bridge.cancelInput ? { cancelInput: bridge.cancelInput } : {}),
          });
          const result = await handle({
            action,
            ...(typeof cid === "string" ? { cid } : {}),
            args: typeof args === "object" && args !== null ? args as Record<string, unknown> : {},
          });
          json(res, result, result.ok ? 200 : 400);
        })();
      });
      return;
    }

    if (path === p("/api/gateway")) {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        let action: unknown;
        try {
          action = (JSON.parse(body || "{}") as Record<string, unknown>)["action"];
        } catch {
          json(res, { ok: false, error: "invalid json" }, 400);
          return;
        }
        if (action !== "restart" && action !== "stop") {
          json(res, { ok: false, error: "action 必须是 restart 或 stop" }, 400);
          return;
        }
        if (!bridge.gatewayControl) {
          json(res, { ok: false, error: "not ready" }, 503);
          return;
        }
        // 先回响应再动手：restart 会让本进程自断，晚回的响应到不了浏览器
        json(res, { ok: true, action });
        bridge.gatewayControl(action);
      });
      return;
    }

    if (path === p("/api/overview")) {
      if (req.method !== "GET") {
        json(res, { ok: false, error: "use GET" }, 405);
        return;
      }
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      void (async () => {
        const [{ poolModels, poolModelMetas }, { listAccounts }, { channels }, { runInChannel }] =
          await Promise.all([
            import("../../pool/pool-targets.js"),
            import("../../runtime/account-pool.js"),
            import("../../runtime/channel.js"),
            import("../../runtime/channel-context.js"),
          ]);

        let gateway: { ui_state: string; gateway_error: string };
        try {
          const snap = bridge.provider?.() ?? emptySnapshot();
          gateway = { ui_state: snap.ui_state, gateway_error: snap.gateway_error };
        } catch {
          gateway = { ui_state: "unknown", gateway_error: "" };
        }

        const logPage = queryAccessLogs({ limit: 100 });
        const usage = {
          date: logPage.date,
          requests: logPage.stats.requests,
          success: logPage.stats.success,
          failure: logPage.stats.failure,
          other: logPage.stats.other,
          slow: logPage.stats.slow,
          avg_duration_ms: logPage.stats.avgDurationMs,
          tokens: logPage.stats.tokens,
        };

        const perChannelLogs = new Map<string, { success: number; failure: number }>();
        for (const entry of logPage.entries) {
          if (!entry.cid) continue;
          const cur = perChannelLogs.get(entry.cid) ?? { success: 0, failure: 0 };
          if (entry.outcome === "success") cur.success++;
          else if (entry.outcome === "failure") cur.failure++;
          perChannelLogs.set(entry.cid, cur);
        }

        const channelMetas = poolModelMetas();
        let total = 0;
        let free = 0;
        let vision = 0;
        let thinking = 0;
        for (const [, meta] of channelMetas) {
          total++;
          if (meta.multiplier === 0) free++;
          if (meta.inputModalities.some((m) => m !== "text")) vision++;
          if (meta.effort !== null && meta.effort !== undefined) thinking++;
        }

        const allModels = poolModels();
        const cidModelCounts = new Map<string, number>();
        for (const model of allModels) {
          const cid = model.slice(0, model.indexOf("/"));
          cidModelCounts.set(cid, (cidModelCounts.get(cid) ?? 0) + 1);
        }

        const channelList = await Promise.all(
          channels().map(async (channel) => {
            const cid = channel.config.cid;
            const logCounts = perChannelLogs.get(cid) ?? { success: 0, failure: 0 };
            const statuses = { ok: 0, cooldown: 0, error: 0, unauthenticated: 0 };
            try {
              const index = runInChannel(cid, () => listAccounts(cid));
              for (const acc of index.accounts) {
                if (acc.health === "ok") statuses.ok++;
                else if (acc.health === "cooldown") statuses.cooldown++;
                else if (acc.health === "error") statuses.error++;
                else if (acc.health === "unauthorized") statuses.unauthenticated++;
              }
            } catch {
              // 渠道未加载或无账号
            }
            return {
              cid,
              models: cidModelCounts.get(cid) ?? 0,
              statuses,
              requests: logCounts,
            };
          }),
        );

        const recent = logPage.entries.slice(0, 5).map((entry) => ({
          id: entry.id,
          ts: entry.ts,
          cid: entry.cid,
          model: entry.model,
          outcome: entry.outcome,
          status: entry.status,
          duration_ms: entry.durationMs,
          tokens: entry.tokens,
        }));

        json(res, {
          ok: true,
          date: logPage.date,
          gateway,
          usage,
          channels: channelList,
          model_pool: { total, free, vision, thinking },
          recent,
        });
      })();
      return;
    }

    json(res, { ok: false, error: `unknown path ${path}` }, 404);
  };
}

/** 启动控制台 API 服务。端口被占用时回退到系统分配的空闲端口。 */
export async function start(
  port: number,
  bridge: ControlBridge,
  host = DEFAULT_UI_HOST,
  cid?: string,
): Promise<ConsoleServer> {
  void cid; // 保留签名兼容（旧的 hostname 区分逻辑，独立 web 模式无渠道概念）
  const handler = createConsoleHandler(bridge, "", host);
  const server = createServer((req, res) => handler(req, res));

  const bound = await new Promise<number>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
        reject(err);
        return;
      }
      // 端口不可用 → 改用系统分配端口（保留端口恢复时的兼容行为）
      server.listen(0, host, () => {
        const address = server.address() as { port: number } | null;
        resolve(address?.port ?? 0);
      });
    });
    server.listen(port, host, () => {
      const address = server.address() as { port: number } | null;
      resolve(address?.port ?? port);
    });
  });

  const url = `http://${host}:${bound}/`;
  console.error(`[${serviceName(cid)}] console API: ${url}`);

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
