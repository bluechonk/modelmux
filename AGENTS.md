# AGENTS.md —— modelmux

modelmux 是多渠道 LLM 网关：一个端口、动态模型池、渠道热插拔。项目介绍见 [README.md](README.md)，
架构与契约见 [docs/README.md](docs/README.md)。

## 通用规则

全局规则（环境 / 网络 / 临时文件 / 工作流 / 编码 / 文档 / 版本控制 / 平台）由全局真源
`~/.agents/AGENTS.md` 规定；各工具入口（`~/.zcode`、`~/.codex`、`~/.claude`、`~/.dsh`）都是它的软链。
本文件只写本仓库特有的约束，不复制全局规则。冲突优先级：用户当次明确指令 > 本文件 > 全局规则 > 技能默认行为。

## 仓库结构

```
packages/
  cli/         全局 mx 入口，esbuild 单文件 bundle
  ui/          Web 控制台（Vite），不在 tsc solution 中
  core/
    gateway/   共享层：runtime → pool/auth → http → app，单向分层，向上依赖失败
    channels/  渠道包：每个 <cid> 只实现 7 个文件（channel / cli / index + cred / upstream / catalog / billing）
```

- `packages/core/gateway` 不许出现渠道知识（厂商名、渠道特有字段、渠道模型名）。
- `packages/core/channels/<cid>` 超出 7 文件即违规。
- 共享层 `dependencies` 为空；渠道包只依赖 `@modelmux/gateway`。
- 落点由共享层按 `cid` 推导，渠道不许自己拼路径。
- 调用渠道模块前必须包 `runInChannel(cid, …)`（AsyncLocalStorage 上下文）。
- 分层由 `scripts/verify-layering.mjs` 强制，例外在 `ALLOWLIST` 声明理由。

完整契约见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md)。

## 命令

```sh
npm install        # npm workspaces
npm run build      # tsc -b + esbuild cli + copy-ui
npm test           # build + typecheck + 全部 verify:* + 全部包测试
npm run typecheck  # 全工作区类型检查（含 UI）
npm run gate       # 推送门禁：干净 clone → npm ci → npm test
```

CLI 命令形态：`mx <动词> [<cid>]`（动词优先，对齐 git/docker/kubectl）。`mx <cid> <动词>` 不采用。
仓库级动词（`start/stop/restart/serve/web`）不接受 cid。完整命令手册见 `mx-cli` 技能，
设计见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §9。

网关只监听 `127.0.0.1:4412`，Web 控制台与网关共用该端口，挂在 `/web`。`mx web` = 确保网关在跑 → 打印 `/web/` 地址（禁止自动打开浏览器，用户自行复制打开）。
`ChannelConfig.defaultAddr` 只在单渠道独立运行时生效。

构建：根 `tsconfig.json` 是 solution（`files: []` + `references`），`tsc -b` 调度整个依赖图。
`packages/ui` 不在 solution references 里，但 `npm test` 链覆盖其 typecheck。
完整构建模型见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 分支与 PR

`main` 有分支保护，禁止直推。大规模改动判定（命中任一即开分支）：
- 跨 `packages/` 两个及以上包
- 目录结构 / 包边界 / workspaces / tsconfig references 调整
- 契约变更（`docs/CONTRACT-TS.md` / `docs/STORAGE-CONVENTION.md` / `docs/POOL-ARCHITECTURE.md`）
- 对外 API 或模型 id 形态变更
- 预计改动 >20 个文件

小改动先本地 commit 攒着，攒够一批再走 PR。**推送门禁由 `.githooks/pre-push` 自动执行**
（`npm install` 经 `prepare` 接线），跑不过就拦下推送，不需要手动跑；禁止 `--no-verify`。
真正不可绕过的是 CI —— `main` 有分支保护，合并前双检查必须绿。
PR 用 rebase 合并，禁止 merge commit。
完整分支流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 和 `git-workflow` 技能。

## 代码约定

- 对外模型 id 形态 `<cid>/<规范模型名>`（恒小写，渠道内去重，跨渠道不合并）。裸模型名 400。
- 注释：what 去文档（协议事实只活在 `docs/channels/<cid>/PROTOCOL.md`），why 跟函数（docstring）。
  文件头 ≤12 行：一句话职责 + 关键约束 ≤3 条 + 指针。细则见 [docs/MODULE-COMMENTS.md](docs/MODULE-COMMENTS.md)
  和 [docs/CODE-COMMENTS.md](docs/CODE-COMMENTS.md)。
- catch 块不空吞异常；空 catch 必须注释说明原因。
- `@ts-ignore` / `@ts-expect-error` 同行写理由。禁止 `any` 图省事。
- Web 控制台：正文信息不依赖 hover；图表数据详情例外（自绘浮层，`pointer-events-none`）。原生 `title=` 禁用。
  交互铁律见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)。

## 测试

- 渠道不写测试，只做端到端（`opencode-mx-test` 技能）。契约见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §7。
- 临时探测脚本落 `.tmp/`，保留复用。禁止虚构凭证与请求头——虚构载荷撞上游风控。
- 测试模型选最低倍率，禁止高倍率旗舰（`*-pro` / `*-max` / `kimi-k3` 等）。
- 禁止占用或杀掉 4412 网关；独立实例用 `--addr` 其他端口。
- 已知隐患：`--test-force-exit` 会静默丢结果；怀疑漏跑时按 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「测试已知隐患」手工复跑。
- 端到端只发正确形态请求；归一化管线覆盖由代码审查核验，不靠运行时发错误载荷。
- Web/UI 改动必须浏览器视觉校验（6 项量化核对，不接受「已检查，正常」）。

完整测试规则与红线见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 改动后执行顺序

改动 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后：
1. `npm run build`
2. `node packages/cli/dist/cli.js restart`
3. `mx status --json` 确认 `stale_build: false`
4. 涉及 login/cred/upstream 时走一轮真机验证

禁止跳过 restart、禁止在陈旧构建时宣称生效。
以上三步可用一条 `npm run after-change` 完成（`scripts/after-change.mjs`，stale 即非零退出）。
实现见 `packages/core/gateway/src/app/lifecycle/stale-build.ts`，事故记录见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §8。

## 文档

- `.md` 只允许在 `docs/`、仓库根（`README.md` / `AGENTS.md`）、`packages/core/channels/<cid>/AGENTS.md`、`.agents/skills/`。
  渠道文档落 `docs/channels/<cid>/PROTOCOL.md`；渠道目录不留 `README.md`。
- 新增 `docs/*.md` 登记到 `docs/README.md`；新增技能登记到 `docs/README.md` 和仓库根 `README.md`。
- 逆向研究代码不入库；结论落 `docs/channels/<cid>/`，标注证据等级。参考实现 clone 到
  `packages/core/channels/<cid>/reference/`（`--depth 1`），由渠道 `.gitignore` 忽略。
- 文档只写当前设计；历史进 git / PR，设计取舍进设计依据文档。分层、事实归属、写作规则与审稿清单见
  [docs/AGENTS.md](docs/AGENTS.md)。
- `scripts/verify-docs.mjs` 和 `scripts/verify-storage.mjs` 在 `npm test` 里强制。

## 推送与发版

推送门禁由 `pre-push` 钩子自动执行（细节见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「推送门禁」）。
文档与代码同一个 commit。发版 = 打 tag，不建 GitHub Release。
版本号 `0.1.x` 连续递增不跳号。tag 打在合并后的 main 上。
大面积功能或重构后提醒主人发版，不擅自操作。
完整发版流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 和 `git-workflow` 技能。

提交信息 `type(scope): 中文描述`，`type` 额外允许 `merge`。`scripts/verify-commits.mjs` 在 `npm test` 里校验。