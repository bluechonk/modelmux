/**
 * modelmux 桌面壳的**唯一** preload：窗口控制桥。
 *
 * 标题栏隐藏后，最小化 / 最大化 / 关闭必须由渲染层发起 —— 这里经 contextBridge
 * 暴露一个**白名单方法集**（每个方法固定一个 IPC 通道，不接受调用方传通道名）。
 * 不暴露 `ipcRenderer` 本体、不暴露 `webContents` / `remote`；`contextIsolation` 与
 * `sandbox` 维持开。渲染层能做的只有：最小化、最大化切换、关闭（收起托盘）、
 * 查询与订阅最大化状态、设置主题（nativeTheme，web 侧已先落 setting.json）。
 */

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  minimize: "win:minimize",
  toggleMaximize: "win:toggle-maximize",
  close: "win:close",
  isMaximized: "win:is-maximized",
  maximizeChanged: "win:maximize-changed",
  setTheme: "theme:set",
};

contextBridge.exposeInMainWorld("modelmuxWindow", {
  minimize: () => ipcRenderer.invoke(CHANNELS.minimize),
  toggleMaximize: () => ipcRenderer.invoke(CHANNELS.toggleMaximize),
  close: () => ipcRenderer.invoke(CHANNELS.close),
  isMaximized: () => ipcRenderer.invoke(CHANNELS.isMaximized),
  /** 订阅最大化状态变化；返回解绑函数。 */
  onMaximizeChange: (callback) => {
    const handler = (_event, maximized) => callback(maximized);
    ipcRenderer.on(CHANNELS.maximizeChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.maximizeChanged, handler);
  },
  /** 主题模式（"system" / "dark" / "light"）→ nativeTheme（窗口背景与表单控件跟随）。 */
  setTheme: (mode) => ipcRenderer.invoke(CHANNELS.setTheme, mode),
});
