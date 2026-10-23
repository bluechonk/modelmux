# Web 控制台（mx web）

`mx web` 把 React 管理看板挂在网关的**唯一端口**上（`http://127.0.0.1:4412/web/`，
控制台 API 在 `/web/api/*`），没有独立进程与独立端口。

## 设计系统（`packages/ui/src/index.css`）

UI 的配色、层级与圆角**只在 `index.css` 的 `@theme` 里定义一次**，组件一律用令牌类，
不直接写 `gray-900` / `sky-500` 这类原始色 —— 换主题只改这一处。

| 组 | 令牌类 | 用途 |
| --- | --- | --- |
| 表面（四个深度层） | `bg-canvas` / `bg-surface` / `bg-raised` / `bg-overlay` | 页面底 → 侧栏 → 卡片 → 悬浮层与徽标底 |
| 描边 | `border-line` / `border-line-strong` | 常规 / hover 与强调 |
| 文字 | `text-ink` / `text-ink-soft` / `text-ink-faint` | 主 / 次 / 弱 |
| 语义 | `text-brand` `bg-brand/12` / `text-free` `bg-free/12` / `text-warn` `bg-warn/12` / `text-danger` `bg-danger/12` | 品牌蓝 / 免费与正常 / 注意 / 错误 |

另有两个组件类与一处动效：

| 类 | 用途 |
| --- | --- |
| `.panel` | 唯一的容器形态（`rounded-2xl border border-line bg-raised`），面板、统计块、渠道块共用 |
| `.panel-title` | 面板标题（图标 + 文字，14px 半粗） |
| `.pill` | 徽标（渠道 id / 状态 / 计数） |
| `.live-dot` | 网关状态灯的呼吸动效（`prefers-reduced-motion` 下自动关闭） |

约定：

- 圆角只有两档：容器 `rounded-2xl`、行内元素 `rounded-lg`；徽标 `rounded-md`。
- 页面结构固定为「页头（`PageHeader`：标题 + 说明 + 右侧操作）→ 统计块 → 面板 → 列表」。
- 语义色的用法固定：**绿=正常/免费**、**蓝=品牌与主操作**、**黄=注意（连续失败、临期）**、
  **红=不可用（账号失效、额度耗尽）**、**灰=未加载或未登录**。
- 数字用等宽数位（`.tabular`），统计值变化时不抖动。
- 键盘可达：`:focus-visible` 有统一聚焦环（鼠标点击不显示）。
- 图标统一用 `lucide-react`，尺寸三档：12（小徽标）/ 14（行内）/ 16（面板标题）；
  同一语义不换图标（侧栏品牌用 `Layers`，面板里的「层级」也用 `Layers`）。

## 页面结构（双页深色）

| 页面 | 内容 |
| --- | --- |
| 仪表盘 `/web/` | 页头 + 四块统计（网关状态 / 可用模型 / 供给渠道 / 接入端点）、**接入端点面板**（base_url / chat_url / endpoints）、**模型区**（见下） |
| 账号池 `/web/accounts` | 添加账号（**登录引导弹窗**）、渠道卡片（**小写 cid** + 账号列表：可读昵称/用户名 + 各账号剩余额度进度条 + 切换/删除） |

### 模型区（`components/ModelExplorer.tsx`）

**为什么不是「双列渠道卡」**：渠道卡按内容高度排进两列网格，网格行高取最高那张卡 ——
模型数差距大时，模型少的一侧被拉出**等高的空盒子**（实测 30 个 vs 9 个并排，页面直接失衡）。
现在改成**纵向的渠道区块**：每个渠道一个全宽表块，高度 ∝ 它的模型数，
**结构上不可能出现空洞**。

| 元素 | 形态 |
| --- | --- |
| 工具条 | 搜索（模型名或渠道名）/ 渠道筛选下拉 / 「只看免费」开关 / **视图切换**（分组 \| 扁平）/ 命中计数 |
| **分组表**（默认） | 每渠道一个 `<tbody>`：band 行（`● cid` + 模型数 + 免费数 + 可吃图数 + 倍率区间 + 折叠）+ 模型行 |
| **扁平表** | 全部模型按倍率升序排成一张表，渠道作为一列 —— 回答「最便宜的模型在哪」 |
| 模型行 | 模型名（等宽）\| 倍率（0 → 绿色「免费」徽标）\| 上下文 \| 输出上限 \| 输入模态（可吃图 → 「文本+图」徽标）\| 复制按钮 |

- 表格是**真 `<table>`**：一个 `<thead>`（吸顶）+ 每渠道一个 `<tbody>`（band 用 `scope="rowgroup"`），
  列天然对齐、屏幕阅读器可读。
- 排序口径与徽标口径**必须一致**：倍率 0 与「订阅制无倍率概念」算免费；倍率**未知**排最后，
  不冒充免费（旧版两个分支都返回 0，会把未知倍率的模型排到免费档前面却不带徽标）。
- 「订阅制」由服务端的**能力位**判定：`/web/api/state` 的 `channel_caps[cid].billing` 为 `false`
  即没有额度/倍率概念（渠道在 `ChannelConfig.capabilities` 里声明）。
  ⚠ 前端**不得硬编码渠道名** —— 早前模型区写死了一个渠道名列表，再接一个订阅制渠道就会漏标；
  账号池页走的是同一个能力位（`unsupported`），两处口径现已统一。
- 数据来自 `/web/api/state` 的 `model_info`（共享层 `PoolModelMeta`）——
  上下文窗口、输出上限、输入模态**本来就有**，旧版只画 chip 把信息丢了。
- 窄屏（< 1024px）隐藏「上下文 / 输出上限」两列，避免挤压换行。

### 账号池页的排布

渠道卡用 **CSS 多栏（masonry）**（`columns-1 sm:columns-2 lg:columns-3` + `break-inside-avoid`），
不用网格：网格行高同样取最高那张卡，账号数少的渠道（1 个 vs 3 个）会被拉出整片空白。
卡片本身自包含，列序阅读可接受。

- 深色是**唯一主题**，不留浅色分支与切换入口。
- 授权链接 / 登录进度只在**登录弹窗**内渲染（遮罩与 ESC 不关），不出现在其他页面。
- 登录弹窗按渠道形态渲染步骤：扫码渠道渲染二维码；授权码渠道渲染「打开授权页」按钮 +
  回调链接粘贴框（raccoon 等已优先本地回调自动完成，粘贴框仅作手工兜底）。
- **登录成功后弹窗自动关闭**：页面轮询 `/web/api/state`，一旦 `ui_state` 变成 `done`，
  立刻关闭弹窗、刷新账号池 / 登录态 / 账本，并主动重查该渠道额度（新账号额度与旧账号不同）。
  判据要求先观察到 `login` / `error` 等中间态，避免上一次登录残留的 `done` 误关新弹窗。

## 账号展示与额度

- 渠道头**只显示小写 cid**（如 `catpaw`），不显示展示名与 `ok` 文字；状态只用小圆点。
- 账号主标识优先 `nickname` / `username` / `phone` / `uid`，且**一律脱敏**：
  中间用 `****` 代替（手机号 `131****9411`、纯数字 `UID 452****126`、昵称 `blu****onk`，
  邮箱只脱敏 `@` 前的本地部分）。**页面上不出现完整账号 id / 昵称 / key 哈希**。
- 额度**按账号**查询：后端用每个账号自己的凭证调用
  `billing.fetchCredits({ credential, refreshOn401: false })`，结果写进账本
  `accounts[key].credits`；卡片里额度条**独占一行**，只显示数值与百分比
  （**不显示「积分」「credits」这类单位**），数值带千分位、最多 2 位小数。
- 查询失败显示「额度查询失败」，不把未知显示成 0。

### 交互铁律：**不要 hover 悬浮气泡**

**禁止**任何「鼠标悬停才出现」的浮层 / 气泡 / 提示：

- 不用原生 `title=` 属性（浏览器会弹原生 tooltip），也不用自建的 hover popover；
- 信息要么**直接可见**（写进卡片正文，允许换行、不裁切），要么放进**点击后**才出现的
  详情区（弹窗 / 抽屉 / 展开行）；
- 按钮的无障碍名称用 `aria-label`（**不产生**任何可见气泡），不要用 `title` 兼职；
- 原因：截图、投屏、触屏与键盘操作都拿不到 hover 内容，悬停提示等于让信息只对
  「正在用鼠标悬停的人」可见 —— 关键信息不能依赖它。

### 登录链接：**复制，不弹新窗口**

「添加账号」弹窗里的授权链接，点击只做**复制到剪贴板**（剪贴板不可用时静默失败，
用户仍可手动复制下方那一行），**不调 `window.open`、不用 `target="_blank"`** ——
由用户自己决定在哪个浏览器 / 窗口打开。页面里不应出现「点授权链接 → 自动开新标签页」。

### 不可逆操作：**二次确认**

删除账号（`onRemove`）不可逆（**生效账号会同时登出**），必须先确认：点垃圾桶只把该账号
切到「确认中」，行内出现「删除生效账号将同时登出，确认？」+ `确认删除` / `取消`，
只有再点 `确认删除` 才真调 `onRemove`。规则：

- 同一时刻只允许一个账号处于确认态；
- 切换账号、开始删除（`busyKey !== null`）时清空确认态；
- 「取消」不产生任何副作用。

## 技术栈与构建

- React 19 + TypeScript + Vite 8（`base=/web/`）+ Tailwind CSS v4 + TanStack Query v5 +
  react-router v8 + lucide-react 图标。
- `npm run build` 顺序：`tsc -b` → `vite build packages/ui` → cli bundle →
  `scripts/copy-ui.mjs` 把产物拷到 `packages/core/gateway/dist/ui` 与 `packages/cli/dist/ui`
  （**少拷一份，全局 `mx web` 就报「UI 未构建」**）。

### 静态资源落点：必须走 `src/assets/`，不要放 `public/`

页面图标在 `packages/ui/src/assets/favicon.svg`，由 `index.html` 以 `/src/assets/favicon.svg`
引用。Vite 会把它打进 `assets/` 并加内容哈希（产物形如 `/web/assets/favicon-<hash>.svg`）。

**为什么不能放 `public/`**：console handler 只托管两个静态位置 —— 前缀根 `/web/`（返回
`index.html`）与 `/web/assets/*`；其余 GET 一律走 SPA 回退（`console.ts` 的
`serveStatic(res, WEB_UI_INDEX)`）。放 `public/` 的 `/web/favicon.svg` 会被回退成 HTML
而拿不到 SVG。同理，图标不要声明成 `/web/favicon.svg` 这类前缀根路径。

在 `index.html` 里显式声明 `<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg">`
还有第二个作用：浏览器不再去要默认的 `/favicon.ico` —— 那个路径在网关根下不存在，
会以 `not_found` 写进 `access/<date>/failure.log`，属纯噪音。

## 数据通道

- `GET /web/api/state`：登录快照（ui_state / message / auth_url / qr_url / 端点），
  外加模型池视图所需的 `models` / `model_info` / `channel_caps`（各渠道能力位）。
- `POST /web/api/commands`：动作分发（login / status / **models** / billing / accounts /
  activateAccount / removeAccount / syncPool / pasteCallback）。
  - `billing` 支持 `args.refresh: true`（真实重查各渠道账单）与 `cid` 过滤（单渠道刷新）。
  - `pasteCallback`：手工兜底通道，把用户粘回的回调链接喂给等待中的登录流程。
    raccoon 等授权码渠道现在优先走**本地 HTTP 回调自动完成**，不再需要粘贴。
- `POST /web/api/theme`：切主题；`POST /web/api/retry-login`：重试登录。
  两者在 `console.ts` 里已实现，但当前 UI **没有入口**（深色是唯一主题，也没有重试登录按钮）——
  前端 `lib/api.ts` 里的 `setTheme` / `retryLogin` 只是保留的调用面。
- `/api/commands` 返回值由前端 `lib/api.ts` 统一**解包 `data`** —— 页面不要再取一层
  `.data`（双重解包会导致 tab 崩溃）。

## 账本维度

账本主维度是**渠道**（used / 冷却 / billing_at），另按**生效账号**拆分 ok / fail 计数
（`ChannelLedger.accounts[key]`），控制台账号池卡片按「渠道 × 账号」展示；
账本数字记在请求发生时的当前生效账号头上。

## 演示模式（本地静态构建）

控制台的**演示构建**（`DEMO=1`）用一份**虚构数据**在浏览器里跑完整交互流程，
不需要起网关、不碰任何真实账号。

> ⚠ **不再发布到 GitHub Pages**：本仓库已移除 Pages 部署（`pages.yml` 与相关产物校验
> 一并删掉 ✓）。控制台是**本机工具**，没有公网版本 —— 想看界面就 `mx web` ✓。

### 为什么需要「演示构建」

真实控制台每个页面都要 `fetch('/web/api/*')` 读本机网关；演示构建把这层换成内存实现，
于是**任何静态托管**（甚至直接双击 `dist/index.html`）都能看界面与点流程 ✓。

### 实现

| 位置 | 作用 |
| --- | --- |
| `src/lib/demo.ts` | 虚构数据源 + 内存状态机（渠道/模型/账号池/账本 + 登录流程） |
| `src/lib/api.ts` | `IS_DEMO` 为真时用内存实现替换所有 fetch |
| `vite.config.ts` | `DEMO=1` 时切换 base 并注入 `__DEMO_MODE__` |
| `src/App.tsx` | `basename` 跟随同一个标志 |
| `src/env.d.ts` | `__DEMO_MODE__` 的类型声明 |

构建：`DEMO=1 npm run build --workspace=packages/ui`，
产物在 `packages/ui/dist/`（`base=/` ✓，直接用静态服务器打开即可 ✓）。

演示的是**交互流程**而非假死截图：添加账号真的会把渠道置为已登录、账号入池并设为生效，
模型区与统计卡随之更新（登录/登出一个渠道会同时改变模型数与渠道数）。

### 数据纪律

演示数据里所有 uid / 手机号 / 域名一律用明显虚构的占位值
（`demo000000000000a1`、`138****0001`、`example.com`），
**不读取也不复制 `~/.modelmux/` 下的任何真实数据** ✓。
侧栏常驻「演示模式：数据均为虚构，未连接任何真实网关」提示 ✓。

### 本地预览

演示构建的失败模式（base 前缀不对 → 整页空白）只有看到真实产物才暴露，
所以改完 UI 先本地构建看一眼：

```bash
DEMO=1 npm run build --workspace=packages/ui   # 产物在 packages/ui/dist/
npx serve packages/ui/dist                      # 或任何静态服务器，打开首页即可
```

真实控制台不需要这些：`mx web` 直接起在 `http://127.0.0.1:4412/web/` ✓。
