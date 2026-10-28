/**
 * 命令行入口：`serve`/`login`（运行）+ `start`/`stop`/`restart`/`status`/`models`/`credits`/`logs`（管理）。
 *
 * 管理类子命令不依赖网关进程，直接操作守护进程与本地文件；
 * 运行类子命令（serve/login）走 headless。
 *
 * 本文件是共享层：调用方（各渠道包的 `src/cli.ts`）必须**先注册渠道**，
 * 再调用 `main()`。故这里不再自带「直接运行本文件」的入口判断。
 */

import { parseArgs } from "node:util";

import { channelCount, channels, getChannel, hasChannel } from "../../runtime/channel.js";
import { CHANNEL_VERBS, isChannelVerb, runVerb } from "./channel.js";
import * as groups from "./model.js";
import { defaultAddr, defaultUiPort, version } from "../../runtime/cli-consts.js";
import * as daemon from "../lifecycle/daemon.js";
import * as headless from "../lifecycle/headless.js";
import { runWeb } from "../lifecycle/web.js";
import * as supervisor from "../lifecycle/supervisor.js";

/**
 * 生成当前渠道的帮助文本。
 *
 * 设计取向：**一眼能看懂** —— 命令按用途分组、每行「用法 + 一句话」，
 * 选项按命令归类（而不是平铺 25 条），示例只留最常用的几条。
 * 实现细节（落点、协议、账本口径）一律不进帮助，见 docs/CONTRACT-TS.md。
 */
export function usage(): string {
  const single = channelCount() === 1;
  // 仓库级入口的 bin 有 `modelmux` / `mx` 两个名字，帮助里统一用短名 `mx`。
  const bin = single ? getChannel().config.cid : "mx";
  const display = single ? getChannel().config.display : "多渠道路由（模型池）";
  // 帮助里的示例渠道取**注册表里的第一个**（动态取值）——
  // 共享层不硬编码任何渠道 id（渠道知识只允许出现在各渠道包内）。
  const cid = single ? bin : (channels()[0]?.config.cid ?? "<cid>");
  const pad = (s: string): string => s.padEnd(34);

  // 动词按分组渲染：模型组先给池视图两条，再给渠道级 `model <cid>`。
  const groupLines = (group: "模型" | "渠道"): string[] => {
    const lines: string[] = [];
    if (group === "模型") {
      lines.push("  " + pad("model list") + "池视图：模型 → 候选渠道 + 已用量 + 冷却");
      lines.push("  " + pad("model usage [--refresh]") + "池账本；--refresh 立刻重查额度");
      lines.push("  " + pad("model spec <模型名>") + "查看模型的规格（窗口/输出/档位/倍率/模态）");
    }
    for (const v of CHANNEL_VERBS) {
      if (v.group === group) lines.push("  " + pad(v.usage) + v.summary);
    }
    return lines;
  };

  return `${bin} — ${display} · OpenAI 兼容网关

用法: ${bin} <动词> [<cid>] [参数]     <cid> 写在动词之后

网关:
  ${pad("start | stop | restart")}守护式启停（幂等）
  ${pad("serve")}前台运行（调试用）
  ${pad("web")}打开 Web 控制台

模型:
${groupLines("模型").join("\n")}

渠道:
${groupLines("渠道").join("\n")}

选项（按命令）:
  通用    --json 输出 JSON | --quiet 静默 | --addr <host:port> 监听地址（默认 ${defaultAddr()}）
  model   --refresh 强制重拉目录 / 重查账单
  log     --kind <名> access|error|system|lifecycle|worker|channel
         --outcome <名> success|failure|other（--kind access）  --date <YYYY-MM-DD>
         --lines <n> 行数（默认 40）  -f, --follow 持续输出  --list 列出日志文件
  login   --realm <名> 登录域（单域渠道忽略）  --wechat 微信扫码
  start   --force 已在跑也重启  --wait <s> 健康等待秒数（默认 30）
  serve   --ensure-login 未登录时引导  --force-login 忽略凭据重登
         --verbose 打印每个上游请求  --no-console 不起控制台 API
  path    --all 全部渠道  --workspace <dir> 工作区根
  其它    --ui-port <port> 控制台端口  --auto 受 auto_start 约束
         --strict 启动失败非零退出
         help | version 显示帮助 / 版本（-h --help / -v --version）

示例:
  ${bin} start                起网关
  ${bin} model list           看池视图
  ${bin} login ${cid}         登录 ${cid}
  ${bin} bill ${cid}          看 ${cid} 额度
  ${bin} status ${cid} --json 结构化状态（脚本用）
`;
}

/** 打印版本：`<入口名> <版本>（N 个渠道；node vX）`。 */
function printVersion(): void {
  const label = channelCount() === 1 ? getChannel().config.cid : "mx";
  console.log(`${label} ${version()}（${channelCount()} 个渠道；node ${process.version}）`);
}

type RawValues = Record<string, string | boolean | undefined>;

interface ParsedArgs {
  values: RawValues;
  positionals: string[];
}

/**
 * 取字符串选项。
 *
 * `parseArgs({strict:false})` 的值类型是 `string | boolean | undefined`，
 * 故这里做一次收窄；布尔形态（用户写 `--addr` 不带值）按缺省处理。
 */
function strOpt(values: RawValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

/** 取布尔选项。 */
function boolOpt(values: RawValues, key: string): boolean {
  return values[key] === true;
}

/** 取数值选项（无法解析时返回 undefined，由调用方回落默认值）。 */
function numOpt(values: RawValues, key: string): number | undefined {
  const raw = strOpt(values, key);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      // 严格模式：未知选项（含已移除的 `--cname` / `--channel` / `-c`）直接报错。
      // 否则 parseArgs 会把未知长选项当布尔吃下、把它的值丢成位置参数 —— 用户以为
      // 指定了渠道，实际拿到的是「全部渠道」，静默做错事。
      strict: true,
      options: {
        addr: { type: "string" },
        "ui-port": { type: "string" },
        wait: { type: "string" },
        lines: { type: "string" },
        kind: { type: "string" },
        outcome: { type: "string" },
        date: { type: "string" },
        list: { type: "boolean" },
        realm: { type: "string" },
        workspace: { type: "string" },
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        auto: { type: "boolean" },
        all: { type: "boolean" },
        force: { type: "boolean" },
        refresh: { type: "boolean" },
        wechat: { type: "boolean" },
        strict: { type: "boolean" },
        "ensure-login": { type: "boolean" },
        "force-login": { type: "boolean" },
        verbose: { type: "boolean" },
        "no-console": { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        open: { type: "boolean" },
        "no-open": { type: "boolean" },
        // supervise（内部命令）的落点参数 —— 由 `start` 以显式路径下发
        "worker-pid": { type: "string" },
        log: { type: "string" },
        cwd: { type: "string" },
        follow: { type: "boolean", short: "f" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }) as ParsedArgs;
  } catch (err) {
    console.error(`参数错误: ${String(err)}`);
    console.error(usage());
    return 2;
  }

  const o = parsed.values;
  if (boolOpt(o, "help")) {
    console.log(usage());
    return 0;
  }
  if (boolOpt(o, "version")) {
    printVersion();
    return 0;
  }

  const positionals = parsed.positionals;
  const command = positionals[0] ?? "serve";
  const addr = strOpt(o, "addr") ?? defaultAddr();
  const uiPort = numOpt(o, "ui-port") ?? defaultUiPort();

  const logOutcomeRaw = strOpt(o, "outcome");
  const logOutcome =
    logOutcomeRaw === "success" || logOutcomeRaw === "failure" || logOutcomeRaw === "other"
      ? logOutcomeRaw
      : undefined;
  const logKind = strOpt(o, "kind");
  const logDate = strOpt(o, "date");
  const ctx: groups.CommandContext = {
    json: boolOpt(o, "json"),
    quiet: boolOpt(o, "quiet"),
    addr,
    uiPort,
    realm: strOpt(o, "realm") ?? "auto",
    force: boolOpt(o, "force"),
    refresh: boolOpt(o, "refresh"),
    wechat: boolOpt(o, "wechat"),
    lines: numOpt(o, "lines") ?? 40,
    all: boolOpt(o, "all"),
    follow: boolOpt(o, "follow"),
    ...(logKind !== undefined ? { logKind } : {}),
    ...(logOutcome !== undefined ? { logOutcome } : {}),
    ...(logDate !== undefined ? { logDate } : {}),
    logList: boolOpt(o, "list"),
    ...(strOpt(o, "workspace") !== undefined ? { workspace: strOpt(o, "workspace")! } : {}),
  };

  // 常见惯例：`help` / `version` 作为子命令也认（等价 -h/--help、-v/--version）
  if (command === "help") {
    console.log(usage());
    return 0;
  }
  if (command === "version") {
    printVersion();
    return 0;
  }

  // ① 分组：`model list` / `model usage`
  // `model <cid>` 也是渠道动词（查看某渠道的模型列表）—— positionals[0] 是 command "model" 自身，
  // 所以要看 positionals[1] 是否为已注册渠道名
  if (command === "model") {
    const first = positionals[1];
    if (first === undefined || !hasChannel(first)) {
      return groups.runModelGroup(positionals.slice(1), ctx);
    }
    return runVerb("model", positionals.slice(1), ctx);
  }
  // ② 渠道动词：`mx <动词> [<cid>] [参数]`（cid 在动词之后）
  if (isChannelVerb(command)) {
    return runVerb(command, positionals.slice(1), ctx);
  }

  // ③ 仓库级动词（不带 <cid>）
  switch (command) {
    case "web":
      return runWeb({
        host: strOpt(o, "host") || undefined,
        port: numOpt(o, "port") ?? undefined,
        open: boolOpt(o, "open") && !boolOpt(o, "no-open"),
      });

    case "serve":
      return headless.runServe({
        addr,
        verbose: boolOpt(o, "verbose"),
        ensureLogin: boolOpt(o, "ensure-login"),
        forceLogin: boolOpt(o, "force-login"),
        json: boolOpt(o, "json"),
        consoleEnabled: !boolOpt(o, "no-console"),
        realm: strOpt(o, "realm") ?? "auto",
      });

    case "start":
      return daemon.start({
        addr,
        uiPort,
        waitMs: numOpt(o, "wait") !== undefined ? numOpt(o, "wait")! * 1000 : undefined,
        quiet: boolOpt(o, "quiet"),
        auto: boolOpt(o, "auto"),
        force: boolOpt(o, "force"),
        strict: boolOpt(o, "strict"),
      });

    case "supervise":
      // 内部命令（由 `start` spawn；藏而不删，同 `serve` 待遇，不走帮助）
      return supervisor.runSupervise({
        addr,
        uiPort,
        workerPid: strOpt(o, "worker-pid") ?? "",
        log: strOpt(o, "log") ?? "",
        cwd: strOpt(o, "cwd") ?? process.cwd(),
      });

    case "stop":
      return daemon.stop({
        quiet: boolOpt(o, "quiet"),
      });

    case "restart":
      return daemon.restart({
        addr,
        uiPort,
        waitMs: numOpt(o, "wait") !== undefined ? numOpt(o, "wait")! * 1000 : undefined,
        quiet: boolOpt(o, "quiet"),
        strict: boolOpt(o, "strict"),
      });

    default:
      // 旧语法 `mx <cid> <动词>` 的指路：渠道名现在写在动词之后。
      if (hasChannel(command)) {
        console.error(
          `未知命令: ${command}（新语法把渠道写在动词之后：\`mx <动词> ${command}\`，如 \`mx login ${command}\`）`,
        );
      } else {
        console.error(`未知命令: ${command}`);
      }
      console.error(usage());
      return 2;
  }
}
