/**
 * modelmux 桌面壳（Electron 主进程）：单实例锁 → 探活 4412 → 复用已有网关或
 * fork 内嵌网关 → BrowserWindow 加载 `/web/` → 托盘常驻（关窗最小化）。
 *
 * 关键约束（选型与分发调研见 .planning/2026-10-26-desktop-app-selection/）：
 *   - 壳是网关的「另一个前端」：4412 已有 modelmux 网关（mx start 守护）时直接
 *     复用，退出壳不动它 —— 只有自己 fork 的网关才在退出时终止。
 *   - fork 用 `utilityProcess`（官方 Node 子进程，与 daemon/supervisor 同构），
 *     子进程崩溃按退避重启；探活判据 `service === "modelmux"` 且 `ok === true`。
 *
 * 铁律：绝不占用/杀掉不是自己拉起的网关进程。
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  nativeImage,
  shell,
  utilityProcess,
} from "electron";
import type { UtilityProcess } from "electron";
import path from "node:path";

/** 网关地址：默认 4412；`MODELMUX_DESKTOP_ADDR` 可覆盖（测试用，如 127.0.0.1:4499 —— 不碰在跑的 4412）。 */
const GATEWAY_ADDR = process.env["MODELMUX_DESKTOP_ADDR"] ?? "127.0.0.1:4412";
const WEB_URL = `http://${GATEWAY_ADDR}/web/`;
const HEALTH_URL = `http://${GATEWAY_ADDR}/health`;
/** 等待自己拉起的网关就绪的窗口（毫秒）——与 `mx start` 默认等待一致。 */
const START_WAIT_MS = 30_000;
/** 探活单次请求超时。 */
const HEALTH_TIMEOUT_MS = 1500;
/** 网关子进程崩溃后的重启退避序列（毫秒），用尽后停手等用户操作。 */
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** 是否由本壳拉起并持有网关子进程（复用外部网关时恒 false）。 */
let gatewayProc: UtilityProcess | null = null;
/** app 正在退出（托盘退出 vs 关窗最小化的分界）。 */
let quitting = false;
/** 主窗口引用（单例）。 */
let win: BrowserWindow | null = null;
let tray: Tray | null = null;

/** 相对 dist 的资源路径（main.cjs / gateway.cjs / ui / models 同级；asar 关闭，普通目录）。 */
const distDir = __dirname;

/** 判定 /health 响应是否为「modelmux 网关已就绪」。 */
async function gatewayReady(): Promise<boolean> {
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: unknown; service?: unknown };
    return body.ok === true && body.service === "modelmux";
  } catch {
    return false;
  }
}

/** 轮询直至就绪或超时。 */
async function waitGatewayReady(waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await gatewayReady()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * fork 内嵌网关（`serve` 前台模式：不 daemonize、不落 PID 文件，生命周期归壳）。
 * 子进程崩溃按退避序列重启；用尽后停手（窗口断连可见，用户手动重开壳即可）。
 */
function forkGateway(): void {
  let attempt = 0;
  const spawn = (): void => {
    gatewayProc = utilityProcess.fork(path.join(distDir, "gateway.cjs"), [
      "serve",
      "--addr",
      GATEWAY_ADDR,
      "--no-open",
    ]);
    gatewayProc.on("exit", (code) => {
      gatewayProc = null;
      if (quitting) return;
      const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
      attempt += 1;
      console.warn(`[desktop] gateway exited (code ${String(code)}); restart in ${delay}ms`);
      setTimeout(() => {
        if (!quitting) spawn();
      }, delay);
    });
    gatewayProc.on("message", (m) => {
      if (m === "ready") attempt = 0;
    });
  };
  spawn();
}

/** 创建主窗口并加载控制台。 */
function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    title: "modelmux",
    show: false,
    // 标题栏隐藏：图标 + 文字禁止显示（窗口按钮保留在右上角）
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#212121", // 标题栏底色（与主区 bg-surface 一致）
      symbolColor: "#ffffff", // 窗口按钮（最小化/最大化/关闭）颜色
      height: 32,
    },
    // 窗口图标 = 应用图标（任务栏 + 标题栏；Chromium 渲染，alpha 正确）
    ...(appIcon() ? { icon: appIcon() } : {}),
  });

  // 站点白名单：只允许加载本机网关；外部链接一律交系统浏览器（控制台页面不受影响）。
  const allowed = (url: URL): boolean =>
    url.origin === `http://${GATEWAY_ADDR}` || url.protocol === "data:";
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!allowed(new URL(url))) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.once("ready-to-show", () => win?.show());
  // 断连（网关重启窗口期）自动重载：轮询 health，恢复后 loadURL 回来。
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain || quitting) return;
    console.warn(`[desktop] load failed (${code} ${desc}), retrying…`);
    const retry = async (): Promise<void> => {
      while (!quitting && !(await gatewayReady())) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      if (!quitting) void win?.loadURL(WEB_URL);
    };
    void retry();
  });
  void win.loadURL(WEB_URL);

  // 关窗 = 最小化到托盘（网关继续跑）；托盘菜单「退出」才真正退出。
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

/** 应用图标（透明 PNG，与 Web favicon 同款）：窗口图标用它 —— Windows 上窗口 hIcon
 *  同时决定任务栏与标题栏图标（Chromium 渲染，alpha 正确）。 */
function appIcon(): Electron.NativeImage | undefined {
  const png = nativeImage.createFromPath(path.join(distDir, "icon.png"));
  return png.isEmpty() ? undefined : png;
}
/** 托盘图标：用打包进包的透明 `icon.png`（Web logo 同款）；缺失时回落内嵌 16×16 PNG。
 *  ⚠ 不 resize —— 16px 缩放会把鲸鱼的尾鳍细节抹掉（Windows 会自行按 DPI 缩放）。 */
function trayIcon(): Electron.NativeImage {
  const bundled = nativeImage.createFromPath(path.join(distDir, "icon.png"));
  if (!bundled.isEmpty()) return bundled;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4nGNkYPj/n4ECwESJ5lED" +
    "Rg0YNWDUgFEDRg0YNWDUgFEDRg0YNWAAAH//A0UT+22VAAAAAElFTkSuQmCC";
  return nativeImage.createFromDataURL(`data:image/png;base64,${png}`);
}

/** 创建托盘与菜单。 */
function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("modelmux");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开控制台",
        click: () => {
          if (win) {
            win.show();
            win.focus();
          } else {
            createWindow();
          }
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          // 只终止自己 fork 的网关；复用的外部网关（mx start 守护）不受影响。
          gatewayProc?.kill();
          app.quit();
        },
      },
    ]),
  );
  // 左键点击托盘 = 打开/聚焦窗口（Windows 惯例）。
  tray.on("click", () => {
    if (win) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二实例：让第一实例聚焦即可。
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 应用图标（任务栏 + 窗口标题栏）：走 Chromium 渲染透明 PNG。
    // ⚠ 不能只依赖 exe 图标资源 —— rcedit 写入 exe 时会丢 alpha（透明区变黑），
    // 任务栏在深色主题下就是全黑方块。exe 资源仍保留（不透明深底版）作兜底。
    createTray();

    const reused = await gatewayReady();
    if (!reused) {
      forkGateway();
      const ready = await waitGatewayReady(START_WAIT_MS);
      if (!ready) {
        void dialog.showMessageBox({
          type: "error",
          title: "modelmux",
          message: `网关在 ${START_WAIT_MS / 1000} 秒内未就绪`,
          detail: `已尝试在 ${GATEWAY_ADDR} 拉起内嵌网关但健康检查超时。请检查日志后重试。`,
          buttons: ["确定"],
        });
      }
    }

    createWindow();
  });

  app.on("before-quit", () => {
    quitting = true;
    gatewayProc?.kill();
  });

  // macOS 惯例（本工具以 Windows 为主，兜底不空转）。
  app.on("window-all-closed", () => {
    if (!quitting) return; // 关窗只是隐藏（win.close 被 preventDefault），到不了这里；真到了（如 quit 流程）交给 before-quit。
    app.quit();
  });
}
