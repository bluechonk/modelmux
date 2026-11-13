# Marvis 逆向分析报告

> 对象：`C:\Users\bluechonk\Desktop\Marvis.lnk` → `C:\Program Files\Tencent\Marvis`
> 分析日期：2026-11-12

## 1. 这是什么应用

**腾讯「Marvis」—— AI 办公助手桌面客户端**（应用宝 / yybadaccess 体系分发）。

快捷方式指向 `MarvisLauncher.exe --from "2" --launch-proc-name "Marvis.exe"`。

### 组成

| 子应用 | 版本 | 形态 | 作用 |
| --- | --- | --- | --- |
| `Application` | 1.60.3400.35 | **Electron**（`app.asar` + `chrome_*.pak`） | 主 UI（246MB 主程序） |
| `MarvisHost` | 1.60.3400.56 | 原生 exe + `wss_plugin.dll` | 宿主 / WebSocket 服务 |
| `MarvisAgent` | 1.60.3400.795 | **Python**（`python311.dll` + `_internal`） | AI Agent 运行时，含 `mcp_server` / `prompts` |
| `BorderlessSpace` | 1.60.3200.18 | 原生 | 无边框窗口空间 |
| `DocPreview` | 1.0.0.10 | 原生 | 文档预览 |
| `WmpfRuntime` | 1.60.3300.7 | 微信小程序运行时 | 跑小程序 |

### 关键判据

- **主 UI 是 Electron**：有 `resources/app.asar`、`chrome_100_percent.pak`、`snapshot_blob.bin`。
- **核心逻辑是 V8 字节码**：`out/main/index.cjsc`（3.4MB）、各 `*.cjsc`，用 `bytecode-loader.cjs` 加载。
  直接读 `.cjs` 只有 `require("./index.cjsc")` 一行。
- **但有 105MB 可读前端包**：`resources/offline-pack/main/assets/*.js` —— 未被字节码化，
  业务 API 路径全部从这里提取。
- **Agent 是 Python**：`MarvisAgent/_internal` 下有完整 Python 包与 `mcp_server`。

## 2. 数据规模

| 项目 | 数量 |
| --- | ---: |
| 扫描文件 | 7809 |
| 跳过（非文本/超大） | 16438 |
| 去重 URL | 8945 |
| 其中业务 URL（腾讯/微信体系） | 238 |
| 业务主机 | 93 |
| 可读 API 路径（offline-pack） | 64 |

## 3. 核心域名

### 3.1 登录 / 鉴权（最关键）

```
yybadaccess.3g.qq.com                    ← 应用宝统一鉴权（生产）
yybadaccess.sparta.html5.qq.com          ← 同上（另一环境）
yybadaccesstest.3g.qq.com                ← 测试环境
```

端点：

```
/marvis_client_login/marvis_oauth            ← Marvis OAuth 登录
/marvis_client_login/marvis_ioa_oauth        ← 企业版 IOA 登录
/marvis_client_login_test/marvis_oauth       ← 测试环境
/v3/marvis_intelli_boot_cond                 ← 启动条件
/v3/marvis_get_install_source                ← 安装来源
/v3/marvis_get_component_info                ← 组件信息
/v3/marvis_report_task                       ← 任务上报
```

### 3.2 Marvis 业务

```
marvis.qq.com                    ← 主站
marvis.qq.com/s/                 ← 分享页
static.marvis.qq.com             ← 静态资源
down.marvis.qq.com/ping          ← 存活探测
marvis-client.yyb.qq.com/client/config/prod/marvis-win.config.json  ← 客户端配置（服务端下发）
```

### 3.3 微信 / 小程序

```
open.weixin.qq.com          ← 微信开放平台
mp.weixin.qq.com            ← 公众号
channels.weixin.qq.com      ← 视频号
liteapp.weixin.qq.com       ← 小程序
xweb.weixin.qq.com          ← XWeb 内核
ilinkai.weixin.qq.com       ← 微信 AI
novac2c.cdn.weixin.qq.com   ← CDN
```

### 3.4 遥测 / 监控

```
galileotelemetry.tencent.com
rmonitor.qq.com / t.rmonitor.qq.com
pro.bugly.qq.com / cloud.bugly.qq.com
otheve.beacon.qq.com
sdkreport.e.qq.com
```

### 3.5 其它

```
yuanbao.tencent.com     ← 腾讯元宝
docs.qq.com / doc.weixin.qq.com   ← 腾讯文档
work.weixin.qq.com      ← 企业微信
apis.map.qq.com         ← 腾讯地图
api.start.qq.com / apigw.start.qq.com  ← START 云游戏
```

## 4. 业务 API 路径（offline-pack 提取，64 条）

### 4.1 账号 / 登录

```
/v3/marvis_query_bind_status
/v3/marvis_ioa_login_query
/v3/marvis_ioa_2_fa
/v3/marvis_ioa_2_fa_verify
/v3/get_pc_wx_ticket
/v3/marvis_invitecode_verify
/marvis/marvis_feedback_new
```

### 4.2 技能 / 案例市场

```
/v3/skill_operate
/v3/marvis_get_skill_cases
/v3/marvis_get_skill_case_types
/v3/marvis_get_skill_case_detail
/v3/marvis_skill_case_comment
/v3/marvis_skill_case_comment_list
/v3/marvis_skill_case_comment_like
/v3/marvis_skill_case_comment_delete
/v3/marvis_publish_skill_case
/v3/marvis_save_skill_case_use_record
```

### 4.3 定时任务 / 自动化

```
/v3/marvis_scheduled_task_template
/v3/marvis_scheduled_task_aigc
```

### 4.4 消息 / 系统

```
/v3/marvis_get_system_message_list
/v3/marvis_system_message_read
/v3/marvis_get_share_info
```

### 4.5 工具 / MCP / 模型

```
/v3/marvis_get_tool_tab_list
/v3/marvis_get_rec_mcps
/v3/marvis_list_custom_llm_provider
/v3/marvis_list_agent_token_stats
/v3/marvis_capabilities
/v3/marvis_mock_model
```

### 4.6 安全 / 权限

```
/v3/security_policy_manage
/v3/marvis_handle_approval
```

### 4.7 云盘 / 订阅

```
/v3/marvis_remove_cloud_drive_subcribers
/v3/marvis_subscribe_knowledge
/v3/marvis_order_list_page
/v3/marvis_activity
```

## 5. 架构判断

```
┌─────────────────────────────────────────┐
│ Electron 主进程（V8 字节码 .cjsc）      │
│   out/main/index.cjsc (3.4MB)           │
└──────────┬──────────────────────────────┘
           │
     ┌─────┴──────┬──────────────┐
     ▼            ▼              ▼
┌─────────┐  ┌─────────┐   ┌──────────────┐
│offline- │  │Marvis   │   │MarvisAgent   │
│pack(JS) │  │Host.exe │   │(Python)      │
│105MB    │  │WSS 插件 │   │mcp_server    │
└────┬────┘  └────┬────┘   └──────┬───────┘
     │            │               │
     └────────────┴───────────────┘
                  │
                  ▼
        yybadaccess.3g.qq.com
        （应用宝统一鉴权 + /v3/marvis_* 业务）
```

关键点：

- **登录走应用宝体系**：`marvis_oauth` / `marvis_ioa_oauth`，与企业微信 IOA 打通。
- **Agent 本地跑 Python**：`MarvisAgent` 自带 Python 3.11 与 MCP server，工具执行在本地。
- **主窗口加载地址可配置**：客户端配置由 `marvis-client.yyb.qq.com/client/config/prod/marvis-win.config.json`
  下发，主 UI 是本地 `offline-pack` 的 Vite 构建产物。

> 注意：`marvis_launch_load_url` / `marvis_launch_process_start` 是**启动耗时埋点的阶段名**，
> 不是 API 端点（源码上下文是 `phases.find(u => u.key === "marvis_launch_load_url")` 取时间戳）。
> 早期把它误当端点，已纠正。

## 6. 方法与边界

### 方法

1. 解析 `.lnk` 取目标 → 定位安装根
2. 判形态（Electron vs CEF vs 原生）
3. 解 `app.asar` 文件树 → 发现核心是 `.cjsc` 字节码
4. 找到 `offline-pack`（未被字节码化）→ 提取全部 API 路径
5. 全目录扫描（ASCII + UTF-16LE 字符串）→ 提取 URL，按主机聚合
6. 按业务关键词（qq / tencent / marvis / weixin）过滤噪声

### 边界

- `.cjsc` 是 V8 字节码，静态读不出主进程逻辑；需运行时 dump 或 CDP 才能看内部调用。
- 扫描含第三方依赖文档（github.com 2725 条、crates.io 189 条等），已按主机分离。
- 服务端下发的 URL（`marvis_launch_load_url`）不在静态清单内。
- 部分 URL 有扫描噪声（拼接残留如 `;`、`)`、`failed`），清洗后 238 条。

### 落盘

| 文件 | 内容 |
| --- | --- |
| `marvis-urls.txt` | 全部 8945 条去重 URL + 来源文件 |
| `marvis-by-host.json` | 按主机聚合（含每个 URL 的来源） |
| `marvis-biz-clean.txt` | 清洗后的 238 条业务 URL |
| `offline-paths.txt` | offline-pack 提取的 64 条 API 路径 |
| `offline-endpoints.txt` | endpoint 名（marvis_* 等） |
