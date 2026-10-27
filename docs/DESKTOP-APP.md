# DESKTOP-APP —— 桌面壳（Windows exe）

把「网关 + Web 控制台」包成 Windows 桌面应用：独立窗口 + 托盘常驻，双击即用。
选型与分发调研的完整依据见 `.planning/2026-10-26-desktop-app-selection/`（gitignore 过程文件，
结论已沉淀到本文件）。

## 形态与架构

```
desktop/                     独立构建环境（不进 npm workspaces —— Electron 工具链与主仓隔离）
├── src/main.ts              Electron 主进程壳
├── scripts/bundle.mjs       打 main.cjs + gateway.cjs，拷 ui/ 与 models/
├── electron-builder.yml     NSIS + portable（x64 + arm64）
└── release/                 打包产物（gitignore）
```

- **壳是网关的「另一个前端」，不是网关的所有者**：启动先探 `127.0.0.1:4412/health`
  （判据 `service === "modelmux"` 且 `ok === true`）。已有 modelmux 网关（`mx start`
  的守护）→ 直接复用加载 `/web/`，退出壳**不动它**；没有 → `utilityProcess.fork`
  内嵌网关（`serve` 前台模式，生命周期归壳，崩溃按退避重启）。
- **网关代码零改动**：内嵌网关就是 `packages/cli/src/cli.ts` 的整包 bundle（cjs 形态），
  ui/ 与 models/ 按共享层「bundle 同级目录」的探测约定放在平级。
- **cjs 打包的一个坑**：cli 依赖链经 package.json exports 引到的是 dist 层 JS，
  其中的 `import.meta.url` 在 cjs 产物里为空 —— `scripts/bundle.mjs` 用 banner +
  define 把它绑到运行时 `__filename`（与 ESM 语义一致），ui/models 探测才正确。
- `MODELMUX_DESKTOP_ADDR` 环境变量可覆盖网关地址（测试用，如 `127.0.0.1:4499`）。

## 构建与验证

```bash
npm run build                     # 主仓：产出 packages/cli/dist/{ui,models}（desktop bundle 的输入）
cd desktop
npm install                       # Electron 工具链（独立 node_modules；走 .npmrc 的国内镜像）
npm run typecheck                 # 壳类型检查
npm run bundle                    # 打 main.cjs + gateway.cjs，拷 ui/ 与 models/
npm run pack                      # scripts/pack.mjs：注入镜像环境变量后调 electron-builder
```

产物（`desktop/release/`）：`modelmux Setup <版本>.exe`（NSIS 安装器）、
`modelmux <版本>.exe`（portable）、`latest.yml` + `.blockmap`（electron-updater 配套）。

## 安装形态与两个 exe 的区别

| 产物 | 是什么 | 安装落点 | 管理员 | 行为 |
| --- | --- | --- | --- | --- |
| `modelmux Setup <版本>.exe` | **NSIS 安装器** | `%LOCALAPPDATA%\Programs\modelmux`（per-user，默认）或 `C:\Program Files\modelmux`（选「所有用户」） | per-user 免提升；per-machine 需 UAC | 建桌面/开始菜单快捷方式与卸载器 |
| `modelmux <版本>.exe` | **portable 便携版** | 不落盘（每次运行解压到临时目录再启动） | 不需要 | 单 exe 双击即跑、关窗即走；**不建快捷方式/卸载器**，无自动更新 |

**NSIS 三种运行形态与已知差异**（实测）：

| 形态 | 写 `uninstallerIcon.ico` | 结果 |
| --- | --- | --- |
| GUI 安装（assisted，有向导页） | **写** | 本机实测失败（「不能打开要写入的文件」）→ 点「忽略」可跳过继续 |
| 静默安装（`/S`） | 不写 | ✅ 通过 |
| 一键安装（oneClick，无向导页） | 不写 | ✅ 通过 |

配置当前用 **oneClick: true**（无模式选择页、一次点击装完）；`perMachine: false` 为默认语义
（per-user 装 LOCALAPPDATA）。**若想要「所有用户」安装**，需改 `perMachine: true`（会走 UAC）。

> 图标 ICO 必须是**标准多尺寸 BMP-in-ICO**（16/24/32/48/64/128/256）——
> 单尺寸 PNG-in-ICO 会被 NSIS 的图标处理链拒绝（`desktop/scripts/icon.mjs` 生成，
> 与 Web 控制台 favicon 同款白鲸鱼、透明底）。

## 安装与分发（用户视角）

| 项 | 现状 |
| --- | --- |
| 安装形态 | **一键安装**（oneClick：无向导页、一次点击装完）+ portable 免安装版 |
| 系统要求 | Windows 10 22H2+ (x64) / Windows 11 (arm64)；**零预装依赖**（Electron 自带 Node 与 Chromium） |
| 图标 | 与 Web 控制台 favicon **同款**（白色鲸鱼、透明底）；`scripts/icon.mjs` 生成深底无关的透明 PNG + 标准多尺寸 BMP-in-ICO |
| 签名 | **v1 未签名**（见下方「SmartScreen 与签名」） |
| 自动更新 | electron-updater + GitHub Releases 的配置已就位（`publish` 段 + latest.yml）；v1 尚未接 UI 内更新提示 |
| 数据与共存 | 数据仍在 `~/.modelmux`，与 `mx` CLI 共用同一网关与账号池；壳启动探到已有网关就复用，不抢 4412 |

### SmartScreen 与签名（免费路径优先）

**机制**：SmartScreen 只检查带 **Mark of the Web（MotW）** 的文件 —— 浏览器下载的文件会被打上 MotW；
文件哈希的**下载信誉**随下载量累积，信誉够了即使未签名也不弹。这解释了两类「开源项目装了不弹」：
大项目靠信誉，或用户根本没走浏览器下载（本地构建 / winget / curl 下载不带 MotW）。

**免费做法（按推荐顺序）**：

1. **README 给出「解除锁定」一步**：右键 exe → 属性 → 勾「解除锁定」→ 确定（等于手动去 MotW），再运行。
2. **引导走无 MotW 的下载方式**：`winget install`（提交 manifest 后）或
   `curl -L -o modelmux-setup.exe <release 链接>`（命令行下载器不打 MotW）。
3. **信誉累积**：同一版本产物随下载量增长会逐步通过 SmartScreen（无需任何证书）；缺点是首版必弹一次。

**要钱的做法（后置）**：Azure Artifact Signing（$9.99/月，个人可办）—— 注意 2024 起
**EV 证书已不再给即时 SmartScreen 信誉**（DigiCert 2026-06 公告），所以贵价的 EV 相对
Artifact Signing 已无优势；需要的是「签名身份」而非「跳过警告」。装机量上来后再上。

## 打包网络与镜像 / 离线（案 A / 案 C）

**镜像源（一劳永逸，不依赖代理）**：

- `desktop/.npmrc` —— `electron_mirror`（npm install 时的 Electron 二进制）+
  `electron_builder_binaries_mirror`（electron-builder 的 7z / winCodeSign / nsis 等）。
- `desktop/scripts/pack.mjs` —— 打包前显式注入两个镜像环境变量再调 electron-builder
  （跨平台、无 npm 11 对非白名单键的告警噪音）。
- ⚠ electron-builder 26 起**不接受** `electronGet` / `env` 根配置项（schema 校验会拒），
  `.npmrc` + 环境变量是唯一稳定载体。

**离线打包（案 C）**：

1. 在有网（或镜像）环境完整跑一次 `npm run pack`，把
   `%LOCALAPPDATA%\electron-builder\Cache` 与 `%LOCALAPPDATA%\electron\Cache` 拉满；
2. 之后**同 Electron 版本 + 同架构**打包不发起网络请求（缓存命中），无需代理/镜像；
3. **换 Electron 版本或新增架构**（如 arm64）会重新触发下载 —— 那时再走镜像或代理。

**本机已知噪音**：npm 11 对 `.npmrc` 中非白名单键打印 `Unknown project config` 警告
（npmmirror 官方文档同款写法），不影响 `@electron/get` 读取（它认 `npm_config_*` 环境变量）——
功能验证以产物为准。

## 已知问题与边界

1. **assisted 安装的 GUI 路径写 `uninstallerIcon.ico`**：实测报「不能打开要写入的文件」
   （静默与一键路径都不写，因此都成功）。已默认切 **oneClick** 绕开；若启用 assisted，
   点「忽略」可跳过该文件继续安装（只影响卸载器图标）。
2. **SmartScreen 弹窗**（「打开文件 - 安全警告」/「未知发布者」）：未签名应用的必然结果。
   弹窗按钮是自定义绘制控件（无 HWND 子窗口）——**键盘 Alt+助记键**（如 Alt+R）可点，
   或右键 exe → 属性 → 解除锁定（去 MotW）。根治 = 签名（见「SmartScreen 与签名」）。
3. **本机 Git Bash 启动受限**：从 Git Bash / 管道环境直接拉 Electron，GPU 沙箱进程可能因
   `AppData\Roaming\Electron` 的 ACL 被 0x5 拒绝而静默退出（诊断用
   `ELECTRON_ENABLE_LOGGING=1` + `--no-sandbox` 可复现主进程逻辑）。资源管理器
   双击安装版/portable 不走这条链 —— 验证以双击为准。
4. 32 位 Windows（ia32）不支持：Electron 44 起不再发布该架构。
5. `C:\Program Files\modelmux\` 是 per-machine 安装的落点（选「所有用户」时）；per-user
   落点是 `%LOCALAPPDATA%\Programs\modelmux`。
