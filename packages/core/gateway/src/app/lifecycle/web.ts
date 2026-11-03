/**
 * `mx web` 实现：**单端口模式** —— 确保网关在跑，然后给出 Web 控制台地址。
 *
 * 控制台不再起独立进程/端口：UI 挂载在网关的 `/web` 前缀下（见 `REPO_UI_PREFIX`），
 * 控制台 API 位于 `/web/api/*`。因此 Web 页面看到的状态永远来自真实网关进程。
 */

import { REPO_DEFAULT_ADDR, REPO_UI_PREFIX } from "../../runtime/cli-consts.js";
import * as daemon from "./daemon.js";

export interface WebOptions {
  host?: string;
  port?: number;
  quiet?: boolean;
}

export async function runWeb(options: WebOptions = {}): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number.parseInt(REPO_DEFAULT_ADDR.split(":")[1] ?? "4412", 10);
  const addr = `${host}:${port}`;
  const url = `http://${addr}${REPO_UI_PREFIX}/`;

  // 复用 `start` 的幂等语义：未跑则拉起（受 auto_start 约束），已跑则直接返回。
  //
  // **网关起没起来都照样把地址给出来**：`mx web` 的职责是「给一个能访问的控制台地址」，
  //   不是「保证网关健康」—— 未登录、worker 启动失败、健康检查超时都可能发生，
  //   而页面本身会显示控制台自己的骨架与状态，比让命令直接失败有用得多（2026-10-29 起）。
  await daemon.start({ addr, quiet: options.quiet ?? false, auto: false });

  // 不自动打开浏览器（CONTRACT-TS §6 全仓约定）：地址交给用户复制 / Ctrl+点击。
  console.log(`[web] ${url}`);
  return 0;
}
