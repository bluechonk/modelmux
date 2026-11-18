# 桌面壳主体化迁移方案（Desktop-First）

> 设计方案（未实施）。若产品决策把桌面壳定为主体形态、Web 控制台与 CLI 退居辅助，本文是落地路线；
> 现行壳行为契约见 [DESKTOP-APP.md](./DESKTOP-APP.md)，本文不是它的替代。

## 1. 目标与判定标准

把壳从「loadURL 观看窗」升级为「自带渲染层的主体应用」，同时**保留网关独立进程**：

```
desktop 壳（主体：窗口 + 托盘 + 渲染层 bundle）
 ├─ 渲染层：UI 构建产物打进 asar，file 协议本地加载，不等网关
 ├─ 数据层：继续调本机网关 /api/*（127.0.0.1:4412）
 └─ 服务管理：adopt / fork 网关进程，托盘具备起停权
gateway（服务，独立进程，现状不变）
 ├─ 继续 serve 4412 与三种入站协议，服务外部客户端
 └─ /web/ 静态托管保留为辅助形态（浏览器直连场景）
```

| 判定标准 | 目标值 |
| --- | --- |
| 壳冷启动到可交互 | < 800ms（渲染层本地加载，与网关就绪解耦） |
| 网关不可达时 | 界面骨架完整可见，数据区显示真实错误态，恢复后自动回填 |
| 外部客户端影响 | 零 —— 停壳不断服（除非用户显式选择停服） |
| 浏览器 /web/ 用户 | 功能不回退（同一份 UI 构建产物） |

## 2. 从现状带来与推翻的东西

| 现状机制 | 处置 |
| --- | --- |
| 壳探活复用 / fork 自带网关（`desktop/main.cjs:192`、`desktop/main.cjs:262`） | **保留**，升级为 adopt/管理语义 |
| 壳加载 `http://127.0.0.1:4412/web/`（`desktop/main.cjs:251`） | **推翻**，改为加载 asar 内 bundle |
| 网关托管 UI 双落点（`scripts/copy-ui.mjs`：gateway/dist/ui + cli/dist/ui） | **保留并加第三落点** desktop/app/ui |
| 同源防线 `isSameOrigin` + 回环名单（`packages/core/gateway/src/http/console/console.ts:327`、`:345`） | **扩展**：本地壳令牌通道（§3.1） |
| 「绝不占用 / 杀掉不属于自己的网关」边界 | **重划**：壳获得管理权，但动作全部显式化（§4） |
| preload 唯一桥（`desktop/preload.cjs`，窗口控制 + 主题） | **扩展白名单**：网关起停、版本比对、令牌读取（§5） |

## 3. 渲染层与数据层设计

### 3.1 安全：file 源下的 API 鉴权（本方案的硬前提）

壳渲染层改本地加载后，对 `http://127.0.0.1:4412/api/*` 的请求 Origin 不再是同源，
按现行 `isSameOrigin`（严格 host:port 比较）会被拒。放行不能靠放宽 CORS：
4412 无用户身份概念，任何本机页面都值得防。设计为**本地令牌通道**：

1. 网关启动时写 `~/.modelmux/shell.token`（0600，随机 32B，见 STORAGE-CONVENTION 落点规则）。
2. 壳主进程读 token，经 `session.webRequest.onBeforeSendHeaders` 注入
   `X-Modelmux-Shell: <token>` —— 渲染层与 preload 都不接触 token 值。
3. 网关对 `/api/*`：同源 → 现有防线不变；携带正确 token 且 `Origin: null|file://` 的请求 →
   按同源处理，并回 `Access-Control-Allow-Origin: null`（仅对该头组合）。
4. CLI `serve` 场景不产生 token 文件消费方，无行为变化。

浏览器恶意页面拿不到文件系统的 token，回环地址不能防的本机进程本来也已拿到凭据目录，
token 边界与凭据边界一致。

### 3.2 UI 构建：一份产物两个 base

vite 现为 `/web/` 前缀构建。改为同一次构建出相对路径资源（`base: "./"`），
`/api/*` 调用点集中到 `lib/api.ts` 后由运行时解析根地址：

- 浏览器托管态：`location.origin`（行为不变）；
- 壳态：主进程注入 `window.__MODELMUX_API__ = "http://127.0.0.1:4412"`（preload 白名单桥）。

`copy-ui.mjs` 第三落点 `desktop/app/ui/`，`pack-desktop` 打进 asar。
网关 `WEB_UI_ROOT` 解析逻辑不动（`packages/core/gateway/src/http/console/console.ts:44` 的 env 覆盖仍可用于排查）。

### 3.3 版本比对

壳 bundle 与网关不同源即可能不同版本。壳启动后比对 `/api/ping` 返回的 cliVersion 与
自身构建版本（三位一体规则下应当相等）：不等 → 数据区顶部常驻 warn 胶囊
「网关与界面版本不一致：请更新网关」，写操作类动作禁用。

## 4. 生命周期重划

| 场景 | 行为 |
| --- | --- |
| 启动壳：已有网关（mx/watchdog 起的） | adopt：窗口连接 + 托盘显示「接管自 CLI」；不 fork 第二实例 |
| 启动壳：无网关 | fork（现状路径），token 文件就绪后才拉渲染层数据 |
| 关窗 | 收托盘，网关继续服务（现状不变） |
| 托盘「停止网关」 | 显式动作 = `mx stop` 全链路：置 `watchdog.pause` → 杀监督者 → 状态同步；弹确认（文案含「外部客户端将断线」） |
| 托盘「退出」 | 现状语义不变：只退壳，不动网关 |
| 网关被外部杀掉 | 现状存活巡检保留（`desktop/main.cjs:147`）：壳出真实错误态；watchdog 每分钟 `--once` 拉回后自动回填（见 DAEMON-SUPERVISOR §7） |

`watchdog.pause` 的置位/清除语义（DAEMON-SUPERVISOR §7 表）新增一行：**托盘「停止网关」= 置**，与 `mx stop` 同权。计划任务与守护完全不变——headless 场景仍是网关的独立生存路径。

## 5. 桌面壳工程变更

- `desktop/main.cjs`：新增 protocol handler（`app://` 或 `file:` 直读 asar）、token 注入、
  起停动作实现（复用 `ELECTRON_RUN_AS_NODE` fork 路径，stop 走 CLI bundle 动词而非自造 IPC）。
- `desktop/preload.cjs`：白名单从「窗口控制 + 主题」扩到「网关状态 / 起停 / 版本」，
  通道全部字符串常量枚举，仍禁裸 `ipcRenderer`。
- 安全基线升级：`webSecurity` 保持开启；asar 完整性校验开启（electron fuse）；
  本地资源 CSP 收紧到 `'self'` + API 白 origin。签名与 MotW 策略见 DESKTOP-APP §4，
  **主体化后签名从建议升级为发布门禁项**（决策点 D4）。

## 6. CLI 与浏览器辅助化

- `mx start/stop/status/log` 全量保留（服务器 / headless 是一等部署形态，不是二等公民）。
- `mx web` 语义调整：检测到已安装壳时提示「桌面版可用（`modelmux://`）」，继续打印 `/web/` 地址不强制。
- 浏览器 `/web/`：保留全部功能；仅「网关起停」「token 相关」动作不暴露（它们本来就不在 `/api/*` 写面里）。

## 7. PR 拆分与顺序

每个 PR 独立可回滚，基线行为不变，直到 P2 才动壳的加载方式。

| PR | 内容 | 验收 |
| --- | --- | --- |
| P0 | 网关侧 shell token 通道（§3.1）+ `web-command-handler` 回归测试 | `npm test` 绿；浏览器 /web/ 全功能无回归；`curl` 无 token 跨 origin 请求被拒 |
| P1 | vite base 相对化 + api root 运行时解析 + copy-ui 第三落点 | 双模式构建产物在 `mx serve` 与 `file` 下静态可开；视觉校验（浏览器通道）6 项通过 |
| P2 | 壳加载 protocol handler + token 注入 + preload 扩展 + 版本比对（§3.3、§5） | 壳内三页视觉校验（壳通道）6 项通过；断网关 → 真实错误态 → 恢复自动回填；旧 loadURL 路径留开关回退 |
| P3 | 生命周期重划（§4）：adopt/托盘起停/pause 矩阵 + 托盘菜单改造 | 场景表逐行真机过；watchdog 与计划任务共存回归（杀网关 61s 拉回仍成立） |
| P4 | 发布链：pack-desktop 带 UI、CI windows 矩阵、签名 fuse（D4 通过后）、Release 流程验证 | 新机器零依赖安装 → 壳秒开 → 全链路冒烟 |
| P5 | 文档收敛：DESKTOP-APP 重写主体契约、WEB-CONSOLE 加壳态渲染一节、CONTRACT-TS 命令与发布构建更新、STORAGE-CONVENTION 登记 `shell.token`、PROGRESS 状态更新 | `npm test` 的 verify-docs 全绿 |

P0–P1 无行为变更可先行；P2 是体验分水岭；P3 前任何时刻可用回退开关退回 loadURL。

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| token 通道被本机其他进程读文件复用 | 与明文凭据同防线（文件 0600 + 回环），边界一致；不新造攻击面 |
| 双通道渲染差异（壳 Chromium vs 用户浏览器） | 同一构建产物；验收矩阵固定双通道 × 三页 × 明暗 |
| 壳与网关版本错位 | §3.3 比对 + 写动作禁用；发版流程保证三位一体（WORKFLOW） |
| Electron 供应链（下载源、体积） | 现状 `.npmrc` 镜像保留；包体积进发布检查（上限 200MB 的本地对照由 pack-desktop 报告） |
| adopt 语义下「谁杀谁」重新模糊化 | 管理动作全部走 CLI 动词同一实现，壳不自造停止路径；保留 DESKTOP-APP「只杀自己 fork 的」底线 |

## 9. 已排除的备选

- **网关进程内嵌壳**（ZCode desktop 原样照搬）：桌面壳崩/更新即全服务中断，watchdog 救不了壳进程；
  外部客户端依赖 4412 常驻，与主体形态无关。故障域不可接受。
- **纯 A 微调**（loadURL + 优化探活/fork 时序）：吃不到「渲染与网关解耦」的冷启动收益，主体化诉求无解。
- **UI 重写为壳专属**：双份界面 = 双份口径，违背仓库单一事实源约束。

## 10. 开放决策点

| # | 问题 | 方案默认 |
| --- | --- | --- |
| D1 | headless/CLI 部署形态保留强度 | 完全保留，一等公民 |
| D2 | 托盘是否获得「停止网关」权 | 获得（显式动作 + 确认 + 置 pause） |
| D3 | `modelmux://` 深链协议注册 | 注册（仅打开壳，不承载数据） |
| D4 | 代码签名证书（Authenticode） | P4 前必须定；无证书则本地加载形态维持 MotW 风险提示 |
| D5 | 浏览器 `/web/` 终态 | 全功能保留 |
| D6 | 壳内自动更新 | 沿用现状：检查 + 引导下载，不静默自更新 |
