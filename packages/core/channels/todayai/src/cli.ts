/**
 * Today 渠道 CLI 入口（bin 指向 dist/cli.js）。
 *
 * 两个职责：
 *   - `task` 子命令：跑 agent 长任务（建任务 → 轮询 → 取回答），实现走 upstream.ts。
 *     任务在服务端沙箱异步执行，长任务不受本进程超时限制；产物要留存必须让 agent
 *     写 `storage://agent`（沙箱 /tmp 每轮重置）。端点/字段/实测见 PROTOCOL.md §10.7。
 *   - 其余命令：注册本渠道（`./channel.js` 的副作用）→ 交给共享 CLI。
 *
 * 端点/字段/实测见 docs/channels/todayai/PROTOCOL.md。
 */

import "./channel.js"; // 副作用：setChannel(本渠道)
import { main } from "@modelmux/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";
import type { Credentials } from "./cred.js";
import type { CanonicalMessage } from "./upstream.js";

/** `task` 子命令：`cli.js task "<指令>" [--rounds N] [--interval 秒]`。 */
async function runTaskCli(args: string[]): Promise<number> {
  let rounds = 60;
  let intervalSec = 10;
  const instructionParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--rounds") {
      i += 1;
      rounds = Number(args[i]);
    } else if (args[i] === "--interval") {
      i += 1;
      intervalSec = Number(args[i]);
    } else {
      const arg = args[i];
      if (arg !== undefined) instructionParts.push(arg);
    }
  }
  const instruction = instructionParts.join(" ").trim();
  if (!instruction) {
    console.error('用法: cli.js task "<指令>" [--rounds 轮数] [--interval 轮询间隔秒]');
    return 1;
  }

  let credential: Credentials;
  try {
    credential = cred.load();
  } catch {
    console.error("未登录：先跑 `node dist/cli.js login` 授权（手机号 + 短信验证码）");
    return 1;
  }
  await upstream.refreshIfExpired(credential);
  await cred.save(credential);

  const printMessages = (messages: CanonicalMessage[]): void => {
    for (const m of messages) {
      console.log(`--- [${m.role ?? "?"}] ${(m.createdAt ?? "").slice(11, 19)} state=${m.state ?? "-"}`);
      const text = upstream.messageTextOf(m);
      if (text) console.log(text.split("\n").map((l) => `  ${l}`).join("\n"));
    }
  };

  console.log("建任务并轮询（Ctrl+C 中止不影响服务端任务继续执行）…");
  const result = await upstream.runTask(credential, instruction, {
    pollIntervalMs: intervalSec * 1000,
    maxRounds: rounds,
    onMessages: printMessages,
  });
  console.log(`\n== 任务终态: ${result.state} (taskId ${result.taskId.slice(0, 8)}…) ==`);
  if (result.state !== "completed") {
    console.error("任务未正常完成（沙箱 /tmp 不跨轮持久化，产物要留存需让 agent 写 storage://agent）");
    return 1;
  }
  return 0;
}

const argv = process.argv.slice(2);
if (argv[0] === "task") {
  runTaskCli(argv.slice(1))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`[todayai] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
} else {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`[todayai] uncaught exception: ${String(err)}`);
      process.exitCode = 1;
    });
}
