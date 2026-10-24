# Web 控制台（mx web）

`mx web` 把 React 管理看板挂在网关的**唯一端口**上（`http://127.0.0.1:4412/web/`，
控制台 API 在 `/web/api/*`），没有独立进程与独立端口。

## 设计系统（`packages/ui/src/index.css`）

视觉语言参照 **Codex / ChatGPT**：**纯近黑单色系**。侧栏比主区更深、浮层比主区更浅，
层级只靠底色差与留白表达；**accent 就是白**（主按钮白底黑字、选中态白色高亮），
不用任何彩色品牌色；状态语义色保留但饱和度压低，只出现在「需要人看」的地方。

UI 的配色、层级与圆角**只在 `index.css` 的 `@theme` 里定义一次**，组件一律用令牌类，
不直接写 `gray-900` / `sky-500` 这类原始色 —— 换主题只改这一处。

| 组 | 令牌类 | 用途 |
| --- | --- | --- |
| 表面（四个深度层） | `bg-surface` `#171717` / `bg-canvas` `#212121` / `bg-raised` `#2f2f2f` / `bg-overlay` `#3a3a3a` | 侧栏（最深）→ 主区 → 卡片与输入盒 → 悬浮层与选中底 |
| 描边 | `border-line` `#383838` / `border-line-strong` `#4d4d4d` | 几乎不用；需要分块时才出现，且刻意看不清 |
| 文字 | `text-ink` `#ececec` / `text-ink-soft` `#b4b4b4` / `text-ink-faint` `#8e8e8e` | 主 / 次 / 弱 |
| 语义 | `brand` **`#ffffff`** / `free` / `warn` / `danger` | **accent = 白**：主按钮是白底黑字（`text-[#171717]`），不是彩色底 |

三个组件类与一处动效：

| 类 | 用途 |
| --- | --- |
| `.panel` | 唯一的容器形态（`rounded-2xl border border-line bg-raised`），端点盒、渠道卡共用 |
| `.panel-title` | 面板标题（图标 + 文字，14px 常规字重 —— 不靠加粗靠留白） |
| `.pill` | 徽标（状态 / 计数）；中性底，不铺彩色底 |
| `.nav-item` | 侧栏导航项（纯文本 + 圆角 hover 底；选中态 `bg-raised`，不用彩色底） |
| `.live-dot` | 网关状态灯的呼吸动效（`prefers-reduced-motion` 下自动关闭） |

约定：

- 圆角只有两档：容器 `rounded-2xl`、行内元素 `rounded-lg`；主按钮 `rounded-full`。
- **单色系**：除状态语义色（免费/冷却/错误）外不出现任何彩色；
  主操作按钮一律 `bg-brand text-[#171717]`（白底黑字）。
- 标题是**无衬线常规字重**（ChatGPT 的标题不靠加粗靠留白），不用衬线字体。
- 数字用等宽数位（`.tabular`），统计值变化时不抖动。
- 键盘可达：`:focus-visible` 有统一聚焦环（鼠标点击不显示）。
- 图标统一用 `lucide-react`，尺寸三档：12（小徽标）/ 14（行内）/ 16（面板标题）。
- **品牌 mark 是内联组件**（`components/BrandMark.tsx`，极简鲸鱼剪影 +
  分叉尾鳍 = 多条渠道，单色、16px 清晰），与 `assets/favicon.svg` 同形（白色）；
  颜色跟随 `className` 的 `text-*` 令牌（侧栏用 `text-ink`）。

## 页面结构（双页近黑）

| 页面 | 内容 |
| --- | --- |
| 仪表盘 `/web/` | **composer 形态的接入盒**（base_url / chat_url / endpoints，逐行可复制）、一行内联统计（网关 / 模型 / 渠道 / 端点）、**模型区**（见下）。没有 hero 大标题 —— 常驻工作区不做空状态问候 |
| 账号池 `/web/accounts` | 添加账号（**登录引导弹窗**）、总览条（正常/冷却/异常/未登录计数）、渠道卡片**两列网格**（小写 cid + 账号列表：可读昵称/用户名 + 各账号剩余额度进度条 + 切换/删除） |

### 为什么仪表盘首屏是「接入盒」

参照 ChatGPT 的首屏：一块大的圆角输入盒占据视觉中心，周围留白。
这里最高频的动作是**把 base_url 抄走**，所以端点做成首屏主体、统计压成一行内联数据。

### 为什么账号卡最多两列

三列时单卡仅约 380px，中文账号名与额度条会互相挤压（实测「塞西莉亚4412」被截断）。
两列下每卡约 570px，名称行固定 22px 行高、UID 退到次行并留 6px 上间距 ——
中文名字形下缘低，仅靠 `leading` 会看成与 UID 叠字。

### 模型区（`components/ModelExplorer.tsx`）

**为什么不是「双列渠道卡」**：渠道卡按内容高度排进两列网格，网格行高取最高那张卡 ——
模型数差距大时，模型少的一侧被拉出**等高的空盒子**（实测 30 个 vs 9 个并排，页面直接失衡）。
现在改成**纵向的渠道区块**：每个渠道一个全宽表块，高度 ∝ 它的模型数，
**结构上不可能出现空洞**。

| 元素 | 形态 |
| --- | --- |
| 工具条 | 搜索（模型名或渠道名）/ 渠道筛选下拉 / 「只看免费」开关 / **视图切换**（分组 \| 扁平）/ 命中计数 |
| **分组表**（默认） | 每渠道一个 `<tbody>`：band 行（`● cid` + 模型数 + 免费数 + 可吃图数 + 倍率区间 + 折叠）+ 模型行；**默认每组只显示前 3 个**，其余折叠可展开 |
| **扁平表** | 全部模型按倍率升序排成一张表，渠道作为一列 —— 回答「最便宜的模型在哪」 |
| 模型行 | 模型名（等宽）\| 倍率（0 → 绿色「免费」徽标）\| **最大上下文** \| 输出上限 \| **思考模式**（档位列档位，无声明 → 「不支持」）\| 输入模态（可吃图 → 「文本+图」徽标）\| 复制按钮 |

- 表格是**真 `<table>`**：一个 `<thead>`（吸顶）+ 每渠道一个 `<tbody>`（band 用 `scope="rowgroup"`），
  列天然对齐、屏幕阅读器可读。
- 排序口径与徽标口径**必须一致**：倍率 0 与「订阅制无倍率概念」算免费；倍率**未知**排最后，
  不冒充免费。
- 「订阅制」由服务端的**能力位**判定：`/web/api/state` 的 `channel_caps[cid].billing` 为 `false`
  即没有额度/倍率概念（渠道在 `ChannelConfig.capabilities` 里声明）。
  ⚠ 前端**不得硬编码渠道名** —— 必须读服务端能力位，否则新增渠道会漏标；
  账号池页走的是同一个能力位（`unsupported`），两处口径一致。
- 数据来自 `/web/api/state` 的 `model_info`（共享层 `PoolModelMeta`）——
  上下文窗口、输出上限、输入模态、**思考档位**本来就有。
- **「最大上下文」不是「上下文」**：上下文档位表（qoder 的 `context_config`）取**最大档**，
  客户端永远走最大上下文，所以列名与取值口径一致（见 POOL-ARCHITECTURE §2.6）。
- **思考模式按渠道声明如实显示**：`effort` 为 `null`（渠道没声明）就写「不支持」，
  **不编档位** —— 旧版给所有模型都填了 `low/high`，把「不知道」显示成「支持」。
  档位名英文 → 中文映射（`low`→低、`medium`→中、`high`→高、`xhigh`→超高、`max`→最大、
  `none`/`off`→关闭），未知档名原样显示。
- 窄屏（< 1024px）隐藏「最大上下文 / 输出上限 / 思考模式」三列，避免挤压换行。

### 账号池页的排布

渠道卡用 **两列网格**（`lg:grid-cols-2` + `items-start`）：卡顶成行对齐，短卡不在单元格内被拉伸。
三列时单卡仅约 380px，中文账号名与额度条会互相挤压（实测「塞西莉亚4412」被截断）。

- 深色是**唯一主题**，不留浅色分支与切换入口。
- 授权链接 / 登录进度只在**登录弹窗**内渲染（遮罩与 ESC 不关），不出现在其他页面。
- 登录弹窗按渠道形态渲染步骤：扫码渠道渲染二维码；授权码渠道渲染「打开授权页」按钮 +
  回调链接粘贴框（raccoon 等已优先本地回调自动完成，粘贴框仅作手工兜底）。
- **登录成功后弹窗自动关闭**：页面轮询 `/web/api/state`，一旦 `ui_state` 变成 `done`，
  立刻关闭弹窗、刷新账号池 / 登录态 / 账本，并主动重查该渠道额度（新账号额度与旧账号不同）。
  判据要求先观察到 `login` / `error` 等中间态，避免上一次登录残留的 `done` 误关新弹窗。

## 账号展示与额度

- 渠道头**只显示小写 cid**（如 `catpaw`），不显示展示名与 `ok` 文字；状态只用小圆点。
- 账号主标识**有名称就显示名称**（`name`：渠道给的 nickname / 用户名 / 邮箱 / 手机号），
  没有名称才退回脱敏 id：手机号 `131****9411`、纯数字 `UID 452****126`、
  邮箱只脱敏 `@` 前的本地部分、key 哈希兜底。
  **名称是给人看的可读标识，直接展示**（`bluechonk`）；**id 一律脱敏**，
  页面上不出现完整 uid / key 哈希。有名称时，id 以小号副文本（`UID 452****126`）
  附在名称后，保证同渠道多个账号仍可区分。
- 额度**按账号**查询：后端用每个账号自己的凭证调用
  `billing.fetchCredits({ credential, refreshOn401: false })`，结果写进账本
  `accounts[key].credits`；卡片里额度条**独占一行**，只显示数值与百分比
  （**不显示「积分」「credits」这类单位**），数值带千分位、最多 2 位小数。
- 百分比以**当前额度窗口内第一次账单**为 100% 基线（实现见 `pool-usage.ts` 的 `pickBaseline`）：
  窗口键取渠道声明的 `quotaPeriod().resets_at`，没声明才回落本地日期；窗口滚动或同一窗口内
  `remain` 回升（奖励到账）时重设基线。**没有基线或 `remain` 不可用时不显示百分比** ——
  不回退上游 `remain_percent`（它是窗口占比，常年 100，会给出误导性的满格）。
  也不用上游 `size` 当分母（各渠道口径不一）。
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

> ⚠ **控制台没有公网版本**：它是**本机工具**，想看界面就 `mx web` ✓。

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
