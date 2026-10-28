# 日志正文抓取：10MB 上限与截断兜底设计方案

> 状态：**已实施**（2026-10-28）。上限与截断语义已收敛进 [LOGGING.md](./LOGGING.md) §9。
> 问题出处：1.1MB 请求 body 被 `clipPayload` 按 256KB 截前段，**最新对话全丢**；截断后 JSON 不完整，上下文弹窗退化成整段原文，消息分类全失效。

## 1. 现状与问题

### 1.1 现状（`log-store.ts` `clipPayload`）

```
clipPayload(body) = body.subarray(0, 256KB)  // 保「头」弃「尾」
DEFAULT_PAYLOAD_MAX_BYTES = 256 * 1024
```

- 单条上限 **256KB**，超限硬切前段（可能切在 UTF-8 中间）；`truncated: true` 如实标注；
- 落盘后**不保证是合法 JSON** —— 上下文弹窗解析失败时渲染原始文本。

### 1.2 实测证据（2026-10-28，ZCode 会话请求）

```
seq=29  phase=client   bytes=1,127,013   truncated=true   saved≈212,101
body_head = {"model":…,"messages":[{role:system,…你是一个…agent…
```

- 1.1MB 的请求只留了前 ~207KB；
- 保留的是 **system prompt + 最早几条消息** —— 恰恰是最不重要、人人都一样的部分；
- **用户真正想看的「最近几轮对话 / 报错的最后一条 tool 结果」全部在截断点之后，全丢了**。

### 1.3 问题本质

**上限设得太低**：256KB 对「agent 会话上下文」这种动辄几百 KB ~ 几 MB 的负载来说，
几乎必然触发截断；而一旦截断，整个事件退化为「不可用原文」，分类、查看全失效。

## 2. 设计目标

1. **完整优先**：把单条上线提到 **10MB**，让真实世界的请求（agent 上下文 / 带图 / 长工具输出）
   **几乎永不触发截断** → 落盘始终是完整合法 JSON，上下文弹窗永远可解析、可分类；
2. **超限兜底**：> 10MB 的极端请求仍要留痕 —— 双端保留 + 显式截断标记，不静默丢弃；
3. **零依赖**：只改常量与兜底分支，不新增解析器、不引入消息折叠逻辑。

## 3. 设计方案

### 3.1 上限：256KB → 10MB

```ts
/** 单条抓取上限：10MB —— agent 会话上下文（系统提示 + 多轮 + 工具结果）实测 1-8MB 级，
 *  256KB 老值几乎必然截断。超限走双端兜底（见 clipPayload）。 */
const DEFAULT_PAYLOAD_MAX_BYTES = 10 * 1024 * 1024;
```

- 保留环境变量覆盖与 `PayloadRecord.truncated` 语义；
- 磁盘影响：10MB/条 × 单请求 2 条（client + upstream × attempts）对本地磁盘可忽略；
  保留期 3 天不变。

### 3.2 兜底：超限时双端保留（替换原「保头弃尾」）

```ts
function clipPayload(body: Buffer | string) {
  const max = payloadMaxBytes();
  if (buf.length <= max) return { body: json, bytes, truncated: false };
  const head = max / 2, tail = max - head;
  const text  = buf.toString("utf8");
  return {
    body: text.slice(0, head) + `\n\n…(超 10MB 已截断: 共 ${bytes} 字节, 中间省略)…\n\n`   + text.slice(-tail),
    bytes,
    truncated: true,
  };
}
```

- 头尾各 ~5MB，**最新内容（在尾部）与开头（model / system 前缘）都可见**；
- 保留「切在 UTF-8 中间没关系」的既有取舍（抓包价值在看出形态，`truncated` 已如实标注）；
- **不做消息级解析折叠**：10MB 上限已覆盖 99% 真实场景，为 1% 极端情况引入消息解析
  的复杂度不值（原草案的「消息级折叠」整体作废）。

### 3.3 UI（`LogContextDialog.tsx`）

| 情形 | 呈现 |
|---|---|
| `truncated: true` | 弹窗顶部提示条：`该请求超 10MB，已保留首尾各 5MB（完整 JSON 已截断）` |
| 未截断 | 现状不变（全文可解析，消息分类完整） |

改动极小而明确：去掉原来对「256KB 静默截断」的将就，遇到真超限明示。

## 4. 实施清单

1. `log-store.ts`：`DEFAULT_PAYLOAD_MAX_BYTES` 256KB → 10MB；
2. `clipPayload`：超限分支改为双端保留头尾（含省略标记与字节数），保留 `truncated`；
3. `LogContextDialog.tsx`：`truncated` 时显示提示条（文案如上）；
4. 文档：更新 `docs/LOGGING.md` §9 的上限说明（256KB → 10MB、双端兜底）。

## 5. 验收标准

1. 构造 5MB 请求 → 落盘 JSON 完整、`truncated: false`、弹窗全文可分类；
2. 构造 11MB 请求 → 落盘带 head+tail、`truncated: true`、提示条可见；
3. 回归：256KB 内旧数据读取与弹窗无变化；
4. `npm test` 全绿 + `npm run gate`。

## 6. 为什么不用别的方式

- **「消息级折叠 + 保最近 10 条」原方案**（LOG-PAYLOAD-DESIGN 上一稿）：复杂度高
  （解析 JSON、按 role 分类、折叠占位、`clipped` 元信息、UI 联动），而 10MB 上限就
  覆盖了同样多的真实场景 —— 为舒适感引入一套状态机不划算；
- **完全不截断（上限无限）**：单请求 100MB 时 payload 目录膨胀失控、读取变慢，
  10MB 是「真实负载从未超过」与「恶意/异常负载可兜住」的平衡点（agent 会话常见
  几百 KB ~ 2MB；10MB 留 5-10 倍余量）。
- **索引侧不落 body、旁路文件按 id 存取**：P2 方向 —— 冷数据大多也没人点开，
  现阶段先解决「该存下的存下」，等真有全文检索需求再做。