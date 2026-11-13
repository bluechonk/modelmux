# Today 逆向结论汇总

> 对象：Today 国内版（`todayai.cn`）与其官方桌面客户端 TodayCN.exe。
> 本文记录**结论怎么来的**（证据来源与复核方式）；协议事实见 [PROTOCOL.md](./PROTOCOL.md)。

## 1. 逆向方法

### 1.1 为什么从客户端反推

todayai 没有开放文档，网页端是压缩过的 Next.js bundle。官方桌面客户端（TodayCN.exe）
是最完整的事实源：API client、UI 触发条件、错误码枚举全在里面，比抓包省事，也不会被风控拦。

### 1.2 解包与搜索

| 项 | 落点 |
| --- | --- |
| 桌面壳 | `%LOCALAPPDATA%\Programs\Today CN\` |
| 当前版本 | `.today-active` 指针 → `versions\<uuid>\` |
| 主程序 bundle | `resources\app.asar`（Electron 主进程 + 页面） |
| Web 运行时 bundle | `resources\web-runtimes\prod.asar`（Next.js 前后端） |

**两个 asar 都要解**：端点字面量在主程序里，UI 触发逻辑在 web 运行时里。

```sh
npx --yes @electron/asar extract <app.asar> <out-dir>
```

bundle 是单行压缩的，`read` 的行号没有意义。用 node 按关键字切片看上下文：

```js
import { readFileSync } from "node:fs";
const s = readFileSync(process.argv[1], "utf8");
let i = s.indexOf("pricing/resets");
while (i >= 0) {
  console.log(s.slice(Math.max(0, i - 900), i + 900));
  i = s.indexOf("pricing/resets", i + 1);
}
```

判据：**先找 API client 的函数定义**（形如 `url: "/v1/..."` 配 `.get()` / `.post()`），
它给端点字面量与 HTTP 方法；**再找调用点**（形如 `body:{resetId:...}`），它给请求体形状与
触发条件。两步都做，缺一个就只能靠猜。

## 2. 额度与重置：结论的证据来源

协议事实在 [PROTOCOL.md](./PROTOCOL.md) §6，这里只记**证据来自哪里**：

| 结论 | 怎么确认的 |
| --- | --- |
| 额度在 `GET /v1/pricing/status` 的 `data.status.usage` | 主程序 API client 的 `url: "/v1/pricing/status"` + 真实响应 |
| 重置是 `GET` / `POST /v1/pricing/resets` | 主程序 API client 的 `getV1PricingResets` / `postV1PricingResets` |
| POST body 是 `{resetId}` | web 运行时里 `body:{resetId:b}` 的调用点 |
| 触发条件是「有可用次数」+「剩余 < 100%」 | web 运行时的 `resetEnabled` 计算式 |
| 无可用次数回 `409 pricing.reset_unavailable` | web 运行时的 mock 路由处理器 |

`resetEnabled` 的真实计算式（压缩后变量名，语义还原）：

```js
remaining = usage.remainingPercent ?? (usage.progress === undefined ? undefined : 100 - usage.progress);
nextReset  = resets.items.find(i => !consumed.includes(i.resetId));
resetEnabled = resets != null && resets.totalCount > 0 && nextReset !== undefined
            && remaining !== undefined && remaining < 100 && !resetsError && !failed && !pending;
```

`remaining < 100` 是**只要没满就允许重置**，不是「只有耗尽才能重置」——
「耗尽自动重置」是渠道的实现选择，不是上游的触发条件。

## 3. 探测方法：只读优先

挖端点时**先只读**：`GET` 拿结构，`OPTIONS` / `GET` 探写端点的存在性与参数需求，
**不要**在探测阶段调写接口 —— 重置额度是消耗品，用一次少一次。

用渠道自己的 dist 模块在 `runInChannel` 上下文里打上游（否则 `cred.load()` 的路径解析会失败）：

```js
const { runInChannel } = await import("../packages/core/gateway/dist/runtime/channel-context.js");
await runInChannel("todayai", async () => {
  await import("../packages/core/channels/todayai/dist/channel.js");
  const cred = await import("../packages/core/channels/todayai/dist/cred.js");
  const upstream = await import("../packages/core/channels/todayai/dist/upstream.js");
  const c = cred.load();
  await upstream.refreshIfExpired(c);   // token 可能已过期，先续期
  console.log(await upstream.fetchUsage(c));
});
```

## 4. 可复用脚本

`.tmp/` 下的探测脚本（已忽略、保留复用）：

| 脚本 | 用途 |
| --- | --- |
| `probe-todayai-quota.mjs` | 只读探 `/v1/pricing/status` 与 `/v1/pricing/resets` |
| `lead-verify-todayai-quota.mjs` | 验证 `fetchUsage` / `fetchResets` / `fetchCredits` / `quotaSignal` |
| `lead-e2e-todayai-quota.mjs` | 端到端：钉偏好发请求，确认额度前置不破坏正常请求 |
