# 桌面壳（Windows 便携 exe）

modelmux 的可选 Windows 分发形态：**portable 单文件 exe**（Electron）。
双击 → 自启网关 → 内嵌窗口显示 Web 控制台 → 关窗自动收网关。
构建工程在 `desktop/`，产物 `desktop/dist/modelmux.exe`。

本文件是桌面壳的**唯一规范源**：形态、行为、构建、路径约束、签名 / MotW 真相、便携模式。

## 1. 形态与行为

| 行为 | 口径 |
| --- | --- |
| 双击启动 | ShellExecute 直跑，先探 `127.0.0.1:4412/health`：已有网关则**复用**（不重复起实例、退出也不杀别人的），否则 fork 内嵌网关 |
| 网关进程 | `ELECTRON_RUN_AS_NODE=1` + 自身 exe 跑 `app/modelmux.mjs`（打包后的 CLI bundle，零第三方运行依赖）—— **不要求用户装 Node** |
| 窗口 | 1280×860，无原生菜单，`contextIsolation` + `sandbox` 开，**没有 preload、没有 IPC** —— loadURL 型壳，渲染层就是网关托管的控制台（设计选择，最小攻击面） |
| 关窗 | `before-quit` → 停**自己起的**网关；复用的网关不受影响 |
| 失败分因 | 端口被占（stderr 线索）≠ 起动超时 ≠ 起来后崩溃，错误页分别说明 |

## 2. 构建

工程 `desktop/`。**不在 npm workspaces** —— Electron 工具链与主仓隔离，
避免根 `npm install` 给所有开发者拉 100MB+ 的 Electron。

```sh
npm run build          # 先出 CLI bundle + ui + 注册表
npm run desktop        # 拷 payload → desktop/app/ → electron-builder portable
```

产物 `desktop/dist/modelmux.exe`（~97 MB）。

依赖安装走 `desktop/.npmrc` 的镜像；根 `npm install` **不会**装 Electron
（`desktop/` 不在 workspaces），首次打包时由 pack 脚本自动补装。

## 3. 路径敏感性（实测，2026-11-10）

Electron 运行时对本机路径敏感，**同一份二进制、同一个脚本**：

| 存放位置 | exe 全路径长度 | 结果 |
| --- | --- | --- |
| `C:\Temp\etest` | 17 字符 | 正常 `READY` |
| 桌面 `C:\Users\bluechonk\Desktop\` | ~38 字符 | 正常（窗口出、网关起） |
| `C:\Temp\<120 个 a>\e43dist` | 137 字符 | **exit 0 静默退出，脚本不执行** |
| 仓库深路径（`Documents\...\.tmp\gh-profile-exe\...`） | ~138 字符 | **段错误 `0xC0000005`**，`app.whenReady` 不触发 |
| 仓库 `desktop\dist\`（构建产物原地双击） | ~140 字符 | **挂起**（portable 自解压不完成） |

结论与口径：

- **Electron 运行时（dev 直跑与 portable 双击都）只认短路径** —— 工程与产物 exe 都要放在
  `C:\Temp\<name>` / 桌面这一级的短路径；放仓库 dist 或 Documents 深处会静默退出、段错误或挂起。
  长度与路径成分哪个是主因未深挖，以「短路径」为准。
- **构建不受影响**：electron-builder 只打包不执行 Electron，仓库内构建正常；
  构建完把 `desktop/dist/modelmux.exe` **拷到桌面等短路径**再双击。
- **便携模式**下网关的存储根 = exe 旁的 `data/` —— `data/` 同样放短路径。

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

## 5. 便携模式（换机免逐渠道重新登录）

网关的存储根由 `MODELMUX_HOME` 覆盖（`docs/STORAGE-CONVENTION.md`）。桌面壳在
exe 同目录检测到 `data/channels/` 时，把 `data/` 作为 `MODELMUX_HOME` 传给网关 ——
**凭据随 exe 走，换机免逐渠道重新登录**。

导出脚本：`.tmp/export-portable.ps1`（把 `~/.modelmux` 的账号与状态打包成 `data/`，
排除 `logs/`、`backups/`、`debug/`、pid）。

**边界（设计约束，不是待办）**：

- `data/` 内是**明文凭据** —— 用户自己的账号登录态，不放公共网盘 / 他人可碰的目录。
- `data/` **永不入库、永不打进 exe**（凭据红线）。`.gitignore` 已覆盖 `desktop/data/`。
- 凭据是各上游服务的会话令牌，部分渠道绑定设备指纹 / IP —— 换机后个别渠道仍可能
  被上游风控要求重登，那是上游行为，便携模式消除的是迁移摩擦，不是认证本身。
- 渠道本身**必须登录**才能用：modelmux 是代理，转发的是你个人账号的请求，
  「exe 自带可用渠道」= 凭据分发，红线禁止。

## 6. 已知边界

- **ia32 不支持**：Electron 44 起不再发布 32 位。
- **Git Bash / 管道环境直跑 dev Electron** 有 GPU 沙箱噪音（历史记录），验证以
  **资源管理器双击**为准。
- 构建需走镜像（`desktop/.npmrc` 已配 electron / electron-builder-binaries）。
- 便携 `data/` 的路径长度同受 §3 约束。
