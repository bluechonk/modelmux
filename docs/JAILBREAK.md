# `/jailbreak` 上下文裁剪

客户端在**用户消息**里写下标记 `/jailbreak` 时，网关在转发前把请求**整包裁剪**。
本文是这个行为的口径。

## 1. 规则

1. 只在 **user** 消息里找标记（assistant / system 里出现不算）。
2. 匹配是**精确小写** `/jailbreak`（`/Jailbreak` 之类的变体不触发，避免误伤正文里的同形词）。
3. 出现多次时，**最后一次生效** —— 后面还有标记，就以最后那个为准。
4. 丢弃标记**之前**的一切：`system` / `assistant` / `user` 一视同仁，全丢。
5. 只保留标记**后面**的内容 —— 同一条消息里标记之前的文本也剥掉，标签本身也不发给上游。
6. 标记之后的消息（含后续的 assistant / user 轮次）**原样保留**。
7. **整包裁剪**：`tools` / `tool_choice` / `functions` / `function_call` / `parallel_tool_calls`
   这些「前置能力声明」一并删除 —— 它们描述的是被丢弃的那段会话能用的工具，留着会让上游
   按旧会话的工具面回答（本功能为提示词注入 / 破甲服务）。采样参数（`temperature` /
   `max_tokens` 等）不属于「前面的信息」，保留。

一条请求最多裁剪一次，裁剪在**池路由之前**完成：后续所有环节（渠道翻译器、`buildChatBody`、
上游）拿到的都是裁剪后的整包。

## 2. 例子

```
输入:  [system 你是助手] [user 第一问] [assistant 第一答] [user "/jailbreak 只答这句"] [assistant ...]
输出:  [user "只答这句"]  ← 前面三条连同标记一起丢弃
```

多个标记：

```
输入:  [system ...] [user "/jailbreak 甲"] [assistant 中间] [user "/jailbreak 乙"]
输出:  [user "乙"]      ← 最后一次生效，连更早的标记本身也丢
```

带工具声明：

```
输入:  { messages: [...上面那样...], tools: [...], tool_choice: "auto", temperature: 0.7 }
输出:  { messages: [user "只答这句"], temperature: 0.7 }
        ← tools / tool_choice 随旧上下文一起删除；temperature 保留
```

## 3. 开关

`MODELMUX_JAILBREAK=0` 整体关闭（其余值或未设 = 启用）。

## 4. 为什么放在网关

这是「请求上下文怎么组装」的事，属转发层职责。放进各渠道翻译器意味着每个渠道实现一遍，
且渠道层拿到的已经是裁剪后的 body —— 让它去猜「这条请求原来有几轮」是反的。

## 5. 边界与风险

- **这不是越权面**：网关默认只监听 `127.0.0.1`、服务本机自己调用；能写 `/jailbreak` 的
  就是能直接改请求体的同一个主体。若把网关暴露给不受信来源，应设 `MODELMUX_JAILBREAK=0`。
- **只改发给上游的内容，不改本地留痕**：正文抓取（`payload/`）与访问日志记录的仍是
  **客户端原始请求**，所以「上游看到的上下文比原始请求短」这件事可以被事后核对出来。
- 被裁剪过的请求在 access 日志里带 `jailbreak: true`（见 [LOGGING.md](./LOGGING.md) §3.1），
  便于排查「为什么这次回答没有上下文」。
- 标记后面为空（例如正文就是裸的 `/jailbreak`）时，该条消息的正文变为空串 ——
  「只保留标记后面的内容」在空的情况下就是没有内容。上游可能因此报 `invalid_request`，
  这是客户端写法问题，网关不做兜底替换。
- **渠道自注入的 system 不受本裁剪影响**：部分渠道（lobsterai / workbuddyai 等）会在
  `buildChatBody` 时注入自己的固定 system 预设 —— 那是渠道协议的一部分，发生在裁剪之后，
  与被丢弃的对话历史无关。

## 6. 实现与验证

- 实现：`packages/core/gateway/src/http/chat/jailbreak.ts`（纯函数）；
  接入点 `http/chat/relay.ts` 的 A2 段（解析校验之后、池路由之前）。
- 测试：`packages/core/gateway/tests/jailbreak.test.ts`（11 个用例：最后一次生效、只认 user、
  大小写、多模态数组 content、**整包裁剪 tools 等**、开关关闭、剥空等边界）与
  `tests/jailbreak-e2e.test.ts`（全链路：relay → buildChatBody → 假上游收到的 body，
  断言 tools 也被裁掉、access 留痕）。

