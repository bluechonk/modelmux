# 桌面壳（Windows 安装版）

modelmux 的可选 Windows 分发形态：**NSIS 一键安装器**（Electron）。
双击安装包 → 装到 `%LOCALAPPDATA%\Programs\modelmux-desktop` → 桌面建 `modelmux` 快捷方式 →
双击快捷方式自启网关、内嵌窗口显示 Web 控制台 → 关窗收起为托盘（后台常驻）→ 托盘退出才真退。
构建工程在 `desktop/`，产物 `desktop/dist/modelmux-setup-<版本>.exe`。

本文件是桌面壳的**唯一规范源**：形态、行为、构建、路径约束、签名 / MotW 真相、存储根。

## 1. 形态与行为

| 行为 | 口径 |
| --- | --- |
| 启动 | ShellExecute 直跑安装后的 exe，先探 `127.0.0.1:4412/health`：已有网关则**复用**（不重复起实例、退出也不杀别人的），否则 fork 内嵌网关 |
| 单实例 | 已有实例在跑（含关窗后托盘后台）时，再次启动只把已有窗口调到前台（`second-instance` → 显示窗口 + 先置顶再取消 + `app.focus({steal:true})`）；未拿到锁的实例立即退出，不再走启动流程 |
| 网关进程 | `ELECTRON_RUN_AS_NODE=1` + 自身 exe 跑 `app/modelmux.mjs`（打包后的 CLI bundle，零第三方运行依赖）—— **不要求用户装 Node** |
| 窗口 | 默认 1300×1000，最小 800×600；**标题栏隐藏**（顶栏即拖拽区，窗口控制钮在顶栏右侧，见下节）；`contextIsolation` + `sandbox` 开，**唯一 preload 是窗口控制桥**（白名单通道）—— 渲染层仍是网关托管的控制台 |
| 关窗 | **收起为托盘**（`hide`，不退出）；网关继续在后台接客户端请求，托盘是唯一的可见入口与退出通道 |
| 托盘 | 常驻通知区；菜单：网关状态（禁用项）/ 打开控制台 / 在浏览器打开 / 退出。单击托盘图标 = 打开控制台 |
| 退出 | 只走托盘菜单 → `app.isQuitting` → `before-quit` → 停**自己起的**网关；复用的网关不受影响 |
| 失败分因 | 端口被占（stderr 线索）≠ 起动超时 ≠ 起来后崩溃，错误页分别说明；主框架加载失败（`did-fail-load`）也落错误页，不让「正在启动」无限转圈 |
| 崩溃恢复 | 渲染进程崩了（`render-process-gone`）自动重载窗口；网关已死时重载落到错误页 |
| 外链 | 窗口内跳转（`will-navigate`）与新窗口（`setWindowOpenHandler`）都交系统浏览器 —— 窗口绝不导航离开控制台（没有返回键） |

### 前置条件（新机器零依赖）

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 1809+ / 11，x64 |
| Node.js / npm / mx CLI | **不需要** —— 网关子进程是 exe 自身以 `ELECTRON_RUN_AS_NODE=1` 跑内置 `app/modelmux.mjs`；渠道登录走内嵌 Web 控制台 |
| VC++ 运行时 | **不需要** —— CRT 静态链接（2026-11-10 用 objdump 扫 `win-unpacked` 全部二进制，无 `vcruntime140` / `msvcp140` 导入） |
| 凭据 | **不随 exe 附带** —— 首次使用需在 Web 控制台逐渠道登录；换机即换凭据 |
| 网络 | 需要（上游推理与模型目录） |

### 自定义标题栏与拖拽

- 标题栏隐藏（`titleBarStyle: "hidden"`）：web 顶栏（LayoutSingle 的 `<header>`）即
  **拖拽区**（`.drag-region`）；顶栏上所有可点子元素（导航 / base_url / 主题钮 /
  窗口控制钮）逐个 `.no-drag` —— 缀一个少一个，点击就会被拖拽区吞掉（最常见坑）。
- 窗口控制钮（最小化 / 最大化还原 / 关闭）**只在桌面壳渲染**：以 `window.modelmuxWindow`
  桥存在与否判断，浏览器里没有窗口，不渲染。关闭 = 收起托盘（与关窗拦截一致）；
  真退出走托盘菜单。
- **白名单通道**（`desktop/preload.cjs`）：`win:minimize` / `win:toggle-maximize` /
  `win:close` / `win:is-maximized` / `win:maximize-changed`（推送）/ `theme:set`。
  不暴露 `ipcRenderer` 本体、不暴露 `webContents`；`contextIsolation` + `sandbox` 维持开。
- 已知边界：Win11 悬停 Snap Layout 拿不到（那是原生按钮的行为）；拖拽移动、
  双击最大化 / 边缘拉伸由系统提供，行为以真机为准。
- **主题跟随**：壳启动读 `<root>/setting.json` 设 `nativeTheme.themeSource`（首帧背景
  不闪错色），页面切主题时经 `theme:set` 同步；窗口背景与过渡页随之。

## 2. 构建

工程 `desktop/`。**不在 npm workspaces** —— Electron 工具链与主仓隔离，
避免根 `npm install` 给所有开发者拉 100MB+ 的 Electron。

```sh
npm run build          # 先出 CLI bundle + ui + 注册表
npm run desktop        # 拷 payload → desktop/app/ → electron-builder nsis
```

产物 `desktop/dist/modelmux-setup-<版本>.exe`（~97 MB）。双击安装：装到
`%LOCALAPPDATA%\Programs\modelmux-desktop`，桌面与开始菜单各建一个 `modelmux` 快捷方式，
并注册卸载器（控制面板 / 设置里可卸）。

**安装前提：先退出正在运行的 modelmux**（托盘 → 退出）。安装器启动时会检测
`modelmux.exe` 是否在跑，在跑会先尝试结束它再装；结束不掉就中止 —— 交互模式弹
「modelmux 无法关闭」，静默（`/S`）模式直接退出。低完整性（沙盒）启动时杀不动
中完整性进程，必然走到中止。

**为什么是安装器而不是便携单文件**：electron-builder 的 `portable` 目标（NSIS 模板）
每次启动都 `RMDir /r` 删掉 `%TEMP%` 下的解压目录再全量解压 —— 应用运行时再点一次要等
约 20 秒（冷启动约 6 秒），且删的正是正在运行的程序的文件。装到固定目录后没有解压，
第二次启动 0.3s 内触发单实例事件、窗口立即前置。

依赖安装走 `desktop/.npmrc` 的镜像；根 `npm install` **不会**装 Electron
（`desktop/` 不在 workspaces），首次打包时由 pack 脚本自动补装。

### 图标与版本信息（rcedit afterPack 钩子）

内层 exe 的图标与版本信息由 `desktop/after-pack.cjs` 用 `rcedit`（npm 包，自带
预编译二进制）在打包流程中写入：

- 写的是 `build/icon.ico`（6 尺寸，源图 `packages/ui/src/assets/logo-192.png`）；
- 同时写 `version-string`（ProductName / FileDescription / FileVersion），
  让任务栏、标题栏、托盘、属性页都用同一品牌标识。

**为什么不交给 electron-builder 的资源改写**：它依赖 winCodeSign 工具包，本机解压该包时
`app-builder` 建目录被拒（`mkdir ...\Cache\winCodeSign\<n>: Access is denied`，
手动建同名目录却正常）—— 与其跟工具链的缓存路径较劲，不如用 `rcedit` 直接写。
因此 `win.signAndEditExecutable` 保持 `false`（只跳过它的资源改写，不影响打包）。

## 3. 路径敏感性（实测，2026-11-10）

Electron 运行时对本机路径敏感，**同一份二进制、同一个脚本**：

| 存放位置 | exe 全路径长度 | 结果 |
| --- | --- | --- |
| `C:\Temp\etest` | 17 字符 | 正常 `READY` |
| 桌面 `C:\Users\bluechonk\Desktop\` | ~38 字符 | 正常（窗口出、网关起） |
| `C:\Temp\<120 个 a>\e43dist` | 137 字符 | **exit 0 静默退出，脚本不执行** |
| 仓库深路径（`Documents\...\.tmp\gh-profile-exe\...`） | ~138 字符 | **段错误 `0xC0000005`**，`app.whenReady` 不触发 |
| 安装目录 `%LOCALAPPDATA%\Programs\modelmux-desktop\` | ~45 字符 | 正常（安装版实际落点） |

结论与口径：

- **Electron 运行时只认短路径** —— dev 直跑与安装后的 exe 都如此；放 Documents 深处会
  静默退出或段错误。长度与路径成分哪个是主因未深挖，以「短路径」为准。
- **构建不受影响**：electron-builder 只打包不执行 Electron，仓库内构建正常；
  安装包双击安装即可，安装目录由安装器决定（短路径）。

## 4. MotW 与签名（为什么 bluechonk.exe 不弹、有的会弹）

「打开文件 - 安全警告」（无法验证发布者）只在文件带 **Mark of the Web**
（`Zone.Identifier` ADS，浏览器 / 压缩包 / 邮件客户端下载时打的「来自互联网」标签）时弹出。

- **签名不是门票**：未签名 + 无 MotW = 不弹（本地 `electron-builder` 构建产物天然无 MotW）。
- 签名影响的是另一件事：带 MotW 的未签名 exe 的 SmartScreen 首启提示
  （「Windows 已保护你的电脑」）。要消除它需要 OV/EV 证书（OV 仍需攒信誉，EV 立即生效）。
- 解除已有文件的 MotW：右键 → 属性 → 解除锁定，或 `Unblock-File`。

实测（2026-11-10，本机）：

| 检查项 | 结果 |
| --- | --- |
| 产物签名 | `NotSigned` |
| 产物 MotW | 无（`Zone.Identifier` 不存在） |
| Defender 查杀记录 | 无（精确匹配 exe 名与构建目录） |
| ShellExecute 双击 + 全窗口扫描「安全警告」对话框 | **未弹出** |

## 5. 存储根

固定 `~/.modelmux`（共享层在 `MODELMUX_HOME` 未设时的默认值）。换机迁移靠整目录拷贝
`~/.modelmux`（凭据 + 账号池 + 账本都在里面）；安装器不设 `deleteAppDataOnUninstall`，
同机重装不丢登录态。

> 曾有「便携分支」（`PORTABLE_EXECUTABLE_DIR` + 同目录 `data/`）用于 exe 与凭据一起拷贝，
> 但 NSIS 安装器不设该变量、便携打包目标已废弃，分支永远不会触发 —— 已从代码与本文移除，
> 需要时从 git 历史恢复。

**边界（设计约束，不是待办）**：

- `~/.modelmux` 内是**明文凭据** —— 用户自己的账号登录态，不放公共网盘 / 他人可碰的目录。
- 凭据是各上游服务的会话令牌，部分渠道绑定设备指纹 / IP —— 换机后个别渠道仍可能
  被上游风控要求重登，拷贝目录消除的是迁移摩擦，不是认证本身。
- 渠道本身**必须登录**才能用：modelmux 是代理，转发的是你个人账号的请求，
  「自带可用渠道」= 凭据分发，红线禁止。

## 6. 已知边界

- **ia32 不支持**：Electron 44 起不再发布 32 位。
- **Git Bash / 管道环境直跑 dev Electron** 有 GPU 沙箱噪音（历史记录），验证以
  **资源管理器双击**为准。
- 构建需走镜像（`desktop/.npmrc` 已配 electron / electron-builder-binaries）。
- **低完整性（沙盒）环境装不上**：安装目录 `%LOCALAPPDATA%\Programs` 是中完整性，
  沙盒 / 受限令牌启动的安装器写不进去 —— 表现为**先把旧版本文件清空再中止**
  （实测 2026-11-11，Codex 沙盒）。正常用户双击不受影响；沙盒内要装就绕过沙盒，
  或手动拷贝 `desktop/dist/win-unpacked/` 到安装目录（无卸载器入口）。
- **未签名警告由环境引入**：产物本身无 MotW（§4），但沙盒 / 下载场景可能被环境
  打上 MotW 而弹「无法验证发布者」——点「运行」即可，与产物无关。
- **托盘图标**：Windows 会把新出现的托盘图标折叠进「隐藏图标」区，需在任务栏设置里
  手动固定一次（系统行为，非缺陷）。
- **关窗后网关常驻**：这是设计（后台继续接客户端请求）；要停网关走托盘「退出」。
