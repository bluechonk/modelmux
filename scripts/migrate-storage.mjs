#!/usr/bin/env node
/**
 * 存储布局迁移（手动入口）：把 `~/.modelmux/<cid>/`（0.1.0/0.1.1 的落点）搬进
 * `~/.modelmux/channels/<cid>/` 并在原位留**相对软链** —— 旧版本可执行文件经软链
 * 继续读写同一份数据，不复制、不分裂。
 *
 * 幂等：重复执行安全（已迁移 / 已在新布局的目录跳过）。
 * `mx start` / `mx restart` / `mx serve` 启动时也会自动触发同一迁移。
 *
 * 怎么跑：node scripts/migrate-storage.mjs
 * 依赖什么：dist 已构建（import packages/core/gateway/dist/runtime/storage-migrate.js）；
 *           遵循 `MODELMUX_HOME`（与网关/CLI 同一覆盖变量）。
 */
import { migrateLegacyChannelDirs } from "../packages/core/gateway/dist/runtime/storage-migrate.js";

const root = process.env["MODELMUX_HOME"] || `${process.env["HOME"]}/.modelmux`;
const result = migrateLegacyChannelDirs(root);

if (result.moved.length === 0 && result.skipped.length === 0) {
  console.log("[migrate] 存储根为空，无需迁移");
} else if (result.moved.length === 0) {
  console.log(`[migrate] 无需迁移（已迁移/跳过：${result.skipped.join(", ") || "无"}）`);
} else {
  console.log(`[migrate] 已迁入 channels/：${result.moved.join(", ")}`);
  if (result.skipped.length > 0) console.log(`[migrate] 跳过：${result.skipped.join(", ")}`);
  console.log("[migrate] 旧位置已留相对软链，0.1.0/0.1.1 可执行文件经它继续读写同一份数据");
}
