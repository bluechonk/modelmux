# 第三方参考与许可证登记（REFERENCES）

本仓库大量参考了公开的逆向/桥接项目（各家 AI 客户端的第三方反代）、官方模型卡与 npm 生态。
本文件是**唯一的许可证事实源**：渠道协议文档里的 `## 参考实现` 只写「从哪个仓库学到了什么」，
许可证与使用边界统一登记在这里。

## 1. 使用原则（**先读这段**）

1. **只借鉴协议事实与实现思路，不复制代码。** 本项目所有实现都是 TypeScript 重写：
   - 借鉴的是**事实**：端点、请求头约束、错误码语义、限流形状、时间戳格式；
   - 借鉴的是**思路**：例如「用 `timegm` 而不是 `mktime` 解析上游时间戳」这类经验；
   - **没有逐行复制任何参考仓库的代码**，因此不构成衍生作品；即便如此，本条登记仍然保留出处。
2. **许可证检查在借鉴之前**（全局规则）：`NOASSERTION`（无许可证文件）或已删除的仓库，
   只作为**协议事实来源**（跑一遍看它请求什么、响应长什么样），**不复用其代码**。
3. **MIT / Apache-2.0 等宽松许可证**的仓库同样遵守上面的第 1 条；若未来真的要复制代码，
   必须在该文件头保留原版权声明与许可证全文，并在本表补一列「衍生自」。
4. **本项目自身**是 [MIT](./../LICENSE)（`Copyright (c) 2026 bluechonk`），`package.json` 的
   `license` 字段与之一致。

## 2. 渠道协议参考实现（按渠道）

许可证取自 GitHub API（`license.spdx_id`，查询时间 2026-10-23）；`NOASSERTION` = 仓库未提供可识别的
许可证文件；`—` = 仓库已 404（删除或改名，链接保留以便追溯）。

### catpaw

| 仓库 | 许可证 | 在本仓库的落点 |
|---|---|---|
| [fifasheng-tech/catpaw-bridge](https://github.com/fifasheng-tech/catpaw-bridge) | NOASSERTION | `docs/channels/catpaw/PROTOCOL.md` |
| [HITZY2002/catpaw2api](https://github.com/HITZY2002/catpaw2api) | MIT | 同上 |
| [icebears111/catpaw2api](https://github.com/icebears111/catpaw2api) | NOASSERTION | 同上 |
| [Juwan-Hwang/catpaw2api](https://github.com/Juwan-Hwang/catpaw2api) | MIT（仓库已归档） | 同上 |
| [KanoNoUta/thief-neko](https://github.com/KanoNoUta/thief-neko) | MIT | 同上 |
| [zhou-gy/catpawai-proxy](https://github.com/zhou-gy/catpawai-proxy) | NOASSERTION | 同上 |

### lobsterai

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [netease-youdao/LobsterAI](https://github.com/netease-youdao/LobsterAI) | MIT | `docs/channels/lobsterai/PROTOCOL.md`（官方客户端，用于协议事实） |
| [greatleo31/lobsterAi2api](https://github.com/greatleo31/lobsterAi2api) | MIT | 同上 |
| [xinxinshuhao-create/lobsterai2api](https://github.com/xinxinshuhao-create/lobsterai2api) | MIT | 同上 |
| [skyletter/lobsterai2api-docker](https://github.com/skyletter/lobsterai2api-docker) | NOASSERTION | 同上 |
| [L0NE-6/LobsterAI-AutoCheckin](https://github.com/L0NE-6/LobsterAI-AutoCheckin) | MIT | 同上（签到逻辑） |
| [gurio-wine/dsh-account-hub](https://github.com/gurio-wine/dsh-account-hub) | MIT | 同上（多账号治理思路） |

### loomy

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api) | MIT | `docs/channels/loomy/PROTOCOL.md` |
| [wangliangdong/loomy2api](https://github.com/wangliangdong/loomy2api) | NOASSERTION | 同上 |
| [xxhhlk/loomy2api](https://github.com/xxhhlk/loomy2api) | MIT | 同上 |
| [xingluoyuankong/loomy2api](https://github.com/xingluoyuankong/loomy2api) | MIT（历史参照，微信登录已移除） | 同上 |

### qoder / qodercn

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [cubk1/qoder2api](https://github.com/cubk1/qoder2api) | NOASSERTION | `docs/channels/qoder/PROTOCOL.md` |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | MIT | `docs/channels/qoder/PROTOCOL.md`、`docs/channels/qodercn/PROTOCOL.md` |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | NOASSERTION | 同上 |
| [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) | MIT | `docs/channels/qodercn/PROTOCOL.md` |
| [jyao0708/qoder2api](https://github.com/jyao0708/qoder2api) | MIT | `docs/channels/qodercn/PROTOCOL.md` |

### raccoon

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [xxhhlk/raccoon2api](https://github.com/xxhhlk/raccoon2api) | MIT | `docs/channels/raccoon/PROTOCOL.md` |
| [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) | NOASSERTION | 同上 |
| [swysgh/xiaohuanxiong2api](https://github.com/swysgh/xiaohuanxiong2api) | — | 同上（已 404） |

### traecn

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [A-23187/trae-api](https://github.com/A-23187/trae-api) | MIT | `docs/channels/traecn/PROTOCOL.md` |
| [JeffHu0912/trae2api](https://github.com/JeffHu0912/trae2api) | MIT | 同上 |
| [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) | MIT | 同上 |
| [connectedGraph/trae2api-web](https://github.com/connectedGraph/trae2api-web) | MIT | 同上 |

### workbuddy

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | MIT | `docs/channels/workbuddy/PROTOCOL.md`、`docs/channels/workbuddyai/PROTOCOL.md` |
| [HanawaBanana/workbuddy2api](https://github.com/HanawaBanana/workbuddy2api) | MIT | `docs/channels/workbuddy/PROTOCOL.md` |
| [xiaofan6ya/workbuddy2api](https://github.com/xiaofan6ya/workbuddy2api) | — | 同上（已 404） |
| [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api) | MIT | 同上 |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | — | 同上（已 404） |

### workbuddyai

| 仓库 | 许可证 | 落点 |
|---|---|---|
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | **MIT**（主参照，已 clone 到 `packages/core/channels/workbuddyai/reference/`，不入库） | `docs/channels/workbuddyai/PROTOCOL.md` |
| [Tom6814/WorkBuddy2API](https://github.com/Tom6814/WorkBuddy2API) | MIT | 同上 |
| [ckldy/workbuddy2api](https://github.com/ckldy/workbuddy2api) | NOASSERTION | 同上 |

> 从 `workbuddy2api-hub` 学到的具体结论：`6004`（用量限额）的重置时间写在 **msg 文本**里
> （`... reset at YYYY-MM-DD HH:MM:SS UTC+8 ...` / `将在 ... 重置`），且必须用 `timegm`
> 语义解析（见 `wb_proxy.py::parse_rate_limit_reset`）。本仓库据此用 TypeScript 重写了
> `upstream.quotaResetAt()`，**未复制其代码**。

## 3. 模型规格参考（官方模型卡）

`docs/MODEL-SPECS.md` 的窗口 / 输出上限来自官方模型卡，仓库未声明可识别许可证
（`NOASSERTION`），只作为**公开规格事实**引用：

| 仓库 | 许可证 | 用途 |
|---|---|---|
| [tencent-hunyuan/Hy3](https://github.com/tencent-hunyuan/Hy3) | NOASSERTION | 混元 Hy3 规格 |
| [tencent-hunyuan/Hy4-preview](https://github.com/tencent-hunyuan/Hy4-preview) | NOASSERTION | 混元 Hy4-preview 规格 |
| [tencent-hunyuan/Hunyuan-Turbos](https://github.com/tencent-hunyuan/Hunyuan-Turbos) | NOASSERTION | 混元 Turbos 规格 |

## 4. npm 生态依赖

**运行期零第三方依赖**是硬约束（`packages/core/gateway` 的 `dependencies` 为空），
下面的依赖只出现在 CLI 构建链与 Web 控制台：

| 包 | 位置 | 许可证 |
|---|---|---|
| `lucide-react` | UI（运行期，随 Web 产物打包） | ISC |
| `react` / `react-dom` / `react-router` | UI（devDependencies，构建期） | MIT |
| `@tanstack/react-query` | UI（devDependencies） | MIT |
| `tailwindcss` / `@tailwindcss/vite` | UI（devDependencies） | MIT |
| `vite` | UI（devDependencies） | MIT |
| `esbuild` | CLI（devDependencies，打单文件 bundle） | MIT |
| `typescript` / `@types/*` | 全仓（devDependencies） | Apache-2.0 / MIT |

## 5. 维护约定

1. **clone 参考实现**：只在 `packages/core/channels/<cid>/reference/<owner>_<repo>/`（渠道级
   `.gitignore` 已忽略，不入库），`--depth 1`；用完可删，删了也要保留本节登记。
2. **新增参考**：先在本表登记「仓库 + 许可证 + 落点」，再动代码；`NOASSERTION` 的仓库
   只允许作为事实来源。
3. **删除渠道**：本表对应小节随之删除（历史从 git 取），与仓库「不设 archive 目录」的约定一致。
