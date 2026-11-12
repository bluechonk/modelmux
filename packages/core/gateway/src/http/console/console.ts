/**
 * 控制台 API 服务：`/api/*` 提供只读状态快照与写动作；`/` 与 `/assets/*` 静态托管 UI。
 *
 * 与网关分开：网关的 `/` 返回 JSON 是既有契约不能混入别的端点；控制台必须在
 * **登录完成前**就可用，而此时网关还没启动。
 *
 * 端点：`GET /`（SPA 首页）· `GET /assets/*` · `GET /web/api/state` · `GET /api/logs` ·
 * `GET /api/logs/payload` · `GET /api/usage` · `POST /api/theme` ·
 * `POST /api/retry-login` · `POST /api/commands`（web-command-handler.ts）
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, extname, join, resolve, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { serviceName } from "../server.js";
import type { LoginInputRequest } from "../../runtime/channel.js";
import {
  MODEL_REQUEST_PATHS,
  appendGateway,
  queryAccessLogs,
  type AccessOutcome,
} from "../../runtime/log-store.js";
import { computeUsageStats, type UsageRange } from "../../runtime/usage-stats.js";
import { refreshCatalog } from "../../pool/catalog-snapshot.js";

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

/**
 * 状态快照。
 *
 * `ui_state` 只表示**网关状态**（probing / login / running），不承载登录结果；
 * 上一轮登录的结果在 `login_result`（idle / done / error），是一次性事件。
 * 早先 `error` / `done` 直接写进 `ui_state`，一次登录失败就让右上角永久显示
 * 「登录失败」，直到下次登录成功才被覆盖。
 */
export interface UiSnapshot {
  ui_state: string;
  /** 上一轮登录的结果：`idle`（无结果）/ `done` / `error`。 */
  login_result: "idle" | "done" | "error";
  message: string;
  /** 授权页 URL。**不要在这里扫码**（每次加载都是新的二维码会话）。 */
  auth_url: string;
  /**
   * 二维码图片 URL（`<img src>` 直接内嵌）。
   *
   * 扫码**必须**用这张：它对应登录流程本轮长轮询的 uuid。用 `auth_url`
   * 那个页面上显示的二维码属于另一次会话，轮询永远等不到「已确认」。
   */
  qr_url: string;
  base_url: string;
  chat_url: string;
  endpoints: string[];
  /** 网关自身版本（仓库 `VERSION` 常量），给控制台顶栏显示当前版本。 */
  version: string;
  /** 版本更新提示（后台每天检测一次；无提示为 null）。 */
  update: import("../../runtime/update-check.js").UpdateNotice | null;
  /**
   * 对外模型池的**「模型 × 渠道」矩阵**：一个模型可能由多个渠道供给。
   *
   * 模型 id 是 deepseek 裸名（不再有 `<cid>/` 前缀）；渠道凭 `cid` 列展示，
   * 元数据取**该渠道**的值（同一模型在不同渠道倍率/规格可能不同）。
   */
  models: Array<{
    model: string;
    cid: string;
    meta: import("../../pool/pool-targets.js").PoolModelMeta;
  }>;
  /**
   * 模型级渠道偏好：每个对外模型「优先走哪家」。
   *
   * `channels` 是该模型的全部候选渠道（下拉的选项来源），`preferred` 为当前偏好
   * （`null` = 自动选路）。偏好的渠道在候选里**置顶**，其余仍按剩余额度排在后面 ——
   * 被偏好的渠道冷却 / 额度耗尽时自然顺延，不需要额外开关。
   */
  model_prefs: Array<{
    model: string;
    channels: string[];
    preferred: string | null;
  }>;
  /**
   * 待回答的输入请求（渠道两步登录，如 loomy 的短信验证码）；`null` = 当前没有。
   *
   * 界面拿到它就把登录弹窗切成**输入卡**（提示 + 输入框 + 提交/取消），
   * 提交走 `submitInput` 动作；界面关闭时也要调它，否则等待中的渠道会一直挂着。
   */
  login_input: LoginInputRequest | null;
  /**
   * 各渠道的能力位（键 = cid）。
   *
   * 为什么要下发：前端要区分「该渠道没有倍率概念（订阅制）」。靠**能力位**而不是
   * 前端硬编码渠道名 —— 否则每接一个订阅制渠道，前端就得跟着改一次。
   */
  channel_caps: Record<string, ChannelCaps>;
  /**
   * 各接入目标（zcode / dsh / claude-desktop / codex）当前的接入态（键 = target）。
   *
   * 开关式 UI 的状态源：true = 已接入（客户端配置已指向网关），false = 未接入。
   * 由接入备份清单 + 标记文件推导（见 `app/integrate.ts` 的 `integrationStatus`）。
   */
  integrations: Record<string, boolean>;
  /**
   * 各接入目标的「模型有更新」（键 = target；null = 无更新）。
   *
   * 服务端算好差集再下发：前端没有「接入那一刻写入了哪些模型」这个基准，
   * 自己 diff 不出来（见 `app/integrate.ts` 的 `integrationUpdates`）。
   * 类型就地同构声明 —— http 层不许向上依赖 app 层。
   */
  integration_updates: Record<string, { added: string[]; removed: string[]; at: string } | null>;
  /**
   * 用户选的主题模式：`system`（跟随系统）/ `dark` / `light`。
   *
   * `system` 的解析（prefers-color-scheme）在**前端**做 —— 服务端不知道显示器设置。
   * 持久化在 `~/.modelmux/setting.json`（写走 POST /api/theme）。
   */
  theme_mode: string;
  gateway_error: string;
}

export function emptySnapshot(): UiSnapshot {
  return {
    ui_state: "probing",
    login_result: "idle",
    message: "",
    auth_url: "",
    qr_url: "",
    base_url: "",
    chat_url: "",
    endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens", "/v1/responses", "/v1/models", "/health"],
    version: "",
    update: null,
    models: [],
    model_prefs: [],
    login_input: null,
    channel_caps: {},
    integrations: {},
    integration_updates: {},
    theme_mode: "system",
    gateway_error: "",
  };
}

/**
 * HTTP 层 <-> 运行层之间的桥。
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
   * 一键接入：把本机 harness 的模型配置改写成网关的对外模型名。
   *
   * 同 `triggerLogin`：写的是**客户端**配置（`~/.zcode` / `~/.dsh`），
   * 实现放 app 层（`app/integrate.ts`），控制台只转交用户点的那一下。
   */
  integrate?: (target: "zcode" | "dsh" | "claude-desktop" | "codex") => {
    ok: boolean;
    error?: string;
    /** 变更说明（人读，控制台作展示）。 */
    notes?: string[];
    /** 需要用户处置的警告（备份清单读不出 / 备份未登记 等）；不透出会被当噪音忽略。 */
    warnings?: string[];
  };
  /**
   * 一键还原：把目标恢复成接入前状态（取该目标最新一次备份）。
   * 实现同为 `app/integrate.ts` 的 `restoreClient`。
   */
  restore?: (target: "zcode" | "dsh" | "claude-desktop" | "codex") => {
    ok: boolean;
    error?: string;
    restored: string[];
    removed: string[];
    /** 跳过条目 / 备份缺失等需要让用户知道的说明（不透出会伪装成「已还原」）。 */
    notes: string[];
  };
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

/** ping 的等待上限（毫秒）：比客户端常见的 60s 超时早一步收手，好把「超时」当结果返回。 */
const PING_TIMEOUT_MS = 45_000;

/** 回环地址名单：ping 只能打回本机，Host 头是客户端给的，不校验就是 SSRF 跳板。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 总览里已留痕过「账号读取失败」的渠道（进程生命周期内一次）：防止 5s 轮询刷屏。 */
const overviewAccountFailures = new Set<string>();

/**
 * ping 一个模型：向**本进程**发一次最小 chat 请求并计时。
 *
 * 为什么走 HTTP 自请求、不做内部直调：只有走完整链路才算 ping —— 候选选择、自动换号、
 * 排队重试、响应归一化、护栏都在链路上，绕过它们测出的「成功」不代表客户端会成功。
 *
 * 请求形态取最小：单条 user 消息 + `max_tokens: 1` + 非流式 —— 计费最小；非流式还能拿到
 * 确定的状态码（流式要读完流才知道成败）。`ms` 量到**响应体读完**为止，不是只到响应头。
 */
async function pingModel(
  req: import("node:http").IncomingMessage,
  model: string,
): Promise<{ ok: boolean; model: string; ms: number; status: number; error: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    // Host 头是客户端给的，畸形值会让 new URL 抛 TypeError —— 放 try 里按失败处理
    const target = new URL(`http://${req.headers.host ?? ""}/v1/chat/completions`);
    if (!LOOPBACK_HOSTS.has(target.hostname)) {
      return { ok: false, model, ms: 0, status: 0, error: "ping 只能发往本机回环地址" };
    }
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const status = upstream.status;
    const text = await upstream.text().catch(() => "");
    const ms = Date.now() - started;
    // 响应头已到、体读完之前被 abort：实际是超时，不能按头状态报成败
    if (controller.signal.aborted) {
      return { ok: false, model, ms, status: 0, error: `超时（> ${Math.round(PING_TIMEOUT_MS / 1000)}s）` };
    }
    if (!upstream.ok) {
      // 错误体是网关自己的 JSON（`{error:{message}}`），截断后原样回给界面，别自己编原因
      return { ok: false, model, ms, status, error: text.slice(0, 300) || `HTTP ${status}` };
    }
    return { ok: true, model, ms, status, error: "" };
  } catch (err) {
    const ms = Date.now() - started;
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      model,
      ms,
      status: 0,
      error: aborted ? `超时（> ${Math.round(PING_TIMEOUT_MS / 1000)}s）` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 读一次 JSON 请求体（供 /api/providers 的 POST 用；超限按截断处理）。 */
function readBody(req: import("node:http").IncomingMessage, onBody: (body: Record<string, unknown>) => void): void {
  let body = "";
  req.on("data", (chunk) => {
    body += String(chunk);
  });
  req.on("end", () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      appendGateway("console body parse failed");
    }
    onBody(parsed);
  });
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
    // `new URL()` 对畸形 request-target 抛 `ERR_INVALID_URL`（与 http/server.ts 同因）：
    // 这里是同步 handler，异常会直接冒到 server 的 request 事件并杀进程，所以自己兜住。
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid request target" }));
      }
      return;
    }
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

    // SPA 回退：React Router 在客户端负责路由（无扩展名的路由路径都回 index.html）。
    // 两条约束，各自都踩过坑：
    //   1. 必须传**相对路径** —— serveStatic 会先剥前导斜杠再 `resolve(WEB_UI_ROOT, …)`，
    //      传绝对路径会拼成 `<UI 根>/home/.../index.html`，深链刷新/分享曾因此全挂；
    //   2. **带扩展名的路径不回退** —— 否则部署缺失的 js/css 会拿到 200 + HTML，
    //      浏览器当脚本解析报语法错，比 404 更难定位（未匹配的会落到末尾的 404 兜底）。
    if (
      !path.startsWith(p("/api/")) &&
      extname(path) === "" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      serveStatic(res, "index.html");
      return;
    }

    // —— API ——
    if (path === p("/api/state")) {
      let snapshot: UiSnapshot;
      try {
        snapshot = bridge.provider?.() ?? emptySnapshot();
      } catch (err) {
        // provider 抛错不能伪装成「正常初始状态」：控制台会把桥接 bug 显示成空白快照、
        // 无任何日志可查。留痕 + 标 unknown，前端按异常态渲染而非静默空数据。
        appendGateway(`console state provider failed: ${String(err)}`);
        snapshot = { ...emptySnapshot(), ui_state: "unknown" };
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
      // 只有 success / failure 两个桶（历史上的 `other` 已并入 failure，见 log-store）
      const outcome: AccessOutcome | undefined =
        outcomeRaw === "success" || outcomeRaw === "failure" ? outcomeRaw : undefined;
      const streamRaw = q.get("stream");
      const page = queryAccessLogs({
        // 日志页只展示**模型请求**（三种入站协议）：`/health` 等非模型请求也在
        // access 日志里，但主人要的是「请求日志」，混进来只会稀释列表。
        paths: MODEL_REQUEST_PATHS,
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

    if (path === p("/api/usage")) {
      if (req.method !== "GET") {
        json(res, { ok: false, error: "use GET" }, 405);
        return;
      }
      // 与 `/api/logs` 同策略：用量含模型名与渠道，加同源校验（无 Origin 头时放行）
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const raw = q.get("range");
      // `365d` 供热力图用（52 周一年）；`all` = 累计（保留期内全量）；其余为区间天数
      const range: UsageRange =
        raw === "today" || raw === "7d" || raw === "30d" || raw === "90d" || raw === "365d" || raw === "all"
          ? raw
          : "30d";
      json(res, { ok: true, ...computeUsageStats(range) });
      return;
    }

    if (path === p("/api/ping")) {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      // 会真的花掉一次上游请求（1 个输出 token），按写操作对待：必须同源。
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
          let parsed: { model?: unknown };
          try {
            parsed = JSON.parse(body || "{}") as { model?: unknown };
          } catch {
            json(res, { ok: false, error: "invalid json" }, 400);
            return;
          }
          const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
          if (!model) {
            json(res, { ok: false, error: "参数 model 必填" }, 400);
            return;
          }
          const result = await pingModel(req, model);
          json(res, result, 200);
        })().catch((err) => {
          // 与 `/api/commands` 同待遇：意外 rejection 不能变成 unhandledRejection
          appendGateway(`console /api/ping failed: ${String(err)}`);
          if (!res.headersSent) json(res, { ok: false, error: `ping failed: ${String(err)}` }, 500);
        });
      });
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
          // 桥里的每个写动作都要在这里显式转发 —— 漏一个，命令处理器就报
          // 「未注入 xxx」（实测踩过：`submitInput` 漏转发，控制台点
          // 「发送验证码」后端直接回「不支持登录输入」）。
          const handle = createWebCommandHandler({
            ...(bridge.triggerLogin ? { triggerLogin: bridge.triggerLogin } : {}),
            ...(bridge.submitCallback ? { submitCallback: bridge.submitCallback } : {}),
            ...(bridge.submitInput ? { submitInput: bridge.submitInput } : {}),
            ...(bridge.cancelInput ? { cancelInput: bridge.cancelInput } : {}),
            ...(bridge.integrate ? { integrate: bridge.integrate } : {}),
            ...(bridge.restore ? { restore: bridge.restore } : {}),
          });
          const result = await handle({
            action,
            ...(typeof cid === "string" ? { cid } : {}),
            args: typeof args === "object" && args !== null ? args as Record<string, unknown> : {},
          });
          json(res, result, result.ok ? 200 : 400);
        })().catch((err) => {
          // 动态 import / 处理器组装的意外 rejection 不能放任成 unhandledRejection
          //（Node 默认杀 worker = 网关瞬断、在途流全断）
          appendGateway(`console /api/commands failed: ${String(err)}`);
          if (!res.headersSent) json(res, { ok: false, error: `command failed: ${String(err)}` }, 500);
        });
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
        const [{ poolModels, poolModelMetas, poolCandidates }, { listAccounts }, { channels }, { runInChannel }] =
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
        } catch (err) {
          // 与 `/api/state` 同口径：桥接层抛错必须留痕并如实标 unknown，
          // 不能伪装成「正常初始状态」（总览页会显示成一切正常）。
          appendGateway(`console overview state provider failed: ${String(err)}`);
          gateway = { ui_state: "unknown", gateway_error: String(err) };
        }

        // 只算**模型请求**（三种入站协议）：控制台里「请求」恒指模型调用，
        // 与请求日志页、用量区块同一口径（`/health` 等混进来会让成功率与 tokens 失真）。
        const logPage = queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 100 });
        const usage = {
          date: logPage.date,
          requests: logPage.stats.requests,
          success: logPage.stats.success,
          failure: logPage.stats.failure,
          slow: logPage.stats.slow,
          avg_duration_ms: logPage.stats.avgDurationMs,
          tokens: logPage.stats.tokens,
          cache: logPage.stats.cache,
          // 扫描窗口元数据：极端量级下统计只代表窗口内，前端与排障都要能看出来
          truncated: logPage.truncated,
          scanned: logPage.scanned,
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

        // 每个渠道供给几个对外模型（控制台的渠道卡用）
        const cidModelCounts = new Map<string, number>();
        for (const model of poolModels()) {
          for (const candidate of poolCandidates(model)) {
            cidModelCounts.set(candidate.cid, (cidModelCounts.get(candidate.cid) ?? 0) + 1);
          }
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
            } catch (err) {
              // 渠道未加载或无账号：单渠道失败不拖垮总览。UI 侧无从区分「读不到」
              // 与「真的是零」（状态同样全零），按 cid 首次失败留痕一次 —— 总览每
              // 5 秒被轮询，逐次记录会把 gateway.log 刷成单一错误的流水账
              if (!overviewAccountFailures.has(cid)) {
                overviewAccountFailures.add(cid);
                appendGateway(`console overview: channel ${cid} accounts failed: ${String(err)}`);
              }
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
          // `stream` 与 `generate_ms` 是 TPS 口径的输入：前者决定基准怎么取，
          // 后者是纯生成窗口（缺省 = 测不到，前端显示 `—`）
          stream: entry.stream,
          generate_ms: entry.generateMs,
          duration_ms: entry.durationMs,
          ttfb_ms: entry.ttfbMs,
          upstream_ms: entry.upstreamMs,
          tokens: entry.tokens,
          // 失败 / 中断的原因：控制台「最近请求」的非成功行直接显示（排障第一入口）
          error: entry.error,
          message: entry.message,
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
      })().catch((err) => {
        // 同 /api/commands：IIFE rejection 不能变成 unhandledRejection（会杀 worker）
        appendGateway(`console /api/overview failed: ${String(err)}`);
        if (!res.headersSent) json(res, { ok: false, error: `overview failed: ${String(err)}` }, 500);
      });
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
