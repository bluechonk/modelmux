/**
 * 渠道动词：`mx <动词> [<cid>]` 的分发与实现（login / status / model / billing / accounts / …）。
 *
 * 从 `command-groups.ts` 拆出。共享的 `CommandContext`、目录工具与登录列表
 * 从 `./model-group.js` 取（单向依赖）。
 */

import { channels, getChannel, hasChannel } from "../../runtime/channel.js";
import { purgeCredentials } from "../../runtime/account-pool.js";
import { credentialsPath } from "../../runtime/paths.js";
import { runInChannel } from "../../runtime/channel-context.js";
import { existsSync } from "node:fs";

import * as accountCli from "./accounts.js";
import * as daemon from "../lifecycle/daemon.js";
import * as headless from "../lifecycle/headless.js";
import * as report from "./report.js";
import { CommandContext, listLocalModels, listLogins, runModelGroup } from "./model.js";

/** 渠道动词的说明项（帮助里按 group 分组展示）。 */
export interface ChannelVerb {
  /** 动词名。 */
  name: string;
  /** 帮助里的用法形态。 */
  usage: string;
  /** 一句话说明。 */
  summary: string;
  /** 帮助里的分组。 */
  group: "模型" | "渠道";
}

/**
 * 渠道动词表。
 *
 * `usage` / `summary` 面向**一眼能看懂**：用法形态与一句话说清，不写实现细节。
 */
export const CHANNEL_VERBS: readonly ChannelVerb[] = [
  { name: "status", usage: "status [<cid>]", summary: "状态（不带 = 全部渠道）", group: "渠道" },
  { name: "login", usage: "login <cid> | login list", summary: "登录（授权 URL 打到终端）", group: "渠道" },
  { name: "relogin", usage: "relogin <cid>", summary: "清凭据后重新授权", group: "渠道" },
  { name: "logout", usage: "logout <cid>", summary: "登出（销毁本地凭据 + 清空账号池）", group: "渠道" },
  { name: "model", usage: "model <cid> [--refresh]", summary: "某渠道的模型目录", group: "模型" },
  {
    name: "bill",
    usage: "bill [<cid>] [--accounts]",
    summary: "额度 / 账单（只读；--accounts 逐账号）",
    group: "渠道",
  },
  {
    name: "acct",
    usage: "acct <cid> list|use|add|remove",
    summary: "账号池（<key> 见 acct list）",
    group: "渠道",
  },
  { name: "path", usage: "path [<cid>]", summary: "存储落点（只读）", group: "渠道" },
  { name: "log", usage: "log [<cid>]", summary: "日志尾部（-f 持续输出）", group: "渠道" },
];

/** 目录的来源，决定 CLI 怎么向用户交代这次列的是哪份数据。 */

export function isChannelVerb(verb: string): boolean {
  return CHANNEL_VERBS.some((v) => v.name === verb);
}

/**
 * `mx <动词> [<cid>] [参数]`。
 *
 * cid 是动词后**第一个位置参数**（且必须是已注册渠道名）：给了就是「对某渠道」，
 * 不给则各动词回落到仓库级语义（status→聚合、billing→全部、paths→全部、
 * logs→网关日志）。`login` / `relogin` 不给 cid 只对
 * 单渠道入口有意义（多渠道路由下报错指路）。
 */

export async function runVerb(verb: string, args: string[], ctx: CommandContext): Promise<number> {
  const first = args[0];
  const cid = first !== undefined && hasChannel(first) ? first : undefined;
  const rest = cid !== undefined ? args.slice(1) : args;

  switch (verb) {
    case "status":
      return daemon.status({
        json: ctx.json,
        addr: ctx.addr,
        ...(cid !== undefined ? { cid } : {}),
      });
    case "bill":
      return daemon.credits({
        json: ctx.json,
        accounts: ctx.accounts,
        ...(cid !== undefined ? { cid } : {}),
      });
    case "path":
      return report.runPaths({
        json: ctx.json,
        all: ctx.all,
        ...(cid !== undefined ? { cid } : {}),
        ...(ctx.workspace !== undefined ? { workspace: ctx.workspace } : {}),
      });
    case "log": {
      if (ctx.logList) return daemon.listLogs(ctx.json);
      const filter: daemon.LogFilter = {
        ...(ctx.logKind !== undefined ? { kind: ctx.logKind } : {}),
        ...(ctx.logOutcome !== undefined ? { outcome: ctx.logOutcome } : {}),
        ...(ctx.logDate !== undefined ? { date: ctx.logDate } : {}),
      };
      return ctx.follow
        ? daemon.followLogs(ctx.lines, ctx.json, cid, filter)
        : daemon.logs(ctx.lines, ctx.json, cid, filter);
    }
    case "acct":
      return accountCli.runAccounts({
        json: ctx.json,
        realm: ctx.realm,
        force: ctx.force,
        verb: rest[0] ?? "list",
        ...(cid !== undefined ? { cid } : {}),
        ...(rest[1] !== undefined ? { target: rest[1] } : {}),
      });
    case "login":
      // `login list`：列出可登录渠道与状态（只读）
      if (cid === undefined && rest[0] === "list") return listLogins(ctx.json);
      return runLoginVerb(cid, ctx, false);
    case "relogin":
      return runLoginVerb(cid, ctx, true);
    case "logout":
      return runLogoutVerb(cid, ctx);
    case "model":
      return cid === undefined
        ? runModelGroup(rest, ctx)
        : listLocalModels(getChannel(cid), ctx.json, ctx.refresh);
    default:
      console.error(
        `未知动词: ${verb}\n` +
          `用法: mx <动词> [<cid>]；可用动词: ${CHANNEL_VERBS.map((v) => v.name).join(" / ")}`,
      );
      return 2;
  }
}

/** `login` / `relogin`：多渠道路由下必须给出 cid（单渠道入口可省）。 */

function runLoginVerb(cid: string | undefined, ctx: CommandContext, force: boolean): Promise<number> {
  const verb = force ? "relogin" : "login";
  if (cid === undefined && channelCountSafe() > 1) {
    console.error(
      `多渠道路由需要指定目标：\`mx ${verb} <cid>\`（可登录渠道用 \`mx login list\` 查看）。`,
    );
    return Promise.resolve(2);
  }
  return headless.runLogin({
    force,
    json: ctx.json,
    realm: ctx.realm,
    wechat: ctx.wechat,
    ...(cid !== undefined ? { cid } : {}),
  });
}

/** 已注册渠道数（用于多渠道路由判断）。 */

function channelCountSafe(): number {
  return channels().length;
}

/**
 * `logout`：**整渠道登出** —— 销毁本地凭据 + 清空池内账号。
 *
 * 与「删除池里某个账号」（`mx acct <cid> remove <key>`）的区别：
 * 那是摘掉一个条目，这是把整个渠道的登录态清掉。
 *
 * ⚠ 渠道若声明了 `cred.logout()`（目前只有 astudio），先调它做上游侧的销毁；
 * 渠道没声明就只做本地销毁（共享层契约里 `logout?` 是可选的）。
 */
async function runLogoutVerb(cid: string | undefined, ctx: CommandContext): Promise<number> {
  if (cid === undefined) {
    console.error("logout 需要指定目标：`mx logout <cid>`。");
    return 2;
  }
  const channel = getChannel(cid);
  const logout = channel.cred.logout;
  // ⚠ 先探凭据在不在：渠道的 `logout()`（如 astudio）会**先删掉** `credentials.json`，
  // 等 `purgeCredentials` 再探就永远是 false，汇报就成了「凭据本来就没有」。
  const hadCredential = runInChannel(cid, () => {
    try {
      return existsSync(credentialsPath(cid));
    } catch {
      return false;
    }
  });
  if (logout) {
    try {
      await runInChannel(cid, () => logout.call(channel.cred));
    } catch (err) {
      console.error(`[logout] 渠道侧登出失败：${String(err)}（本地凭据仍会清除）`);
    }
  }
  const result = runInChannel(cid, () => purgeCredentials(cid));
  if (ctx.json) {
    console.log(JSON.stringify({ event: "logout", cid, hadCredential, ...result }));
  } else {
    console.log(
      `[logout] ${cid}：已清 ${result.accounts} 个账号` +
        (hadCredential ? "，凭据已删除" : "，凭据本来就没有"),
    );
  }
  return 0;
}

