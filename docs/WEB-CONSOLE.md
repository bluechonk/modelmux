# Web 控制台（mx web）

`mx web` 把 React 管理看板挂在网关的**唯一端口**上（`http://127.0.0.1:4412/web/`，
控制台 API 在 `/web/api/*`），不再有独立进程与独立端口。

## 页面结构（双页深色）

| 页面 | 内容 |
| --- | --- |
| 仪表盘 `/web/` | 网关状态 / 可用模型数 / 供给渠道数统计卡、端点卡、**按渠道分组的模型墙**（chip 点击复制完整 `<cid>/<模型>` 调用名） |
| 账号池 `/web/accounts` | 添加账号（**登录引导弹窗**）、渠道卡片（**小写 cid** + 账号列表：可读昵称/用户名 + 各账号剩余额度 + 切换/删除）、页头「刷新全部额度」 |

- 深色是**唯一主题**，不留浅色分支与切换入口。
- 授权链接 / 登录进度只在**登录弹窗**内渲染（遮罩与 ESC 不关），不出现在其他页面。
- 登录弹窗按渠道形态渲染步骤：扫码渠道渲染二维码；授权码渠道渲染「打开授权页」按钮 +
  回调链接粘贴框（raccoon 等已优先本地回调自动完成，粘贴框仅作手工兜底）。
- **登录成功后弹窗自动关闭**：页面轮询 `/web/api/state`，一旦 `ui_state` 变成 `done`，
  立刻关闭弹窗、刷新账号池 / 登录态 / 账本，并主动重查该渠道额度（新账号额度与旧账号不同）。
  判据要求先观察到 `login` / `error` 等中间态，避免上一次登录残留的 `done` 误关新弹窗。

## 账号展示与额度

- 渠道头**只显示小写 cid**（如 `catpaw`），不显示展示名与 `ok` 文字；状态只用小圆点。
- 账号主标识优先 `nickname` / `username` / `phone` / `uid`；手机号掩码，**绝不显示
  账号池 key 哈希**。凭证字段（token / refresh token / secret 等）一律不展示。
- 额度**按账号**查询：后端用每个账号自己的凭证调用
  `billing.fetchCredits({ credential, refreshOn401: false })`，结果写进账本
  `accounts[key].credits`；卡片每行右侧直接显示该账号的剩余额度与单位。
- 查询失败显示「额度查询失败」，不把未知显示成 0。

## 技术栈与构建

- React 19 + TypeScript + Vite（`base=/web/`）+ Tailwind CSS v4 + TanStack Query v5 +
  react-router v7 + lucide-react 图标。
- `npm run build` 顺序：`tsc -b` → `vite build packages/ui` → cli bundle →
  `scripts/copy-ui.mjs` 把产物拷到 `packages/core/gateway/dist/ui` 与 `packages/cli/dist/ui`
  （**少拷一份，全局 `mx web` 就报「UI 未构建」**）。

### 静态资源落点：必须走 `src/assets/`，不要放 `public/`

页面图标在 `packages/ui/src/assets/favicon.svg`，由 `index.html` 以 `/src/assets/favicon.svg`
引用。Vite 会把它打进 `assets/` 并加内容哈希（产物形如 `/web/assets/favicon-<hash>.svg`）。

**为什么不能放 `public/`**：console handler 只托管两个静态位置 —— 前缀根 `/web/`（返回
`index.html`）与 `/web/assets/*`；其余 GET 一律走 SPA 回退（`console.ts` 的
`serveStatic(res, WEB_UI_INDEX)`）。放 `public/` 的 `/web/favicon.svg` 会被回退成 HTML
而拿不到 SVG（**实测踩过**）。同理，图标不要声明成 `/web/favicon.svg` 这类前缀根路径。

在 `index.html` 里显式声明 `<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg">`
还有第二个作用：浏览器不再去要默认的 `/favicon.ico` —— 那个路径在网关根下不存在，
会以 `not_found` 写进 `access/<date>/failure.log`，属纯噪音。

## 数据通道

- `GET /web/api/state`：登录快照（ui_state / message / auth_url / qr_url / 端点）。
- `POST /web/api/commands`：动作分发（login / status / models / billing / accounts /
  activateAccount / removeAccount / syncPool / pasteCallback）。
  - `billing` 支持 `args.refresh: true`（真实重查各渠道账单）与 `cid` 过滤（单渠道刷新）。
  - `pasteCallback`：手工兜底通道，把用户粘回的回调链接喂给等待中的登录流程。
    raccoon 等授权码渠道现在优先走**本地 HTTP 回调自动完成**，不再需要粘贴。
- `/api/commands` 返回值由前端 `lib/api.ts` 统一**解包 `data`** —— 页面不要再取一层
  `.data`（双重解包曾导致 tab 崩溃，实测踩过）。

## 账本维度

账本主维度是**渠道**（used / 冷却 / billing_at），另按**生效账号**拆分 ok / fail 计数
（`ChannelLedger.accounts[key]`），控制台账号池卡片按「渠道 × 账号」展示；
账本数字记在请求发生时的当前生效账号头上。

## 演示模式（GitHub Pages 静态站）

`.github/workflows/pages.yml`（手动 `workflow_dispatch` 触发）把控制台的**演示构建**
发布到 GitHub Pages：`https://<owner>.github.io/modelmux/`。

### 为什么必须是「演示构建」

Pages 是纯静态托管，没有后端；而控制台每个页面都要 `fetch('/web/api/*')` 读本机网关。
指向本机网关这条路走不通，有三重**有意设计**的限制（不应为演示削弱）：

1. 网关不发 CORS 头 → 浏览器拦下跨源响应；
2. `console.ts` 的 `isSameOrigin` 拒绝跨源写命令（403「跨源请求已拒绝」）；
3. Chrome 的 Private Network Access 拦「公网页 → 127.0.0.1」。

### 实现

| 位置 | 作用 |
| --- | --- |
| `src/lib/demo.ts` | 虚构数据源 + 内存状态机（渠道/模型/账号池/账本 + 登录流程） |
| `src/lib/api.ts` | `IS_DEMO` 为真时用内存实现替换所有 fetch |
| `vite.config.ts` | `DEMO=1` 时 `base=/modelmux/` 并注入 `__DEMO_MODE__` |
| `src/App.tsx` | `basename` 跟随同一个标志（`/modelmux` 或 `/web`） |
| `src/env.d.ts` | `__DEMO_MODE__` 的类型声明 |

构建：`DEMO=1 npm run build --workspace=packages/ui`。

演示的是**交互流程**而非假死截图：添加账号真的会把渠道置为已登录、账号入池并设为生效，
模型墙与统计卡随之更新（登录/登出一个渠道会同时改变模型数与渠道数）。

### 数据纪律

页面是**公开**的，所以 `demo.ts` 里所有 uid / 手机号 / 域名一律用明显虚构的占位值
（`demo000000000000a1`、`138****0001`、`example.com`），**不读取也不复制
`~/.modelmux/` 下的任何真实数据**。侧栏常驻「演示模式：数据均为虚构，未连接任何真实网关」提示。

### SPA 深链接

演示站是客户端路由（`/modelmux/` 与 `/modelmux/accounts`）。Pages 直接访问深链接会找
同名文件而 404 —— 工作流因此额外生成 `404.html`（内容同 `index.html`）交给 React Router。

### 本地先跑（推送前必须）

`pages.yml` 的失败模式（base 前缀不对 → 整页空白；缺 `404.html` → 深链接 404）只有看到
真实产物才暴露，推到云上再改成本高。所以本地先复现：

```bash
npm run verify:pages            # 完整复现：clone → npm ci → DEMO 构建 → 校验
bash scripts/verify-pages.sh --serve   # 额外起静态服务，浏览器打开核对
```

用 **WSL 而不是 Docker**：本机有 WSL（Ubuntu）、没有 docker CLI，且 `pre-push` 门禁本就是
「clone 到 WSL ext4 跑真 Linux 命令」的形态，沿用同一套不引入新依赖。

两个文件的职责分工：

| 文件 | 作用 |
| --- | --- |
| `scripts/verify-pages-artifact.mjs` | **纯校验**产物：必需文件、资源前缀、资源存在性、演示数据是否打入、与 workflow 的漂移 |
| `scripts/verify-pages.sh` | **编排**：在 WSL 里复现 workflow 的 build 阶段，然后调上面的校验器 |

校验器用 Node 而非 bash 写 —— bash 版的中文输出经 Git Bash ↔ WSL 管道会被判成二进制，
实测看不全结果。

`.githooks/pre-push` 已接入：动了 `packages/ui/` 或 pages 相关文件时，复用门禁里已
clone + `npm ci` 的目录补跑一次 DEMO 构建与校验，不重复装依赖。`verify:pages` **不进
`npm test`** —— 它含 `npm ci` + 全量构建，比现有校验器重得多，且只在 Pages 相关改动时才有意义。
