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

const { app, BrowserWindow, dialog, shell, Menu, Tray, nativeImage, ipcMain, nativeTheme, screen } = require("electron");
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
 * 存储根：`MODELMUX_HOME` > `~/.modelmux`（与共享层 `paths.resolveRoot` 同口径）。
 *
 * 必须认 `MODELMUX_HOME`：壳 fork 网关时把整个 `process.env` 传下去，所以网关会落在
 * 变量指向的目录；壳自己若硬算 `~/.modelmux`，写的 `watchdog.pause` / 读的
 * `setting.json` 就落到了网关与守护都不会看的地方 —— 托盘「退出 modelmux」会被外层
 * 守护在下一轮重新拉起（用户明确要停，结果停不掉），启动主题也会读错文件。
 *
 * 不设便携分支：electron-builder 的 NSIS 安装器不设 `PORTABLE_EXECUTABLE_DIR`，
 * 便携打包壳又已废弃（每次启动全量解压，见 docs/DESKTOP-APP.md）。
 */
function homeDir() {
  const override = process.env.MODELMUX_HOME;
  if (typeof override === "string" && override.trim() !== "") return override;
  return path.join(os.homedir(), ".modelmux");
}

/**
 * 外层守护（scripts/mx-watchdog.mjs）的暂停标记：存在 = 只探测不拉起。
 *
 * 为什么壳要管它：托盘「退出 modelmux」是**明确要停**，守护不该把它拉回来；
 * 壳启动是**明确要开**，要清掉标记让守护恢复保护（与 `mx start` / `mx stop` 同口径）。
 */
function setWatchdogPaused(paused) {
  const file = path.join(homeDir(), "watchdog.pause");
  try {
    if (paused) fs.writeFileSync(file, `${new Date().toISOString()}
`);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* 标记写不进去不影响退出/启动 */
  }
}

/** 窗口尺寸：最小与默认同为 1000×720（直接按这个数填，不做 DPI 换算）。 */
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 720;
/** 首次启动（或上次尺寸不可用）时的默认尺寸。 */
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 720;

/**
 * 开机自启注册时带上的命令行参数：登录后拉起壳但**静默收进托盘**，
 * 不抢用户前台（已开着的实例同理，见 second-instance 分支）。
 */
const HIDDEN_ARGS = ["--hidden"];
/** 本次进程是否由「登录自启」拉起（模块加载时定，早于 whenReady）。 */
const START_HIDDEN = process.argv.includes("--hidden");

/**
 * 窗口状态文件：`%APPDATA%/modelmux-desktop/window-state.json`。
 *
 * 为什么放 userData 而不是 `~/.modelmux/setting.json`：后者是**共享层**的用户偏好
 * （主题），由网关读写；窗口尺寸是桌面壳自己的事，两者不该互相牵扯。
 */
function windowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

/** 读上次退出时的窗口尺寸；缺失 / 损坏 / 字段非法一律回落默认。 */
function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStatePath(), "utf8"));
    const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    const width = num(raw?.["width"]);
    const height = num(raw?.["height"]);
    if (width === null || height === null) return null;
    const x = num(raw?.["x"]);
    const y = num(raw?.["y"]);
    return { width, height, x: x ?? undefined, y: y ?? undefined };
  } catch {
    /* 缺失 / 损坏 → 用默认尺寸 */
    return null;
  }
}

/** 落盘窗口尺寸（移动 / 缩放防抖后、关闭与退出时调用）。 */
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const { width, height, x, y } = win.getBounds();
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify({ width, height, x, y }));
  } catch {
    /* 只读 / 被占用：这次记不住而已，不值得打断用户 */
  }
}

/**
 * 上次的位置是否还落在某块屏幕上。
 *
 * 拔掉外接显示器 / 改分辨率后，保存的坐标可能落到所有屏幕之外 —— 窗口会「消失」，
 * 用户只能去任务栏里找。命中任一屏幕才复用，否则交给 Electron 摆到当前屏幕中央。
 */
function onAnyDisplay(x, y, width, height) {
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + height > b.y;
  });
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
/**
 * 网关**此刻**是否可用。
 *
 * 为什么单独记：`reusedGateway` / `gateway` 只说明「当初是谁起的」，网关随后被别的进程
 * （`mx restart`、任务管理器、托盘退出）停掉时它们不变 —— 页面于是永远停在骨架，
 * 用户看到的就是「控制台全是灰块」（2026-11-15 实测）。
 */
let gatewayHealthy = false;
/** @type {NodeJS.Timeout | null} */
let healthTimer = null;
/** @type {Tray | null} */
let tray = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：立刻退出，且**不能**再走下面的启动流程 —— 否则会闪一个窗口、
  // 甚至因健康探测竞态再 fork 一个网关来抢 4412。
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    // 开机自启（--hidden）拉起的重复实例保持静默：已有实例在跑就不再弹窗抢前台
    if (Array.isArray(commandLine) && commandLine.includes("--hidden")) return;
    showWindow();
    // Windows 前台锁：仅 win.focus() 常常压不上前台，必须由 app 层面 steal
    app.focus({ steal: true });
  });

  // 窗口控制桥与主题跟随只注册一次（重复注册 ipcMain.handle 会抛错）
  registerWindowIpc();

  app.whenReady().then(async () => {
    // 去掉默认菜单：单页控制台用不上，还占一行原生高度
    Menu.setApplicationMenu(null);

    // 壳启动 = 明确要开：撤销「用户明确退出」的标记，让外层守护恢复保护
    setWatchdogPaused(false);

    // 托盘常驻：关窗后网关继续跑，托盘是唯一的可见入口与退出通道
    createTray();

    // 已有网关在跑（用户自己 `mx start`）→ 复用，不再起第二个
    const already = await probeHealth();
    if (already) reusedGateway = true;
    else startGateway();
    refreshTrayMenu();

    await ensureWindow();

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

/** 存活巡检间隔：壳要能发现「网关没了」，不论它是自己起的还是复用来的。 */
const HEALTH_POLL_MS = 10_000;

/** 起存活巡检（幂等）。 */
function startGatewayWatch() {
  if (healthTimer) return;
  healthTimer = setInterval(() => void checkGatewayLiveness(), HEALTH_POLL_MS);
  // 巡检不该阻止进程退出（托盘常驻时进程本来就长活，这只防退出时被拖住）
  healthTimer.unref?.();
}

/**
 * 巡检一轮：网关断了换说明页，恢复后自动重新载入控制台。
 *
 * 为什么必须有：复用模式下壳不管理网关生命周期，`mx restart` 一跑页面就没了后端；
 * 没有巡检时页面既不报错也不恢复，永远停在骨架（2026-11-15 实测）。
 */
async function checkGatewayLiveness() {
  const ok = await probeHealth(2_000);
  if (ok === gatewayHealthy) return;
  gatewayHealthy = ok;
  refreshTrayMenu();
  if (!win || win.isDestroyed()) return;
  if (!ok) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(downPage())}`);
  } else {
    await win.loadURL(`${BASE}/web/`);
  }
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

  // spawn 本身失败（exe 不可执行 / EACCES / 打包后脚本缺失）只触发 `error`，
  // **不会**触发 `exit` —— 没有监听时它是主进程的未捕获异常，壳直接崩，用户连
  // 错误页都看不到。这里记下原因并清掉状态；页面由 `waitForGateway` 走错误页。
  child.on("error", (err) => {
    console.error("[gateway] spawn failed:", err);
    gatewayFailureHint = `无法启动网关进程：${String(err)}`;
    if (gateway === child) {
      gateway = null;
      ownsGateway = false;
    }
    gatewayHealthy = false;
    refreshTrayMenu();
  });

  child.on("exit", (code, signal) => {
    if (gateway === child) {
      gateway = null;
      ownsGateway = false;
    }
    gatewayHealthy = false; // 巡检与托盘据此把状态改成「未运行」
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
  // 按**当前存活**判定：复用来的网关被别人停掉后，`gateway`/`reusedGateway` 仍是旧值
  const running = gatewayHealthy;
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
          setWatchdogPaused(true); // 明确退出：外层守护不再把网关拉回来
          app.quit();
        },
      },
    ]),
  );
}

/**
 * 建窗单飞锁。
 *
 * `showWindow` 在 `win === null` 时重建窗口，而 `whenReady` 的主流程也会
 * `await createWindow()`。启动空窗期（健康探测最长 3s）里用户再点一次快捷方式，
 * 两条路径会各建一个 BrowserWindow —— 后者覆盖模块级 `win`，前者成为孤儿窗口
 * （可见，但关闭按钮关的是另一个，且永不被销毁）。
 */
let creatingWindow = null;

/** 显示并聚焦主窗口（窗口被关掉过就重建）。 */
function showWindow() {
  if (!win) {
    void ensureWindow();
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
  // 开机自启动：读 / 写 Windows 登录项。注册时固定带 --hidden（静默收托盘），
  // get 时传同一组 args 才能匹配上那条记录
  ipcMain.handle("autostart:get", () => app.getLoginItemSettings({ args: HIDDEN_ARGS }).openAtLogin);
  ipcMain.handle("autostart:set", (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: HIDDEN_ARGS });
  });
  // 系统深浅变化 → 窗口背景跟随（resize 边缘与首帧不再露出深色残边）
  nativeTheme.on("updated", () => win?.setBackgroundColor(windowBackground()));
}

/**
 * 保证窗口存在（单飞）：并发调用共享同一次建窗，不会建出两个 BrowserWindow。
 *
 * 见 `creatingWindow` 的说明 —— 启动空窗期里 `showWindow` 与主流程会同时要求建窗。
 */
async function ensureWindow() {
  if (win) return;
  if (creatingWindow) {
    await creatingWindow;
    return;
  }
  creatingWindow = createWindow().finally(() => {
    creatingWindow = null;
  });
  await creatingWindow;
}

async function createWindow() {
  // 标题栏隐藏：顶栏即拖拽区，窗口控制钮由 web 顶栏渲染（经 preload 桥调回来）。
  // 背景色在 loadURL **之前**按主题设对 —— 首帧不闪错色。
  nativeTheme.themeSource = startupTheme();
  // 还原上次的窗口尺寸与位置（缺记录 / 已不在任何屏幕上 → 默认尺寸居中）
  const saved = loadWindowState();
  const width = Math.max(MIN_WIDTH, saved?.["width"] ?? DEFAULT_WIDTH);
  const height = Math.max(MIN_HEIGHT, saved?.["height"] ?? DEFAULT_HEIGHT);
  const placed =
    saved?.["x"] !== undefined &&
    saved["y"] !== undefined &&
    onAnyDisplay(saved["x"], saved["y"], width, height);
  win = new BrowserWindow({
    width,
    height,
    ...(placed ? { x: saved["x"], y: saved["y"] } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
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

  // 开机自启拉起的进程不自动显示窗口：登录后静默收进托盘，用户点托盘再打开
  win.once("ready-to-show", () => { if (!START_HIDDEN) win?.show(); });

  // 缩放 / 移动后记住尺寸（防抖）：下次启动直接还原用户最后的窗口
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState();
    }, 400);
    if (saveTimer.unref) saveTimer.unref();
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);

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
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState();
    win = null;
  });

  // 先显示过渡页：网关冷启动要几秒，「正在启动」比「什么都没发生」好
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bootPage())}`);

  const ok = await waitForGateway();
  if (!win) return;

  // 存活巡检从第一轮就开着：启动失败也要能等到网关起来后自动恢复
  gatewayHealthy = ok;
  startGatewayWatch();

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

/** 网关断开页：说明现状并声明会自愈（恢复后由巡检自动载回控制台）。 */
function downPage() {
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
  <h1>modelmux 网关已断开</h1>
  <p>控制台与网关同进程，网关不在时读不到任何数据。</p>
  <p>网关恢复后本页会自动载回控制台；也可以从托盘菜单「打开控制台」手动重试。</p>
  <p>启动网关：在终端执行 <code>mx start</code>；日志在 <code>~/.modelmux/logs/system/</code>。</p>
</div>`;
}

/** 退出前停掉自己起的网关（复用的不动）。 */
app.on("before-quit", () => {
  app.isQuitting = true;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  saveWindowState();
  stopGateway();
});

// 关窗不退出：托盘常驻，网关在后台继续接请求。退出只走托盘菜单 / before-quit。
app.on("window-all-closed", () => {
  /* 刻意留空：见上方 close 处理 */
});
