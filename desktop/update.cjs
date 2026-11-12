/**
 * 桌面壳的自动更新：electron-updater + 应用内进度窗（居中卡片版）。
 *
 * 对齐 DeepSeek Harness 的做法：安装器仍是 electron-builder NSIS（per-user），更新由
 * electron-updater 编排 —— 应用内检查、应用内显示进度、`quitAndInstall()` 让应用**真正退出**
 * 后再跑安装器。这样安装器那套「应用正在运行」的检查根本不会触发（我们过去就卡在这：
 * 壳关窗只收托盘、不退出，安装器每次都要去杀，然后卡在旧卸载器/文件占用上）。
 *
 * 进度窗是主进程自建的独立小窗（不是 Web 控制台的一页）：更新期间它独立于主窗口，
 * 主窗口退出后仍然可见，装完由安装器拉起新版本。
 *
 * 关键约束：
 *   - `autoInstallOnAppQuit = false`：退出时不自动装，由我们在「下载完成」后显式安装，
 *     避免用户正常退出时莫名触发升级；
 *   - 安装前把 `app.isUpdating` 置位，主窗口的 close 拦截才会放行（否则又被收托盘）。
 */

const { app, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");

/** 检查间隔：每 4 小时一次（网关侧的更新检测仍是每天一次，两者互不依赖）。 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** 启动后首次检查的延迟：等网关健康检查过去，别在最忙的时候抢网。 */
const FIRST_CHECK_DELAY_MS = 8_000;

/** @type {BrowserWindow | null} */
let updateWin = null;
let installing = false;

/** 主题配色（进度窗固定深底，不跟随系统：更新场景浅/深切换会闪烁）。 */
const C = {
  bg: "#14161a",
  surface: "#1c1f24",
  card: "#24282f",
  overlay: "#31363e",
  line: "#383d45",
  ink: "#eceef1",
  soft: "#a9b0ba",
  faint: "#767d87",
  free: "#86d9a8",
  danger: "#ee7062",
};

/** 品牌 logo（内嵌 base64：data: 页面读不到本地文件）。 */
function logoDataUri() {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "assets", "icon.png")).toString("base64")}`;
  } catch {
    return "";
  }
}

/** 进度窗页面。逻辑全在 `__setState`，主进程只推状态。 */
function page() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:transparent}
    /* 窗口本身就是那张卡片：没有外框、没有窗口底色，只有卡片本身 */
    .card{width:100vw;height:100vh;box-sizing:border-box;padding:20px 22px;display:flex;flex-direction:column;
      background:${C.card};border:1px solid ${C.line};border-radius:14px;
      box-shadow:0 18px 50px rgba(0,0,0,.45)}
    .top{display:flex;align-items:center;gap:12px;margin-bottom:16px}
    .top img{width:40px;height:40px;border-radius:12px;object-fit:cover}
    .ttl{font-size:15px;font-weight:600;letter-spacing:-0.01em}
    .sub{font-size:12px;color:${C.soft};margin-top:1px}
    .bar{height:6px;border-radius:999px;background:${C.overlay};overflow:hidden}
    .bar>i{display:block;height:100%;border-radius:999px;background:${C.free});
      transition:width .2s linear}
    .bar.err>i{background:${C.danger}}
    .meta{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:${C.faint}}
    .meta .pct{font-family:ui-monospace,monospace;color:${C.soft}}
    .note{margin-top:auto;padding:9px 11px;border-radius:8px;font-size:11.5px;line-height:1.5;
      background:#3a2320;color:${C.danger}}
  </style></head><body>
    <div class="card">
      <div class="top">
        <img src="${logoDataUri()}" alt="modelmux" />
        <div><div class="ttl" id="title">正在检查更新</div>
             <div class="sub" id="sub">连接 GitHub Releases…</div></div>
      </div>
      <div class="bar" id="barwrap"><i id="bar" style="width:0%"></i></div>
      <div class="meta"><span id="status">正在检查…</span><span class="pct" id="pct"></span></div>
      <div class="note" id="note" hidden></div>
    </div>
    <script>
      window.__setState = function (s) {
        var $ = function (id) { return document.getElementById(id); };
        if (s.title) $("title").textContent = s.title;
        if (s.sub) $("sub").textContent = s.sub;
        if (s.status) $("status").textContent = s.status;
        if (s.pct) $("pct").textContent = s.pct;
        if (s.bar !== undefined) $("bar").style.width = s.bar + "%";
        $("barwrap").classList.toggle("err", !!s.err);
        if (s.note) { $("note").hidden = false; $("note").textContent = s.note; }
        else $("note").hidden = true;
      };
    </script>
  </body></html>`;
}

/** 创建进度窗（已存在则复用）。窗口无边框、透明底，只有卡片可见。 */
function ensureWindow() {
  if (updateWin && !updateWin.isDestroyed()) return updateWin;
  updateWin = new BrowserWindow({
    width: 420,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  updateWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page())}`);
  updateWin.on("closed", () => {
    updateWin = null;
  });
  updateWin.once("ready-to-show", () => updateWin?.show());
  return updateWin;
}

/** 推送一次状态到进度窗。 */
function render(state) {
  if (!updateWin || updateWin.isDestroyed()) return;
  void updateWin.webContents
    .executeJavaScript(`window.__setState(${JSON.stringify(state)})`)
    .catch(() => {});
}

/** 关掉进度窗（安装器接管之后）。 */
function closeWindow() {
  if (!updateWin || updateWin.isDestroyed()) return;
  updateWin.destroy();
  updateWin = null;
}

/** 开始安装：先置标志让主窗口的 close 拦截放行，再交给 electron-updater。 */
function install() {
  if (installing) return;
  installing = true;
  app.isUpdating = true;
  render({
    title: "正在安装更新",
    sub: "准备重启并安装",
    status: "正在退出应用…",
    bar: 100,
    pct: "100%",
  });
  // isSilent=true：安装器静默运行，不再弹 NSIS 自己的进度窗（用户只需看到上面这张卡片）；
  // isForceRunAfter=true：装完自动拉起新版本。
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

/** 用户主动触发一次检查（托盘菜单「检查更新」调用）。 */
function checkNow() {
  void autoUpdater.checkForUpdates().catch(() => {});
}

/**
 * 挂接更新能力。
 *
 * **刻意不做自动更新**：启动不检查、不定时检查，只有用户从托盘菜单点「检查更新」才走一遍。
 * 是否升级由用户决定 —— 控制台版本胶囊的黄点 + 「前往下载页」已经能告知新版本，
 * 这里提供的是「本机一键装上新版本」的可选入口。
 */
function setupAutoUpdate() {
  if (app.isPackaged === false) {
    // 开发模式（electron .）没有 app-update.yml，检查必然失败；不打扰开发。
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    ensureWindow();
    render({
      title: "正在检查更新",
      sub: "连接 GitHub Releases…",
      status: "正在检查…",
      bar: 0,
      pct: "",
    });
  });

  autoUpdater.on("update-available", (info) => {
    ensureWindow();
    render({
      title: "发现新版本",
      sub: `v${info.version} 已就绪，开始下载`,
      status: "正在下载更新包…",
      bar: 0,
      pct: "",
    });
  });

  autoUpdater.on("update-not-available", () => {
    ensureWindow();
    render({
      title: "当前已是最新版",
      sub: "没有检测到更新的版本",
      status: "已是最新",
      bar: 100,
      pct: "",
    });
    setTimeout(closeWindow, 1600);
  });

  autoUpdater.on("download-progress", (p) => {
    ensureWindow();
    const pct = Math.round(p.percent || 0);
    render({
      title: "正在安装更新",
      sub: "更新完成后将自动重启应用",
      status: "正在下载更新包…",
      bar: pct,
      pct: `${pct}%`,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    ensureWindow();
    render({
      title: "安装完成",
      sub: `即将重启 modelmux v${info.version}`,
      status: "正在准备重启…",
      bar: 100,
      pct: "100%",
    });
    setTimeout(install, 700);
  });

  autoUpdater.on("error", (err) => {
    ensureWindow();
    const message = String(err?.message ?? err);
    render({
      title: "更新失败",
      sub: "未能完成本次更新",
      status: message,
      err: true,
      note: message,
    });
  });
}

module.exports = { setupAutoUpdate, checkNow };
