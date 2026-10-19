# Qoder 国内版（`qodercn`）协议规格

国内版与 `qoder` **同一套协议**（仅域名 / 身份 / 模型目录不同），规格见
[qoder 的 PROTOCOL](../qoder/PROTOCOL.md) —— 端点、认证、签名、请求/响应形状、
额度与签到一律以该文件为准。本文件只记国内版**独有**的内容。

## 使用与实测

### 与国际版的差异

- **两个独立渠道**：国内版站点 `qoder.com.cn`（国际版 `qoder.com`）；账号在哪个域就用
  哪个渠道登录，**不能互相代登**（会串区），也不共用凭据文件。
- 域名 / 身份 / 模型目录的逐项差异见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §1.1
  （产品配置表）；国内版模型目录见同文件 §5.2（中国版 14 条，`q37fmodel`、
  `gm51model` 为国内版独有，`mmodel` 的版本与国际版 M3 不同）。
- 登录授权页国内版**额外带 `redirect_uri`**（见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md)
  §1.2 / §2.1）。

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login qodercn
mx status qodercn
mx model qodercn --refresh
```

### 端到端测试覆盖

登录入池 / `mx model qodercn --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；与 `qoder` **共用同一批 clone**，
协议结论与 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) 共用。

| 仓库 | 用途 |
| --- | --- |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 主参照（191★）：**国际国内双区**多账号网关中枢 —— COSY 签名、设备指纹防风控、OAuth 设备授权，国内版（qoder.com.cn）行为包含其中 |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | OpenAI / Claude / Codex 三格式兼容，含每日签到领 credit（72★） |
| [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) | Go 实现的对照样本（60★） |
