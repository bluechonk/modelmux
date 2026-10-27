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
npm install                       # Electron 工具链（独立 node_modules；下载走代理时设 https_proxy）
npm run typecheck                 # 壳类型检查
npm run bundle                    # 打 main.cjs + gateway.cjs + ui + models
npm run pack                      # electron-builder 出 release/*.exe
```

产物（`desktop/release/`）：`modelmux Setup <版本>.exe`（NSIS 安装器，x64+arm64）、
`modelmux <版本>.exe`（portable，x64）、`latest.yml` + `.blockmap`（electron-updater 配套）。

## 安装与分发（用户视角）

| 项 | 现状 |
| --- | --- |
| 安装形态 | NSIS 向导（per-user 免管理员，可自选目录）+ portable 免安装版 |
| 系统要求 | Windows 10 22H2+ (x64) / Windows 11 (arm64)；**零预装依赖**（Electron 自带 Node 与 Chromium） |
| 图标 | 由 `desktop/scripts/icon.mjs` 从 Web 控制台 favicon（白色鲸鱼）合成深底 256px 版本 → `resources/icon.ico`（exe/安装器）+ `dist/icon.png`（托盘） |
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

## 已知问题与边界

1. **本机 Git Bash 启动受限**：开发者从 Git Bash / 管道环境直接拉 Electron，GPU 沙箱
   进程可能因 `AppData\Roaming\Electron` 的 ACL 被 0x5 拒绝而静默退出（诊断用
   `ELECTRON_ENABLE_LOGGING=1` + `--no-sandbox` 可复现主进程逻辑）。资源管理器
   双击安装版/portable 不走这条链 —— 验证以双击为准。
2. 32 位 Windows（ia32）不支持：Electron 44 起不再发布该架构。
3. 图标为 Electron 默认（v1 未定制 icon.ico）。
