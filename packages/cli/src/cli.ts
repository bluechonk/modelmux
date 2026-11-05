/**
 * 仓库级 CLI 入口（`bin` 指向 dist/cli.bundle.js，即本文件的打包产物）。
 *
 * 只做两件事：注册**全部**渠道（`./channels.js` 的副作用）→ 交给共享 CLI。
 * 命令实现全在 `@modelmux/gateway`。
 *
 * 与各渠道包自己的 CLI 的区别：注册的渠道数 > 1 → 进入**多渠道路由**，
 * `/v1/models` 只暴露池内模型，请求由网关按账本选渠道；
 * 单渠道的 CLI 仍是裸短名（兼容既有客户端配置）。
 */

import "./channels.js"; // 副作用：注册全部渠道
import { main, registerCustomProviders } from "@modelmux/gateway";

// 自定义提供商同样要注册（并把 key 同步进账号池）：否则 CLI 命令
// （`mx acct list` / `mx model list`）看不到这些渠道
registerCustomProviders();

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`[modelmux] uncaught exception: ${String(err)}`);
    process.exitCode = 1;
  });
