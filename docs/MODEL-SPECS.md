# 模型窗口规格（上下文 / 最大输出）

`GET /v1/models` 的 `context_window` 与 `max_output_tokens` 从哪来、怎么核实的、
哪些型号**没有**公开规格 —— 唯一事实源。

## 1. 两个数字的口径

| 字段 | 含义 | 缺省时客户端会怎样 |
| --- | --- | --- |
| `context_window` | 模型能吃进去的**总** token（输入 + 输出） | 客户端按默认猜（常见 128k / 256k），长会话被**自己**截断 |
| `max_output_tokens` | 单次回复的**最大**输出 token | 客户端按默认猜（常见 4096），每次回答被截到 4k |

⚠️ **4096 是兜底值，不是任何模型的真实上限** —— 早期 `/v1/models` 对全池返回 4096，
正是因为上游目录普遍**不下发**这两个数（见 §4）。

⚠️ 公开规格是**模型上限**，上游渠道可能比它更严（超限回 400 / 空流）——
客户端收到超限错误应能**降档重试**。

## 2. 核实方法（2026-10-20）

1. **官方文档优先**：平台 API 文档页、模型卡、定价页（带「长度限制 / 上下文窗口 / 最大输出」原文）。
2. **官方模型卡**（HuggingFace / GitHub / 官方仓库 `config.json`）补官方文档没写的型号。
3. **第三方目录**（`contextwindows.dev` / `models.dev` / OpenRouter / LiteLLM）只作**交叉校验**，
   与官方冲突时**以官方为准**（实测冲突：gpt-5.5 第三方报 272000，官方 1050000；
   glm-4.7 第三方报 64K 输出，官方 131072）。
4. **查不到就写「无公开规格」** —— 绝不编造数字，也不拿相邻型号的值顶替。

⚠️ 精确值注意：GLM 官方只写「200K / 1M」，精确值是 **202752 / 1048576**；
Gemini 的 1048576 是**输入上限**（Output token limit 另算 65536）；
OpenAI 的 1050000 含输出配额，**922000 是第三方推导的可用输入上限**、不是上下文窗口。

## 3. 规格表（有公开规格）

| 模型 | 上下文 | 最大输出 | 来源 |
| --- | --- | --- | --- |
| `deepseek-flash` | 1048576 | 393216 | [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) |
| `deepseek-v4-flash` | 1048576 | 393216 | 同上（型号已退役，路由到 V4.1-Flash-1017） |
| `deepseek-v4-pro` | 1048576 | 393216 | 同上（2026-09 起别名路由到 V4.1-Flash） |
| `deepseek-v4.1-flash` | 1048576 | 393216 | 同上 + [百炼](https://help.aliyun.com/zh/model-studio/deepseek-v4-1-flash) |
| `qwen3.5-plus` | 1000000 | 65536 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-5-plus) |
| `qwen3.6-plus` | 1000000 | 65536 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-6-plus) |
| `qwen3.7-max` | 1000000 | 131072 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-7-max) |
| `qwen3.7-plus` | 1000000 | 131072 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-7-plus) |
| `qwen3.7-flash` | 1000000 | 131072 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-7-flash) |
| `qwen3.8-max` | 1000000 | 131072 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-8-max) |
| `qwen3.8-flash` | 1000000 | 131072 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-8-flash) |
| `qwen3.8-omni-flash` | 1000000 | 131072 | [百炼](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash) |
| `glm-4.7` | 202752 | 131072 | [docs.z.ai](https://docs.z.ai/guides/llm/glm-4.7) |
| `glm-5` | 202752 | 131072 | [docs.z.ai](https://docs.z.ai/guides/llm/glm-5) |
| `glm-5.1` | 202752 | 131072 | [bigmodel.cn](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.1) |
| `glm-5.2` | 1048576 | 131072 | [docs.z.ai](https://docs.z.ai/guides/llm/glm-5.2) |
| `glm-5.3` | 1048576 | 131072 | [docs.z.ai](https://docs.z.ai/guides/llm/glm-5.3) |
| `glm-5.3-flash` | 1048576 | 131072 | [docs.z.ai](https://docs.z.ai/guides/vlm/glm-5.3-flash)（与 FlashX 同页） |
| `glm-5.3-flashx` | 1048576 | 131072 | [bigmodel.cn](https://docs.bigmodel.cn/cn/guide/start/model-overview) |
| `glm-5v-turbo` | 202752 | 131072 | [bigmodel.cn](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo) |
| `minimax-m2.7` | 204800 | 131072 | [HF config](https://huggingface.co/MiniMaxAI/MiniMax-M2.7/blob/main/config.json) |
| `minimax-m3` | 1048576 | 131072 | [platform.minimax.io](https://platform.minimax.io/docs/guides/text-generation) |
| `minimax-m3.1-flash` | 1000000 | 524288 | [platform.minimax.io](https://platform.minimax.io/docs/api-reference/text-chat-openai)（官方 maximum；recommended 131072） |
| `kimi-k2` | 131072 | 无公开规格 | [模型卡](https://huggingface.co/moonshotai/Kimi-K2-Instruct) |
| `kimi-k2.5` | 262144 | 无公开规格 | [模型卡](https://huggingface.co/moonshotai/Kimi-K2.5) |
| `kimi-k2.6` | 262144 | 32768 | [API 文档](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)（官方只给 `max_tokens` **默认值**） |
| `kimi-k2.7-code` | 262144 | 32768 | [API 文档](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart)（同上，默认值级证据） |
| `kimi-k2.8-preview` | 1048576 | 无公开规格 | [Kimi Code 文档](https://www.kimi.com/code/docs/kimi-code/models.html) |
| `kimi-k3` | 1048576 | 1048576 | [API 文档](https://platform.kimi.ai/docs/api/chat)（默认 131072，上限 1048576） |
| `mimo-v2.5` | 1048576 | 131072 | [mimo.mi.com](https://mimo.mi.com/models/en-US/mimo-v2.5) |
| `mimo-v2.6-flash` | 1048576 | 131072 | [mimo.mi.com](https://mimo.mi.com/models/en-US/mimo-v2.6-flash) |
| `mimo-v2.6-pro` | 1048576 | 131072 | [mimo.mi.com](https://mimo.mi.com/models/en-US/mimo-v2.6-pro) |
| `spark-x`（讯飞星火 X2.5） | 262144 | 262144 | [讯飞文档](https://www.xfyun.cn/doc/spark/Spark-X2.5.html)（官方写 `< 256K`） |
| `longcat-2.0` | 1048576 | 262144 | [longcat.ai](https://longcat.ai/platform/docs/api/model-params) |
| `doubao-seed-2.0-code-preview` | 262144 | 131072 | [火山方舟](https://docs.volcengine.com/docs/ark/model-list?lang=zh) |
| `doubao-seed-2.1-pro` | 1048576 | 262144 | 同上（滚动别名，当前指向 260915） |
| `doubao-seed-2.1-turbo` | 262144 | 262144 | 同上 |
| `doubao-seed-evolving` | 1048576 | 262144 | [火山方舟](https://docs.volcengine.com/docs/ark/latest-model?lang=zh) |
| `hunyuan-turbos` | 262144 | 无公开规格 | [模型卡](https://github.com/tencent-hunyuan/Hunyuan-Turbos) |
| `hy3` | 262144 | 无公开规格 | [模型卡](https://github.com/tencent-hunyuan/Hy3) |
| `hy4-preview` | 1048576 | 无公开规格 | [模型卡](https://github.com/tencent-hunyuan/Hy4-preview) |
| `step-5-preview` | 1048576 | 65536 | [阶跃文档](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview) |
| `openpangu-2.0-flash` | 524288 | 无公开规格 | [模型卡](https://huggingface.co/openpangu/openPangu-2.0-Flash) |
| `openpangu-2.0-pro` | 524288 | 无公开规格 | [模型卡](https://huggingface.co/openpangu/openPangu-2.0-Pro) |
| `gpt-5.4` / `gpt-5.5` / `gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-6-astra` / `gpt-6-luna` / `gpt-6-sol` / `gpt-6.1-sol` | 1050000 | 128000 | [developers.openai.com](https://developers.openai.com/api/docs/models) |
| `gemini-3.5-flash` | 1048576 | 65536 | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash)（上下文栏是**输入**上限） |
| `gemini-3.8-flash` | 1048576 | 65536 | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| `grok-4.7` | 500000 | 无独立上限（官方写「No text output limit」） | [docs.x.ai](https://docs.x.ai/developers/grok-4-7) |

## 4. 没有公开规格的（**不编造**，网关给兜底值）

| 型号 | 为什么没有 | 证据 |
| --- | --- | --- |
| `qwen3` | 百炼文档站已撤该型号页 | [百炼](https://help.aliyun.com/zh/model-studio/) 无此条目 |
| `deepseek-chat` | 官方 2026-07-24 起停用该别名 | [官方公告](https://api-docs.deepseek.com/updates) |
| `glm-5.2-sft-harmony` | 公开资料查无此型号（唯一旁证是第三方反代写死的常量，**不可当官方依据**） | z.ai / bigmodel / HF / GitHub 均无 |
| `kimi-k2.6-vl` | 无此变体（K2.6 本身即原生多模态） | [官方模型列表](https://platform.kimi.ai/docs/models) |
| `kimi-k2.7` | 无此独立型号（只有 `k2.7-code` / `k2.7-code-highspeed`） | 同上 |
| `kimi-k3.1` | 官方未发布 | 同上 |
| `hunyuan-t1` | 纯文本型号已从腾讯云模型列表移除（平台声明迁移 TokenHub） | [腾讯云](https://cloud.tencent.com/document/product/1729/104753) |
| `hy3-x` | 无此仓库 / 无第三方登记 | GitHub tencent-hunyuan 无 |
| `sensenova-6.8-flash` / `-lite` | 官方站只有 Lite 且未给数值；文档站是 SPA | [sensenova.cn](https://www.sensenova.cn/models) |
| `doubao-seed-code` | 方舟模型列表与价格页均无该 id | [火山方舟](https://docs.volcengine.com/docs/ark/model-list?lang=zh) |
| `auto` / `efficient` / `performance` / `ultimate` / `cantus` / `sonus` | Qoder 的**策略档位**（按账号档位路由到不同底层模型），官方只公布 Credits 倍率 | [docs.qoder.com](https://docs.qoder.com) |
| `default-model` / `fast-model` / `balanced-model` / `primary-model` | workbuddyai 的**档位别名**，非公开模型 | — |
| `space-bunny` | WorkBuddy CN 的目录条目 | — |
| `orcaterm-assistant` | 兼容别名 → 指向默认模型（`deepseek-v4-flash`，规格随默认模型） | `docs/channels/orcaterm/PROTOCOL.md` §1 |

## 5. 这些数字怎么进到 `/v1/models`

三层取值，**上游声明优先**：

1. **上游目录声明**（最权威）—— 渠道 catalog 解析上游模型列表时带下来的窗口 / 输出上限
   （字段名各不相同，汇聚层逐个尝试，见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.6）。
2. **渠道已知规格表**（本文）—— 上游不发时，渠道用自己的 `MAX_OUTPUTS` 表回答
   （`catalog.modelSpec()` 钩子，见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.3）。
   **表里的数值必须与本文一致**；改规格先改本文，再改渠道表。
3. **兜底值** —— 两者都没有时给 128000 / 4096，表示「未知」。

⚠️ 共享层**不许出现模型名**（根 `AGENTS.md`「仓库结构与约束」第 2 条）——
所以第 2 层的表**必须放在渠道包里**（`packages/core/channels/<cid>/src/catalog.ts`），
不能上提到 gateway。

## 6. 已知的上游与公开规格分歧

| 型号 | 渠道上游声明 | 公开规格 | 处置 |
| --- | --- | --- | --- |
| `spark-x`（loomy） | 上下文 1048576 | 262144 | **以上游为准**（渠道实际能吃多少以它自己为准），分歧记在 `docs/channels/loomy/PROTOCOL.md` |
| `glm-4.7` | — | 202752 / 131072 | 按公开规格填 |

## 7. 怎么更新

1. 厂商发新版本 → 重新核实（§2 的方法）→ **先改本文 §3 / §4**。
2. 再改对应渠道的 `MAX_OUTPUTS` 表（`packages/core/channels/<cid>/src/catalog.ts`）。
3. `npm run build` → `mx restart` → 复测 `GET /v1/models`。
4. 型号**没有**公开规格时，**删表里的行**（让网关回落兜底），不要猜一个数填进去。
