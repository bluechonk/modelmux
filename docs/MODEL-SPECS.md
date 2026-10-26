# 模型窗口规格（上下文 / 最大输出）

`GET /v1/models` 的 `context_window` 与 `max_output_tokens` 从哪来、怎么核实的、
哪些型号**没有**公开规格 —— 唯一事实源。

## 1. 两个数字的口径

| 字段 | 含义 | 缺省时客户端会怎样 |
| --- | --- | --- |
| `context_window` | 模型能吃进去的**总** token（输入 + 输出） | 客户端按默认猜（常见 128k / 256k），长会话被**自己**截断 |
| `max_output_tokens` | 单次回复的**最大**输出 token | 客户端按默认猜（常见 4096），每次回答被截到 4k |

⚠️ **兜底值（窗口 200K / 输出 64K）不是任何模型的真实上限** —— 上游目录普遍**不下发**
这两个数（见 §4），兜底值只是「未知」的占位（常见档位的下限），不是真实规格。

⚠️ 公开规格是**模型上限**，上游渠道可能比它更严（超限回 400 / 空流）——
客户端收到超限错误应能**降档重试**。

## 2. 核实方法

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
| `deepseek-v4.1-flash-sg` | 1048576 | 393216 | 同 [deepseek 官方](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（workbuddyai 目录名，= `deepseek-v4.1-flash`） |
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
| `glm-5.0` | 202752 | 131072 | [docs.z.ai](https://docs.z.ai/guides/llm/glm-5)（workbuddy 目录名，= `glm-5`） |
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
| `hunyuan-turbos` | 262144 | 无公开规格 | [模型卡](https://github.com/tencent-hunyuan/Hunyuan-Turbos)（API 侧另有「最大输入 32K / 最大输出 16K」的限制，本表报模型上限） |
| `hunyuan-chat` | 262144 | 无公开规格 | [模型卡](https://github.com/tencent-hunyuan/Hunyuan-Turbos)（workbuddy 目录名，= `hunyuan-turbos`） |
| `hy3` | 262144 | 131072 | [TokenHub 混元指南](https://cloud.tencent.com/document/product/1823/132252)（上下文 256K / 最大输入 192K / 最大输出 128K）+ [模型卡](https://github.com/tencent-hunyuan/Hy3) |
| `hy4-preview` | 1048576 | 无公开规格 | [官方发布页](https://hunyuan.tencent.com/research/hy4-preview)（上下文 1M；最大输出未公布） |
| `hy4-preview-x` | 1048576 | 无公开规格 | 同上（workbuddy 目录名，= `hy4-preview`） |
| `step-5-preview` | 1048576 | 65536 | [阶跃文档](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview) |
| `openpangu-2.0-flash` | 524288 | 无公开规格 | [模型卡](https://huggingface.co/openpangu/openPangu-2.0-Flash) |
| `openpangu-2.0-pro` | 524288 | 无公开规格 | [模型卡](https://huggingface.co/openpangu/openPangu-2.0-Pro) |
| `gpt-5.4` / `gpt-5.5` / `gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-6-astra` / `gpt-6-luna` / `gpt-6-sol` / `gpt-6.1-sol` | 1050000 | 128000 | [developers.openai.com](https://developers.openai.com/api/docs/models) |
| `gemini-3.5-flash` | 1048576 | 65536 | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash)（上下文栏是**输入**上限） |
| `gemini-3.8-flash` | 1048576 | 65536 | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| `grok-4.7` | 500000 | 无独立上限（官方写「No text output limit」） | [docs.x.ai](https://docs.x.ai/developers/grok-4-7) |

### 3.2 思考档位（官方文档声明的）

**公开资料里的「思考」大多是开关或思考长度上限，不是 effort 档位。** 只有少数上游把档位
写成了 `reasoning_effort` 的取值 —— 那部分才是可用的规格。目前**唯一**一份逐模型给全档位的
官方文档是腾讯云 TokenHub 的「推理深度配置」：

| 模型 | 默认档 | 支持的档位 | 来源 |
| --- | --- | --- | --- |
| `hy4-preview` | `high` | `high`、`none` | [TokenHub 深度思考](https://cloud.tencent.com/document/product/1823/131208) |
| `hy3` | `high` | `low`、`high`、`none` | 同上 |
| `deepseek-v4-flash` | `high` | `low`、`high`、`max` | 同上 |
| `deepseek-v4-pro` | `high` | `low`、`high`、`max` | 同上 |
| `glm-5.3-flash` | `max` | `low`、`high`、`max` | 同上 |
| `glm-5.3-flashx` | `max` | `low`、`high`、`max` | 同上 |
| `glm-5.3` | `max` | `low`、`high`、`max` | 同上 |
| `glm-5.2` | `max` | `max`、`xhigh`、`high`、`medium`、`low`、`minimal`、`none` | 同上 |
| `kimi-k3` | `max` | `low`、`high`、`max` | 同上 |

`none` = **关闭思考**（TokenHub 用它表示关，与 loomy / lobsterai 的 `off` 同义）。

口径（重要）：

- 这份表只给**没有目录端点**的渠道用（渠道用内置快照时经 `catalog.modelSpec().effort`
  交给池层，`/v1/models` 的 `meta_sources.effort` 标 **`spec`**）。
  ⚠ 它**不是**上游运行时声明，别把它当 `upstream`：渠道目录里下发的档位才算。
- 有目录端点的渠道（catpaw / loomy / traecn / lobsterai / qoder / qodercn …）**一律以上游为准**，
  公开文档只用来核对，不覆盖。
- 其余模型（kimi-k2.x / qwen3.x / minimax / doubao / glm-4.7 等）的公开文档只写「支持思考/非思考」
  或「最大思维链长度」，**没有 effort 档位** → 池层如实给 `null`（「不支持 / 未知」），
  由跨渠道交集兜底或保持为空，**绝不按「支持思考」推断出档位**。

## 4. 没有公开规格的（**不编造**，网关给兜底值）

> 2026-10-25 用 Tavily 全量复查过一轮（官方文档 / 模型卡 / 官方发布页优先，第三方只作交叉校验）：
> 下面这些型号**确实没有现行官方数字**，第三方登记的数字只记作「旁证」，**不写进任何表**。

| 型号 | 为什么没有 | 证据 / 旁证 |
| --- | --- | --- |
| `qwen3` | 百炼文档站已撤该型号页（现只列 3.5+ 系列） | [百炼](https://help.aliyun.com/zh/model-studio/) 无此条目；第三方登记 128K（旁证，原生 32K + YaRN 口径不一，**不采用**） |
| `deepseek-chat`（含 `-latest` 别名） | 官方 2026-07-24 起停用该别名 | [官方公告](https://api-docs.deepseek.com/updates)；现定价页只列 `deepseek-flash` / `deepseek-v4-pro`（1M / 384K） |
| `hunyuan-t1` | 纯文本型号已从腾讯云模型列表移除，只剩 `t1-vision` 变体 | [腾讯云产品页](https://cloud.tencent.com/document/product/1729/104753) 2026 版只有 vision 行；第三方登记 64K/16K（旁证，**不采用**） |
| `doubao-seed-code` | 方舟模型列表与价格页均无该 id | [火山方舟模型列表](https://www.volcengine.com/docs/82379/1593703) 现只有 `doubao-seed-evolving` / `seed-2-1-*`；第三方报道按 32k/128k/256k 分档计价（旁证） |
| `kimi-k2.5` / `kimi-k2.5-thinking` / `kimi-k2-thinking` | 官方 2026-08-31 起**下线**，不再给规格 | [官方模型列表](https://platform.kimi.com/docs/models)「已下线模型」；第三方登记 K2.5 为 256K/16K（旁证，**不采用**；上下文沿用模型卡的 262144） |
| `hunyuan-image-alpha` / `hunyuan-image-alpha-edit` / `kling-video-v3` / `minimax-video-h3` | **媒体生成模型**（图像 / 视频），没有「上下文窗口」这个概念 | 占位值只是 API 形状要求，**对它们没有意义**；客户端别拿它估长文 |
| `wb-lite` | WorkBuddy 内部型号，公开资料查无 | — |
| `hunyuan-3b` / `hunyuan-7b-dense` | workbuddy 的内部命名（HF 上的 Hunyuan dense 系列口径不一） | [HF tencent](https://huggingface.co/tencent) 有 dense 系列但未给 API 上限 |
| `deepseek-r1.0528` / `deepseek-v3.0324` / `deepseek-v3.0324-taco-completion` | workbuddy 的历史内部命名（对应型号已退役） | 官方现只列 v4 系列 |
| `glm-5.2-sft-harmony` | 公开资料查无此型号（唯一旁证是第三方反代写死的常量，**不可当官方依据**） | z.ai / bigmodel / HF / GitHub 均无 |
| `kimi-k2.6-vl` | 无此变体（K2.6 本身即原生多模态） | [官方模型列表](https://platform.kimi.com/docs/models) |
| `kimi-k2.7` | 无此独立型号（只有 `k2.7-code` / `k2.7-code-highspeed`） | 同上 |
| `kimi-k3.1` | 官方未发布 | 同上 |
| `hy3-x` | 无此仓库 / 无第三方登记 | GitHub tencent-hunyuan 无 |
| `sensenova-6.8-flash` / `-lite` | 官方站只有 Lite 且未给数值；文档站是 SPA | [sensenova.cn](https://www.sensenova.cn/models) |
| `auto` / `efficient` / `performance` / `ultimate` / `cantus` / `sonus` | Qoder 的**策略档位**（按账号档位路由到不同底层模型），官方只公布 Credits 倍率 | [docs.qoder.com](https://docs.qoder.com) |
| `default-model` / `fast-model` / `balanced-model` / `primary-model` | workbuddyai 的**档位别名**，非公开模型 | — |
| `space-bunny` | WorkBuddy CN 的目录条目 | — |
| AStudio 全系（`auto` / `spark-x2.5` / `spark-x2.6` / `spark-x2.6-lite` / `glm-5.2` / `deepseek-v4-pro` / `deepseek-v4-flash`） | **无公开规格**：AStudio 是讯飞桌面应用，型号与窗口都随**应用包内置**（`provider-model-catalog-v1.json` + `model-gateway/catalog-<hash>.json`），官方站不公布 | 见下方 §4.2 |

### 4.2 AStudio：规格来自**应用内置目录**（不是公开资料）

AStudio 的 7 个型号与窗口/输出/档位全部来自**应用包内置 JSON**（B 级实测，2026-10-26），
官方站没有任何对应页面，所以既进不了 §3（无公开来源），也不是「查无」：

| 型号 | 上下文 | 最大输出 | 思考档位 | 默认档 | 消耗倍率 |
| --- | --- | --- | --- | --- | --- |
| `auto` | 262144 | 100000 | `none` / `high` | `high` | **未知** |
| `spark-x2.6` | 262144 | 100000 | `none` / `high` | `high` | **未知** |
| `spark-x2.6-lite` | 1048576 | 110000 | `none` / `high` / `max` | `high` | **未知** |
| `spark-x2.5` | 262144 | 100000 | `none` / `high` | `high` | **未知** |
| `glm-5.2` | 1048576 | 100000 | `none` / `high` / `max` | `high` | **×2.0**（实测） |
| `deepseek-v4-pro` | 1048576 | 100000 | `none` / `high` / `max` | `high` | **×2.0**（实测） |
| `deepseek-v4-flash` | 1048576 | 100000 | `none` / `high` / `max` | `high` | **未知** |

**倍率那列的「未知」是实测结论，不是漏填**：云端
`GET /xingchen-studio/bot/models/configs` 返回 9 行，其中 `point_multiplier` 只有 8 行有值
（`x2.0` / `x1.0` / `x0.5`），且**行 id 与本表 exposure 只有 2 个对得上**
（`xopglm52`、`xopdeepseekv4pro`，均 `x2.0`）；`astronclaw-auto` 的 `point_multiplier` 为 `null`，
`spark-x2.6` / `spark-x2.6-4b` / `spark-x2.5` / `xopdsv4flash0731in` 在云端**根本没有对应行**。

⚠ 此前本表给那 5 个模型一律填 `multiplier: 1`，那是**无源填 1**（客户端会按它算钱）。
2026-10-26 改为省略该字段 → 池层回落 `null` → 控制台按订阅制（`capabilities.billing: false`）
显示「免费」。**倍率要么实测、要么未知，绝不编造。**

⚠ 输入模态同理：AStudio 目录不带图像字段 → 如实报纯文本（见 §4.1 的口径）。

### 4.1 输入模态：**只认渠道声明，不按公开资料推断**

`input_modalities` 来自渠道目录条目（`inputModalitiesOf()` 的候选字段表），
**没有**「公开规格」这一层 —— 公开资料说某模型多模态，不等于这条渠道的接口接受图像：

| 型号 | 公开资料 | 本仓库的处理 |
| --- | --- | --- |
| `kimi-k2.5` / `k2.6` / `k2.7-code` | 原生多模态（文本 + 图像，K2.7 还有视频） | 只有上游目录声明了才报「文本+图」；上游没声明就如实报纯文本 |
| `glm-5.3-flash` | 官方称原生多模态（图像 / 视频 / 文件） | 同上（z.ai 系渠道的目录会声明 `is_vl` / `vision`） |
| `qwen3.5-plus` | 百炼写 Text+Image+Video 输入 | 同上 |
| catpaw 全系 | 上游目录不带图像字段（`supportsImages` 恒 false） | 如实报纯文本 —— **这是「上游没声明」，不是「不支持」**，见 §3 与 `docs/channels/catpaw/PROTOCOL.md` |

⚠ 宁可少报：报「能吃图」但上游不认，客户端会把图片发进请求并失败；报纯文本只是少用一项能力。

## 5. 这些数字怎么进到 `/v1/models`

四层取值，**上游声明优先**（窗口 / 输出 / 思考档位三个字段各自独立走这套顺序）：

1. **上游目录声明**（最权威）—— 渠道 catalog 解析上游模型列表时带下来的窗口 / 输出上限 /
   `effort`（字段名各不相同，汇聚层逐个尝试，见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.6）。
2. **渠道已知规格表**（本文）—— 上游不发时，渠道用自己的表回答
   （`catalog.modelSpec()` 钩子，见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.3）：
   窗口 / 输出按 §3，**思考档位按 §3.2**（只有 TokenHub 那种官方逐模型给档位的才有），
   **倍率按 §4.2**（AStudio 这种内置目录的）。
   **表里的数值必须与本文一致**；改规格先改本文，再改渠道表。
   ⚠ `modelSpec()` 的返回值**只能有实测值**：查不到就整个字段省略
   （`undefined`）—— 池层据此回落到 `null`，UI 显示「免费」/「—」，**不猜数字**。
3. **跨渠道兜底** —— 本渠道上游与规格表都答不上来时，拿**兄弟渠道同规范 model id** 的已知值
   （窗口 / 输出取**最小**、档位取**交集**，只填缺值，`sources` 标 `cross`）：
   比第 4 层可信、比第 1/2 层弱 —— 那是**别的渠道**被上游裁剪过的数字。
   口径见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.7。
   ⚠ **倍率不走这一层**：倍率是渠道自己的计费口径，拿兄弟渠道的值去填等于编造。
4. **兜底值** —— 前三条都没有时给 200000 / 65536，表示「未知」（不是真实上限）；
   档位则给 `null`（**不编档位**），倍率给 `null`（**不编倍率**）。

⚠️ 共享层**不许出现模型名**（根 `AGENTS.md`「仓库结构与约束」第 2 条）——
所以第 2 层的表**必须放在渠道包里**（`packages/core/channels/<cid>/src/catalog.ts`），
不能上提到 gateway。

⚠️ 第 2 层的档位与窗口/输出**来源标注不同**：`meta_sources.effort` 标 `spec`（官方文档），
不是 `upstream`（渠道运行时声明）。客户端若只信上游，可以按这个字段区分。

## 6. 已知的上游与公开规格分歧

| 型号 | 渠道上游声明 | 公开规格 | 处置 |
| --- | --- | --- | --- |
| `spark-x`（loomy） | 上下文 1048576 | 262144 | **以上游为准**（渠道实际能吃多少以它自己为准），分歧记在 `docs/channels/loomy/PROTOCOL.md` |
| `glm-4.7` | — | 202752 / 131072 | 按公开规格填 |
| `gpt-5.4`（workbuddyai） | 272000 / 72000 | 1050000 / 128000 | **以上游为准**；同页的 `gpt-5.5` 及以后上游声明 1000000 / 128000，与公开规格一致 |
| `grok-4.7`（workbuddyai） | 500000 / 128000 | 500000 / 官方写「No text output limit」 | **以上游为准**（上游给了具体上限） |
| `kimi-k3`（workbuddyai） | 1000000 / 32000 | 1048576 / 1048576 | **以上游为准**（上游更严） |
| `spark-x2.6`（loomy） | 1048576 / 131072 | 未核实到公开规格 | **以上游为准** |
| `sensenova-6.8-flash` / `-lite`（raccoon） | 256000 / 63999 | 未核实到公开规格 | **以上游为准** |
| `hy3` / `hy4-preview` / `hunyuan-turbos`（workbuddy） | 192000 / 1048576 / 262144（均未声明输出） | 262144 / 1048576 / 262144 | **以上游为准**；⚠ workbuddy 的 `hy3` 报的是**最大输入** 192K（TokenHub 官方口径：上下文 256K / 最大输入 192K），本表第 3 节报的是上下文 |
| `glm-5.3`（catpaw） | 最大档 800000 | 1048576 | **以上游为准**（上游逐型号声明档位，见 `docs/channels/catpaw/PROTOCOL.md`） |
| `deepseek-v4.1-flash` / `deepseek-v4-pro`（catpaw） | 最大档 600000 / 700000 | 1048576 | **以上游为准** |
| `spark-x`（loomy）最大输出 | 65536 | 262144 | **以上游为准** |

## 7. 怎么更新

1. 厂商发新版本 → 重新核实（§2 的方法）→ **先改本文 §3 / §4**。
2. 再改对应渠道的规格表（`packages/core/channels/<cid>/src/catalog.ts` 的 `MAX_OUTPUTS` 或 `MODEL_SPECS`）。
3. `npm run build` → `mx restart` → 复测 `GET /v1/models`。
4. 型号**没有**公开规格时，**删表里的行**（让网关回落兜底），不要猜一个数填进去。
