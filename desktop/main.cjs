/**
 * modelmux 桌面壳（Electron 主进程）。
 *
 * 职责：起一个内嵌的 modelmux 网关子进程，等它健康后把窗口指向 `/web`。
 *
 * 关键约束：
 *   - 子进程用 **Electron 自身**当 Node 跑（`ELECTRON_RUN_AS_NODE=1`），
 *     不依赖用户机器上装没装 Node —— 打包后没有第二份运行时。
 *   - 关窗只收起托盘，网关后台常驻（继续接客户端请求）；真退出走托盘 → before-quit
 *     停掉自己起的网关，避免 4412 端口残留占位。
 *   - 端口已被占用时（用户自己 `mx start` 过）**直接复用**，不再起第二个实例。
 *   - 单实例：已有实例在跑（含关窗后托盘后台）时，再次启动只把已有窗口调到前台；
 *     未拿到锁的实例必须立刻退出，且不得再走启动流程（否则会闪窗、甚至抢 4412）。
 *   - 失败要分清原因：端口被占 ≠ 起动超时 ≠ 网关崩溃，错误页分别说明。
 */

const { app, BrowserWindow, dialog, shell, Menu, Tray, nativeImage, ipcMain, nativeTheme } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

/** 网关监听地址。与 `mx` 默认值一致（`docs/CONTRACT-TS.md` §9）。 */
const HOST = "127.0.0.1";
const PORT = 4412;
const BASE = `http://${HOST}:${PORT}`;

/**
 * 存储根：`~/.modelmux`（共享层在 `MODELMUX_HOME` 未设时的默认值）。
 *
 * 安装版固定用它 —— 换机迁移靠整目录拷贝 `~/.modelmux`，不另设便携分支：
 * electron-builder 的 NSIS 安装器不设 `PORTABLE_EXECUTABLE_DIR`，便携打包壳又已废弃
 * （每次启动全量解压，见 docs/DESKTOP-APP.md），留着分支只会制造「配置了不生效」的坑。
 */
function homeDir() {
  return path.join(os.homedir(), ".modelmux");
}

/** 起网关最多等多久（首次启动要扫渠道凭据，比热启动慢）。 */
const BOOT_TIMEOUT_MS = 45_000;

/** @type {import("node:child_process").ChildProcess | null} */
let gateway = null;
/** @type {BrowserWindow | null} */
let win = null;
/** 我们自己起的网关吗？复用别人的进程时不能去杀它。 */
let ownsGateway = false;
/** 网关是否健康过（用于区分「起来后崩了」与「压根没起来」）。 */
let gatewayReady = false;
/** 子进程 stderr 里的关键线索（端口被占等）。 */
let gatewayFailureHint = "";
/** 复用了别人起的网关（不是我们 fork 的，退出时不能杀）。 */
let reusedGateway = false;
/** @type {Tray | null} */
let tray = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：立刻退出，且**不能**再走下面的启动流程 —— 否则会闪一个窗口、
  // 甚至因健康探测竞态再 fork 一个网关来抢 4412。
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
    // Windows 前台锁：仅 win.focus() 常常压不上前台，必须由 app 层面 steal
    app.focus({ steal: true });
  });

  // 窗口控制桥与主题跟随只注册一次（重复注册 ipcMain.handle 会抛错）
  registerWindowIpc();

  app.whenReady().then(async () => {
    // 去掉默认菜单：单页控制台用不上，还占一行原生高度
    Menu.setApplicationMenu(null);

    // 托盘常驻：关窗后网关继续跑，托盘是唯一的可见入口与退出通道
    createTray();

    // 已有网关在跑（用户自己 `mx start`）→ 复用，不再起第二个
    const already = await probeHealth();
    if (already) reusedGateway = true;
    else startGateway();
    refreshTrayMenu();

    await createWindow();

    app.on("activate", () => {
      showWindow();
    });
  });
}

/** 探测 `/health`：返回 true 表示已有可用网关（含用户自己起的）。 */
function probeHealth(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/health`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(j.ok === true && j.service === "modelmux");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 轮询等到网关可用，或超时。 */
async function waitForGateway() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 起内嵌网关。
 *
 * `ELECTRON_RUN_AS_NODE=1` 让当前 exe 以纯 Node 模式运行（没有 Chromium、没有窗口），
 * 于是 `process.execPath` 就是可用的 node 解释器 —— 这是打包后唯一的运行时来源。
 */
function startGateway() {
  const script = path.join(__dirname, "app", "modelmux.mjs");
  const child = spawn(process.execPath, [script, "serve"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  ownsGateway = true;
  gateway = child;

  child.stderr?.on("data", (buf) => {
    const text = buf.toString().trim();
    if (!text) return;
    console.error("[gateway]", text);
    // 端口被占是用户最常遇到的失败：把线索记下来给错误页用
    if (/port \d+ is held/i.test(text)) gatewayFailureHint = text;
  });

  child.on("exit", (code, signal) => {
    if (gateway === child) {
      gateway = null;
      ownsGateway = false;
    }
    refreshTrayMenu(); // 状态变了，托盘菜单第一行跟着更新
    // 「起来过又崩了」才值得弹窗打断用户；压根没起来交给错误页说明
    if (gatewayReady && code !== 0 && code !== null && !app.isQuitting) {
      void dialog.showMessageBox({
        type: "error",
        title: "modelmux 网关已退出",
        message: `网关进程异常退出（code ${code}${signal ? `, ${signal}` : ""}）`,
        detail: "窗口会保留。日志在 ~/.modelmux/logs/system/ 下。",
        buttons: ["好"],
      });
    }
  });

  return child;
}

/** 停内嵌网关：只杀自己起的那个。 */
function stopGateway() {
  if (!ownsGateway || !gateway) return;
  try {
    gateway.kill();
  } catch {
    /* 进程可能已退出 */
  }
  gateway = null;
  ownsGateway = false;
}

/**
 * 托盘入口：常驻 + 后台管理。
 *
 * 为什么要有：关窗后网关还在跑（后台继续接客户端请求），没有托盘就没有「看得见、
 * 关得掉」的入口 —— 用户只能去任务管理器结束进程。托盘给出显示窗口 / 打开浏览器 /
 * 退出三个动作，并显示网关当前状态。
 */
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "assets", "icon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip("modelmux 控制台");
  refreshTrayMenu();
  // 单击恢复窗口（Windows 上的常见约定；双击同样走这里）
  tray.on("click", showWindow);
}

/** 重建托盘菜单（网关状态会变，菜单要跟着刷新）。 */
function refreshTrayMenu() {
  if (!tray) return;
  const running = gateway !== null || reusedGateway;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: running ? "网关：运行中" : "网关：未运行", enabled: false },
      { type: "separator" },
      { label: "打开控制台", click: showWindow },
      { label: "在浏览器打开", click: () => void shell.openExternal(`${BASE}/web/`) },
      { type: "separator" },
      {
        label: "退出 modelmux",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** 显示并聚焦主窗口（窗口被关掉过就重建）。 */
function showWindow() {
  if (!win) {
    void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  // Windows 前台锁：后台进程直接 show/focus 压不过前台程序（窗口会停在 Z 序中段）。
  // 先置顶再取消，把窗口顶到最前；这一下闪烁是可接受的代价。
  if (!win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
  }
  win.moveTop();
  win.focus();
}

/** 窗口背景色随主题（深 = surface，浅 = canvas），与 web 的根底色一致。 */
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#171717" : "#f9f9f9";
}

/** 用户主题（`~/.modelmux/setting.json` 的 theme 字段）；缺失 / 损坏 / 非法 → 跟随系统。 */
function startupTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir(), "setting.json"), "utf8"));
    if (raw?.theme === "dark" || raw?.theme === "light" || raw?.theme === "system") return raw.theme;
  } catch {
    /* 缺失 / 损坏 → 跟随系统 */
  }
  return "system";
}

/**
 * 窗口控制桥的白名单通道 + 主题跟随，**注册一次**（进程级）。
 *
 * 为什么不在 createWindow 里注册：`ipcMain.handle` 对同一通道重复注册会抛
 * 「Attempted to register a second handler」，而窗口销毁后重建（showWindow 的
 * `win === null` 分支）会再走一遍 createWindow —— 注册放里面就是一颗雷。
 * 处理器读模块级 `win`，窗口换了也照样生效。
 */
function registerWindowIpc() {
  ipcMain.handle("win:minimize", () => win?.minimize());
  ipcMain.handle("win:toggle-maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("win:close", () => win?.close());
  ipcMain.handle("win:is-maximized", () => win?.isMaximized() ?? false);
  ipcMain.handle("theme:set", (_event, mode) => {
    if (mode !== "system" && mode !== "dark" && mode !== "light") return;
    nativeTheme.themeSource = mode;
    win?.setBackgroundColor(windowBackground());
  });
  // 系统深浅变化 → 窗口背景跟随（resize 边缘与首帧不再露出深色残边）
  nativeTheme.on("updated", () => win?.setBackgroundColor(windowBackground()));
}

async function createWindow() {
  // 标题栏隐藏：顶栏即拖拽区，窗口控制钮由 web 顶栏渲染（经 preload 桥调回来）。
  // 背景色在 loadURL **之前**按主题设对 —— 首帧不闪错色。
  nativeTheme.themeSource = startupTheme();
  win = new BrowserWindow({
    width: 1300,
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: windowBackground(),
    titleBarStyle: "hidden",
    show: false,
    title: "modelmux",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      // 控制台是普通网页：不需要 Node，保持隔离；唯一 preload 是窗口控制桥
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.once("ready-to-show", () => win?.show());

  // 最大化状态推送给顶栏的窗口控制钮（图标在最大化 / 还原间切换）
  const pushMaximize = () => win?.webContents.send("win:maximize-changed", win.isMaximized());
  win.on("maximize", pushMaximize);
  win.on("unmaximize", pushMaximize);

  // 外链交给系统浏览器：新窗口走 setWindowOpenHandler，当前窗口的跳转走 will-navigate ——
  // 窗口自身绝不导航离开控制台（自定义标题栏没有返回键，离开了就回不来）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${BASE}/`)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  // 渲染进程崩了（OOM / GPU 故障）→ 重载恢复；网关已死时重载会落到错误页
  win.webContents.on("render-process-gone", () => {
    if (!win?.isDestroyed()) win?.webContents.reload();
  });

  // 主框架加载失败（网关在健康检查后死掉）→ 错误页，别让「正在启动」永远转圈；
  // ERR_ABORTED（-3）是 loadURL 替换页面时的正常取消，忽略
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !win || win.isDestroyed()) return;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPage(gatewayFailureHint))}`);
  });

  // 关窗只**收起**到托盘，不退出：网关继续在后台接客户端请求，用户从托盘再打开或退出。
  // 真要退出走托盘菜单（那时 app.isQuitting 已置位，不再拦截）。
  win.on("close", (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    win?.hide();
  });

  win.on("closed", () => {
    win = null;
  });

  // 先显示过渡页：网关冷启动要几秒，「正在启动」比「什么都没发生」好
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bootPage())}`);

  const ok = await waitForGateway();
  if (!win) return;

  if (ok) {
    gatewayReady = true;
    refreshTrayMenu();
    await win.loadURL(`${BASE}/web/`);
  } else {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(errorPage(gatewayFailureHint))}`,
    );
  }
}

/** 过渡页 / 错误页配色：跟随当前主题，避免浅色系统下首帧黑闪。 */
function pageColors() {
  return nativeTheme.shouldUseDarkColors
    ? { bg: "#171717", fg: "#e5e5e5", muted: "#8b8b8b", code: "#262626" }
    : { bg: "#f9f9f9", fg: "#171717", muted: "#5f5f5f", code: "#ececec" };
}

/** 启动中的过渡页（配色随主题，与 Web 控制台同色系）。 */
function bootPage() {
  const c = pageColors();
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:${c.bg};color:${c.fg};
    font:14px -apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
  .box{text-align:center}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;
    margin:0 3px;animation:p 1.2s ease-in-out infinite}
  .dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
  @keyframes p{0%,80%,100%{opacity:.25}40%{opacity:1}}
  p{margin:16px 0 0;color:${c.muted};font-size:13px}
</style>
<div class="box">
  <div><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <p>正在启动 modelmux 网关…</p>
</div>`;
}

/** 启动失败页：按失败原因分别说明。 */
function errorPage(hint) {
  const specific = hint
    ? `<p>上游输出：<code>${hint.replace(/</g, "&lt;")}</code></p>
       <p>端口 4412 被别的进程占着（多半是之前没关干净的网关）。在任务管理器里结束那个
       <code>node</code> / <code>electron</code> 进程，或重启电脑后再开。</p>`
    : `<p>网关在 ${Math.round(BOOT_TIMEOUT_MS / 1000)} 秒内没有就绪。</p>`;

  const c = pageColors();
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:${c.bg};color:${c.fg};
    font:14px -apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
  .box{max-width:560px;text-align:left;padding:0 24px}
  h1{font-size:16px;margin:0 0 12px;color:#f87171}
  p{margin:8px 0;color:${c.muted};line-height:1.6}
  code{background:${c.code};padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}
</style>
<div class="box">
  <h1>modelmux 启动失败</h1>
  ${specific}
  <p>排查：查看 <code>~/.modelmux/logs/system/</code> 下的日志；或在终端执行
     <code>mx serve</code> 看实时输出。</p>
</div>`;
}

/** 退出前停掉自己起的网关（复用的不动）。 */
app.on("before-quit", () => {
  app.isQuitting = true;
  stopGateway();
});

// 关窗不退出：托盘常驻，网关在后台继续接请求。退出只走托盘菜单 / before-quit。
app.on("window-all-closed", () => {
  /* 刻意留空：见上方 close 处理 */
});
