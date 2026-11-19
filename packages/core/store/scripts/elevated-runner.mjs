/**
 * 受限令牌子进程里跑 store 测试：收集 node --test 的输出与退出码，写回 marker 文件
 * 给父进程（run-tests.mjs）—— runas 没有句柄回传，marker 是唯一通道。
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [marker] = process.argv.slice(2);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const chunks = [];
const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-timeout=120000", join(root, "tests", "*.test.ts")], {
  cwd: root,
});
child.stdout.on("data", (c) => chunks.push(c));
child.stderr.on("data", (c) => chunks.push(c));
child.on("error", (err) => {
  writeFileSync(marker, JSON.stringify({ code: 1, out: String(err) }));
});
child.on("exit", (code) => {
  writeFileSync(marker, JSON.stringify({ code, out: Buffer.concat(chunks).toString("utf8") }));
});
