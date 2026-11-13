---
name: todayai-reverse
description: Today 国内版（todayai.cn）的逆向方法与额度/重置链路。用户要挖 todayai 的端点、实现额度查询或耗尽自动重置、排查「额度打满被拒 / 重置不生效 / mx bill 不显示额度」，或要逆向另一个 Electron 客户端（asar 解包 + 压缩 bundle 里定位端点与 UI 触发逻辑）时使用。端点与字段的现行事实见 docs/channels/todayai/PROTOCOL.md。
---

# todayai 逆向与额度重置

目标：**从官方客户端反推**端点与触发逻辑，而不是猜。端点与字段的现行事实见
[docs/channels/todayai/PROTOCOL.md](../../../docs/channels/todayai/PROTOCOL.md)；
本技能只写**方法与判据**，不复制协议事实。

## 0. 为什么从客户端反推

todayai 没有开放文档，网页端是压缩过的 Next.js bundle。手边有官方桌面客户端
（TodayCN.exe）时，**它是最完整的事实源**：API client、UI 触发条件、错误码枚举全在里面，
比抓包省事，也不会被风控拦。

## 1. 解包与搜索（可复用）

### 1.1 找安装位置

| 项 | 落点 |
| --- | --- |
| 桌面壳 | `%LOCALAPPDATA%\Programs\Today CN\` |
| 当前版本 | `.today-active` 指针 → `versions\<uuid>\` |
| 主程序 bundle | `resources\app.asar`（Electron 主进程 + 页面） |
| Web 运行时 bundle | `resources\web-runtimes\prod.asar`（Next.js 前后端） |

**两个 asar 都要解**：端点字面量在主程序里，UI 触发逻辑在 web 运行时里。只解一个会漏一半。

### 1.2 解包

```sh
npx --yes @electron/asar extract <app.asar> <out-dir>
```

### 1.3 在压缩 bundle 里定位

bundle 是**单行压缩**的，`read` 的行号没有意义。用 node 按关键字切片看上下文：

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

搜不到时先自问：是不是搜错了 asar？端点是不是「常量基址 + 模板变量」拼出来的？

## 2. todayai 额度与重置：反推结果怎么确认的

协议事实在 PROTOCOL.md §6，这里只记**证据来自哪里**，便于复核与复用方法：

| 结论 | 怎么确认的 |
| --- | --- |
| 额度在 `GET /v1/pricing/status` 的 `data.status.usage` | 主程序 API client 的 `url: "/v1/pricing/status"` + 真实响应 |
| 重置是 `GET` / `POST /v1/pricing/resets` | 主程序 API client 的 `getV1PricingResets` / `postV1PricingResets` |
| POST body 是 `{resetId}` | web 运行时里 `body:{resetId:b}` 的调用点 |
| 触发条件是「有可用次数」+「剩余 < 100%」 | web 运行时的 `resetEnabled` 计算式（见下） |
| 无可用次数回 `409 pricing.reset_unavailable` | web 运行时的 mock 路由处理器 |

`resetEnabled` 的真实计算式（压缩后变量名，语义还原）：

```js
remaining = usage.remainingPercent ?? (usage.progress === undefined ? undefined : 100 - usage.progress);
nextReset  = resets.items.find(i => !consumed.includes(i.resetId));
resetEnabled = resets != null && resets.totalCount > 0 && nextReset !== undefined
            && remaining !== undefined && remaining < 100 && !resetsError && !failed && !pending;
```

注意 `remaining < 100` 是**只要没满就允许重置**，不是「只有耗尽才能重置」——
所以「耗尽自动重置」是我们自己的策略选择，不是上游的触发条件。

## 3. 探测方法：只读优先

挖端点时**先只读**：`GET` 拿结构，`OPTIONS` / `GET` 探写端点的存在性与参数需求，
**不要**在探测阶段调写接口——重置额度是消耗品，用一次少一次。

用渠道自己的 dist 模块在 `runInChannel` 上下文里打上游（否则 `cred.load()` 的路径解析会失败）：

```js
const { runInChannel } = await import("../packages/core/gateway/dist/runtime/channel-context.js");
await runInChannel("todayai", async () => {
  await import("../packages/core/channels/todayai/dist/channel.js");
  const cred = await import("../packages/core/channels/todayai/dist/cred.js");
  const upstream = await import("../packages/core/channels/todayai/dist/upstream.js");
  const c = cred.load();
  await upstream.refreshIfExpired(c);   // token 可能已过期，先续期
  console.log(await upstream.fetchUsage(c));   // 只读
});
```

## 4. 落到网关：耗尽自动重置

判据：**额度打满后上游直接拒**，所以重置必须**在发消息前**做，等拒绝再补这轮就失败了。

- `upstream.resetQuotaIfExhausted()` 在 `prepareChat` 里调：`progress >= 100` 才消耗一次重置；
- 未耗尽 / 无可用次数 / 读取失败**一律不消耗**（次数是稀缺资源）；
- 额度读取带 30 秒缓存，避免每个请求多打一次 `pricing/status`；
- `quotaSignal` 作兜底：主动重置失败后命中即按额度耗尽冷却账号，避免同一账号被反复打。

## 5. 排查清单

| 现象 | 先查 |
| --- | --- |
| `mx bill todayai` 显示 `unsupported` | `ChannelConfig.capabilities.billing` 是否为 true |
| 额度打到 100 但不重置 | `resetQuotaIfExhausted` 有没有被调；`fetchResets` 的 `totalCount` 是不是 0 |
| 重置调用失败 | 上游 `409 pricing.reset_unavailable`；或 `resetId` 已过期 |
| 请求落点不是 todayai | 网关按额度排序；`billing:false` 的渠道恒排最后（`priorityOf` 返回 null） |
| 客户端里搜不到端点 | 是不是搜错了 asar（主程序 vs web 运行时）；端点是不是拼出来的 |
| 探测脚本 `cred.load()` 路径解析失败 | 没包 `runInChannel(cid, ...)`，或没先 import 渠道 `channel.js` |

## 6. 可复用脚本

`.tmp/` 下的探测脚本（已忽略、保留复用）：

| 脚本 | 用途 |
| --- | --- |
| `probe-todayai-quota.mjs` | 只读探 `/v1/pricing/status` 与 `/v1/pricing/resets` |
| `lead-verify-todayai-quota.mjs` | 验证 `fetchUsage` / `fetchResets` / `fetchCredits` / `quotaSignal` |
| `lead-e2e-todayai-quota.mjs` | 端到端：钉偏好发请求，确认额度前置不破坏正常请求 |
