/**
 * 仓库级渠道清单：**唯一** import 全部渠道模块的地方。
 *
 * 各渠道包（目录 `packages/core/channels/<cid>/`，包名 `@modelmux/<cid>`）的 `index.ts` 在模块
 * 加载时 `setChannel()`（副作用），故这里只要把渠道包各 import 一遍，注册表里就有
 * 全部渠道。共享包本身不 import 任何渠道（见 `@modelmux/gateway` 的 `channel.ts`），
 * 所以这一层必须独立存在。
 *
 * 新增渠道：在这里加一行 import（外加仓库根 `workspaces`）。
 * 下架渠道：去掉 import 并登记进 `RETIRED_CIDS`（包与文档保留作参考实现）——
 * 目录 == 注册 ∪ 下架 由 `packages/cli/tests/pool.test.ts` 与 `verify-contract` 机械校验。
 */

import "@modelmux/astudio";
import "@modelmux/autoclaw";
import "@modelmux/catpaw";
import "@modelmux/codebuddycn";
import "@modelmux/codearts";
import "@modelmux/lobsterai";
import "@modelmux/loomy";
import "@modelmux/qoder";
import "@modelmux/qodercn";
import "@modelmux/qwenworkcn";
import "@modelmux/raccoon";
import "@modelmux/todayai";
import "@modelmux/traecn";
import "@modelmux/workbuddy";
import "@modelmux/workbuddyai";

/**
 * 已下架渠道：包保留作参考实现，不再注册。
 *
 * 当前为空 —— **目录里有几个渠道就注册几个**。保留这个导出而不是删掉：
 * 它是 `packages/cli/tests/pool.test.ts` 与 `scripts/verify-contract.mjs` 的机械校验锚点
 * （目录 == 注册 ∪ 下架），将来真要下架某个渠道时不必重新发明这套断言。
 */
export const RETIRED_CIDS: string[] = [];
