# 豆包工作桌面端解包结论

> 对象：Windows 安装版 `DoubaoWork 2.36.11`（`channel=1001`）。
> 本文记录应用结构、资源格式与 URL 解包结果；渠道协议见 [PROTOCOL.md](./PROTOCOL.md)。

## 1. 应用定位

DoubaoWork 是豆包工作（Doubao Work）的 Windows 桌面客户端，安装目录为
`%LOCALAPPDATA%\DoubaoWork\Application\app`。它由以下部分组成：

| 组成 | 证据 |
| --- | --- |
| Chromium 浏览器壳 | `DoubaoWork.exe`、`resources.pak`、`locales\*.pak`、`icudtl.dat`、`libEGL.dll` / `libGLESv2.dll` |
| 自研主模块 | `DoubaoWork.dll`（约 314 MiB） |
| 飞书/Lark 文档与协作能力 | `liblark.dll`（约 180 MiB）、`liblark_resource_encrypt.dll`、`local_webcontents\apps\doubao-office` |
| 本地 Web 应用 | `local_webcontents\apps`、`local_webcontents\biz`、`local_webcontents\extensions\ai-views` |
| 工作任务与 Skill 运行时 | `task-mode-resource\runtime-bundle`，包含 Node、PowerShell、Python 包和 110 个 `.tar.zst` Skill/工具包 |
| 音视频与远程能力 | `VolcEngineRTC.dll`、`RTCFFmpeg.dll`、`audioeffect.dll`、`cloud-desktop` |

它不是 Electron `app.asar` 应用。资源主体是自研 Chromium 壳加 Chromium DataPack。
`manifest.json` 中的 `productName` 为 `DoubaoWork`，`version` 为 `2.36.11`，
`commitId` 为 `b20c09edb6b16c3a3f1dc97b8119064ccb980273`。

## 2. 解包范围与方法

扫描根目录：

`%LOCALAPPDATA%\DoubaoWork\Application\app`

覆盖范围：

- 文本资源：`.js`、`.json`、`.html`、`.css`、`.xml`、`.py`、`.lua`、`.md`、`.txt`、`.yml`、`.config` 等。
- Chromium DataPack v5：`resources.pak`、`biz.pak`、`doubao_office.pak`，按资源表逐条读取，并对压缩条目尝试 Brotli 解压。
- 压缩运行时包：`task-mode-resource\runtime-bundle\packages\*.tar.zst`，使用 Node 内置 zstd 解压后遍历 tar 条目。
- 原生二进制：`.dll`、`.exe`、`.dat`、`.model`，按可打印 ASCII 串和 UTF-16LE 串扫描。
- 模板拼接：还原 JS 中以常量基址加模板变量组成的 API 路径，补出未以字面量出现的端点。
- 其他本地 Web 资源：SVG、WASM、加密配置、着色器、模型配置等。

扫描脚本保留在 `.tmp/`：

- `.tmp/scan-all-doubaowork.mjs`
- `.tmp/parse-doubao-pak.mjs`
- `.tmp/scan-doubaowork-supplement.mjs`
- `.tmp/finalize-doubaowork-urls.mjs`
- `.tmp/clean-doubaowork-business.mjs`
- `.tmp/derive-doubaowork-template-paths.mjs`

## 3. 结果统计

| 项目 | 数量 |
| --- | ---: |
| 扫描文件 | 3828 |
| 补扫文件 | 3839 |
| DataPack 有效资源条目 | 24679 |
| 去重绝对 URL | 9702 |
| 业务相关 URL（豆包 / 飞书 Lark / 字节） | 1626 |
| 清洗后的业务 URL | 1568 |
| 去重路径条目 | 10580 |
| 可信 API 路径（排除静态资源） | 4021 |

绝对 URL 分类：

| 分类 | 数量 |
| --- | ---: |
| 第三方开发依赖 | 3221 |
| 其他 | 3155 |
| Google | 1011 |
| 豆包 | 783 |
| 标准组织 | 689 |
| 飞书 / Lark | 614 |
| 字节 / 火山 | 229 |

业务 URL 的主要主机包括：

- `www.doubao.com`
- `accounts.doubao.com`
- `api-normal.doubao.com`
- `lf-flow-web-cdn.doubao.com`
- `feishu.doubao.com`
- `www.feishu.cn`
- `open.feishu.cn`
- `accounts.feishu.cn`
- `applink.feishu.cn`
- `www.larksuite.com`
- `bytedance.larkoffice.com`
- `lf3-static.bytednsdoc.com`

完整清单落盘位置：

- `.tmp/doubaowork-all-urls.txt`：全部去重 URL 及分类。
- `.tmp/doubaowork-business-urls.txt`：豆包 / 飞书 Lark / 字节 URL。
- `.tmp/doubaowork-business-urls-clean.txt`：排除示例域名、XML 命名空间和占位符后的业务 URL。
- `.tmp/doubaowork-all-paths.txt`：全部路径条目。
- `.tmp/doubaowork-api-paths.txt`：排除静态文件后的 API 路径。
- `.tmp/doubaowork-final.json`：包含来源文件的完整结构化结果。

## 4. 关键业务端点

桌面资源中可直接定位到以下登录、会话、模型、对话与额度端点：

| 用途 | 路径 |
| --- | --- |
| 手机号发码 | `/passport/web/send_code/` |
| 短信登录 | `/passport/web/sms_login/` |
| 仅短信登录 | `/passport/web/sms_login_only/` |
| 账号信息 | `/passport/account/info/v2/` |
| OAuth token | `/passport/web/auth/get_oauth_token/` |
| Biz 授权 | `/passport/user/biz_auth/` |
| 会话安全心跳 | `/passport/doubao/security_token_beat/` |
| Token 心跳 | `/passport/token/beat/web/` |
| 账号启动 | `/alice/user/launch` |
| 模型菜单 | `/alice/slot/action_bar_v3/brief_list` |
| 对话 | `/chat/completion` |
| Samantha 对话 | `/samantha/chat/completion` |
| 订阅额度 | `/alice/commerce/sale/subscription/quota/summary/` |
| 订阅概览 | `/alice/commerce/sale/subscription/overview/` |
| Token 上传 | `/alice/user/act_update` |

## 5. `assr` 结论

精确搜索 `(?<![A-Za-z0-9])assr(?![A-Za-z0-9])`、`.assr` 和 `app.asar`，
在安装资源中没有命中。

`DoubaoWork.dll` 中出现的 `assR` 均为普通字符串子串，例如
`ClassRegExp`、`ClassRange`、`PassRequest`、`UnpackedPtr`，不是独立的
`.assr` 资源容器。`liblark_resource_encrypt.dll` 确实包含资源加解密能力，
但当前安装目录没有独立的 `.assr` 文件。

因此，桌面端的 URL 来源不是某个 `assr` 文件，而是：

- Chromium DataPack；
- `local_webcontents` 下的本地 Web 资源；
- `DoubaoWork.dll` 与 `liblark.dll` 内嵌字符串；
- `task-mode-resource` 的 zstd/tar 运行时包。

## 6. 边界

- 清单是静态可提取 URL 的并集。运行时动态拼接的 URL、服务端下发且未落盘的 URL、加密资源中无法离线解密的字符串，不在静态清单内。
- 第三方依赖文档、示例域名和 XML 命名空间会产生大量非业务 URL；业务清单已单独剥离。
- 本地清单保留在 `.tmp/`，不提交进仓库，避免把数 MB 数据与第三方文档链接固化进版本历史。

## 7. HTTP 探测脚本

协议链路的纯 HTTP 探针（零浏览器、零客户端）留在 `.tmp/`（已忽略、保留复用）：

| 脚本 | 用途 |
| --- | --- |
| `.tmp/probe-doubao-cookie.mjs` | 登录前抓匿名 cookie（`ttwid` / `bd_mount_l-singer` 等） |
| `.tmp/probe-doubao-2step.mjs` | 发码 → 收 stdin 验证码 → 校验登录（两跳） |
| `.tmp/probe-doubao-files.mjs` | 登录后批量打真实接口（账号信息 / 模型菜单 / 额度 / 对话） |

抓包方法（mitmproxy）与排查清单见 [PROTOCOL.md](./PROTOCOL.md) §8。
