# Web 控制台（mx web）

`mx web` 把 React 管理看板挂在网关的**唯一端口**上（`http://127.0.0.1:4412/web/`，
控制台 API 在 `/web/api/*`），不再有独立进程与独立端口。

## 页面结构（双页深色）

| 页面 | 内容 |
| --- | --- |
| 仪表盘 `/web/` | 网关状态 / 可用模型数 / 供给渠道数统计卡、端点卡、**按渠道分组的模型墙**（chip 点击复制完整 `<cid>/<模型>` 调用名） |
| 账号池 `/web/accounts` | 添加账号（**登录引导弹窗**）、渠道卡片（登录状态徽标 + 账号列表 + 按账号拆分的账本 + 单渠道刷新）、页头「刷新全部账单」 |

- 深色是**唯一主题**，不留浅色分支与切换入口。
- 授权链接 / 登录进度只在**登录弹窗**内渲染（弹窗仅右上角关闭键可关，遮罩与 ESC 不关），
  不出现在其他页面。
- 登录弹窗按渠道形态渲染步骤：扫码渠道渲染二维码；授权码渠道渲染「打开授权页」按钮 +
  回调链接粘贴框（不显示裸 URL）。

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
  - `pasteCallback`：把用户粘回的回调链接喂给等待中的登录流程（raccoon 等授权码渠道）。
- `/api/commands` 返回值由前端 `lib/api.ts` 统一**解包 `data`** —— 页面不要再取一层
  `.data`（双重解包曾导致 tab 崩溃，实测踩过）。

## 账本维度

账本主维度是**渠道**（used / 冷却 / billing_at），另按**生效账号**拆分 ok / fail 计数
（`ChannelLedger.accounts[key]`），控制台账号池卡片按「渠道 × 账号」展示；
账本数字记在请求发生时的当前生效账号头上。
