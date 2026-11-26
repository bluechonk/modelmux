/**
 * Web 命令分发：把前端 `/web/api/commands` 的 action 翻译到共享服务函数上。
 *
 * 独立模式下进程就在手边，直接调函数，不走进程外 CLI 探测。
 * 所有 handler 输出 JSON 对象（不是 `console.log`），与 CLI 的进程退出码语义解耦。
 *
 * **登录的触发经 `WebCommandDeps.triggerLogin` 注入**，不在本层 import app 层的
 * `headless`（那会造成 http → app 的层级违例，见 `scripts/verify-layering.mjs`）。
 * 调用方（headless 的 bridge）负责提供实现。
 */

import { channelCapabilities, channels, getChannel, hasChannel, type Channel } from "../../runtime/channel.js";
import { runInChannel } from "../../runtime/channel-context.js";
import { poolCandidates, poolModels } from "../../pool/pool-targets.js";
import { isPrefsModel, loadModelPrefs, setPreferredChannel } from "../../pool/model-prefs.js";
import * as poolUsage from "../../pool/pool-usage.js";
import {
  estimatedRemainOf,
  ledgerSnapshot,
  refreshBilling,
  sortChannelsByUsage,
} from "../../pool/pool-usage.js";
import { listAccounts, activateAccount, clearAccountState, removeAccount, syncPool } from "../../runtime/account-pool.js";
import {
  API_KEY_NAME_MAX,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  regenerateApiKey,
  revealApiKeyPlain,
  updateApiKey,
} from "../../runtime/api-key-store.js";
import { signinTodaySnapshot, type ClaimToday } from "../../auth/signin-ledger.js";
import { disabledChannelSet, setChannelEnabled } from "../../runtime/user-settings.js";
import { renderChannelPool } from "./web-types.js";
import type {
  WebChannelSignin,
  WebCommandBody,
  WebCommandResult,
  WebChannelStatus,
  WebSigninView,
} from "./web-types.js";

/**
 * 命令分发的外部依赖（由调用方注入）。
 *
 * `triggerLogin` 省略时登录动作返回「未就绪」——纯 API 形态的网关不挂控制台，
 * 自然也没有交互式登录可用。
 */
export interface WebCommandDeps {
  /** 触发某渠道的交互式登录（浏览器授权等）。实现方负责异步执行与错误上报。 */
  triggerLogin?: (cid: string, force: boolean) => void;
  /**
   * 提交用户粘回的回调链接（一次性授权 code 的兜底通道）。
   *
   * 回调页线上是 404（微信只校验 `redirect_uri` 域名、官方客户端在内嵌窗口里
   * 拦跳转），所以没有浏览器的进程只能靠用户把地址栏那条链接粘回来。
   */
  submitCallback?: (raw: string) => void;
  /**
   * 提交用户在登录弹窗里输入的内容（渠道两步登录用，如 loomy 的短信验证码）。
   *
   * 与 `submitCallback` 同构：控制台层不认识登录流程，只把字符串转交上去。
   */
  submitInput?: (value: string) => void;
  /** 用户关掉了登录弹窗：不再等两步登录的输入（见 `ControlBridge.cancelInput`）。 */
  cancelInput?: () => void;
}

export type WebCommandHandler = (body: WebCommandBody) => Promise<WebCommandResult>;

/**
 * 命令分权限类：**正向白名单**。
 *
 * 只有列在 `PUBLIC_ACTIONS` 里的命令允许任意来源调用；其余一律要求本机直连
 * （路由层按 socket 远端地址判定后把 `admin` 放进 body）。
 * 为什么正向：`ADMIN_ACTIONS` 反向名单在新增命令时默认放行 —— 加一个改全局状态的
 * action 忘了登记就是漏洞；正向名单忘登记只会「新命令暂时只允许本机」，
 * 报错可见、不会静默泄露。
 *
 * 公共面 = 只读查询 + 与单次请求/单渠道登录交互相关的动作；凡是能改全局配置、
 * 账号池、API key、渠道开关的，都不在此列。
 */
const PUBLIC_ACTIONS = new Set([
  // 只读视图
  "status",
  "billing",
  "accounts",
  "modelChannels",
  "checkUpdate",
  "apiKeys",
  // 交互式登录流（本机浏览器授权 / 粘贴回调 / 验证码 / 取消）
  "login",
  "pasteCallback",
  "submitInput",
  "cancelInput",
  // 一键接入 / 还原不在此列：它们改写本机客户端配置（~/.zcode），
  // 必须走 admin 判定（socket 回环）。控制台本就来自本机浏览器，admin 恒真，
  // 移出零成本；而一旦网关被绑到非回环地址，免鉴权远程写就是真缺口。
]);

/** /api/commands 的统一入口。 */
export function createWebCommandHandler(deps: WebCommandDeps = {}): WebCommandHandler {
  return async (body) => {
    const { action, cid, args = {} } = body;
    try {
      // 非公共命令（= 改全局配置 / 账号池 / API key / 渠道开关）只允许本机直连
      if (!PUBLIC_ACTIONS.has(action) && body.admin !== true) {
        return err("该命令仅允许本机直连调用");
      }
      switch (action) {
        case "login": {
          if (cid === undefined || !hasChannel(cid)) {
            return err("参数 cid 必须是已注册渠道");
          }
          const force = typeof args["force"] === "boolean" ? args["force"] : false;
          return handleLogin(cid, force, deps);
        }
      case "status": {
        const list = cid !== undefined && hasChannel(cid) ? [getChannel(cid)] : channels();
        const rows: WebChannelStatus[] = list.map((channel) => {
          const cidInner = channel.config.cid;
          let present = false;
          try {
            runInChannel(cidInner, () => channel.cred.load());
            present = true;
          } catch {
            present = false;
          }
          return { cid: cidInner, display: channel.upstream.DISPLAY_NAME, present };
        });
        return ok({ channels: rows });
      }
      case "billing": {
        // args.refresh = true 时先重查一遍各渠道账单（前端「刷新」按钮用），
        // 失败不阻塞快照返回 —— 快照里带 billing_at/billing_ok 供前端标注新鲜度。
        if (args["refresh"] === true) {
          await refreshBilling((m: string) => {
            /* 静默：结果以快照为准 */
          });
        }
        const now = Date.now();
        const wanted = cid !== undefined && hasChannel(cid) ? [getChannel(cid)] : channels();
        const wantedSet = new Set(wanted.map((channel) => channel.config.cid));
        const ledger = ledgerSnapshot();
        const rows = poolModels()
          .map((model) => ({
            model,
            candidates: poolCandidates(model)
              .filter((candidate) => wantedSet.has(candidate.cid))
              .map((candidate) => {
                const entry = ledger.channels[candidate.cid];
                return {
                  cid: candidate.cid,
                  display: candidate.channel.upstream.DISPLAY_NAME,
                  exposed_id: candidate.exposedId,
                  used: entry?.used ?? 0,
                  unit: entry?.unit ?? "",
                  cooling: (entry?.cooldown_until ?? 0) > now,
                  billing_at: entry?.billing_at ?? null,
                  billing_ok: entry?.billing_ok ?? false,
                  unsupported: !channelCapabilities(candidate.channel.config).billing,
                  // 额度周期（渠道声明；没声明就 null，前端回落到通用说明）
                  quota: candidate.channel.billing.quotaPeriod?.() ?? null,
                  ok: entry?.ok ?? 0,
                  fail: entry?.fail ?? 0,
                  // 渠道 × 账号拆分：每个账号的 ok / fail 计数与额度快照
                  accounts: accountRowsOf(entry?.accounts),
                };
              }),
          }))
          .filter((row) => row.candidates.length > 0);
        // 不在模型池里的渠道也要有账单行：上游目录没有家族模型的渠道
        // （进不了统一池），但它的额度照样要出现在账号池页 —— 账单行以**渠道**为主维度，
        // 池内有没有模型是另一件事。（此前缺这段：这类渠道恒无 candidates → 前端额度恒 0。）
        const seen = new Set(rows.flatMap((row) => row.candidates.map((c) => c.cid)));
        for (const channel of wanted) {
          const chanCid = channel.config.cid;
          if (seen.has(chanCid) || !channelCapabilities(channel.config).billing) continue;
          const entry = ledger.channels[chanCid];
          if (!entry) continue;
          rows.push({
            model: "",
            candidates: [
              {
                cid: chanCid,
                display: channel.upstream.DISPLAY_NAME,
                exposed_id: "",
                used: entry.used,
                unit: entry.unit,
                cooling: (entry.cooldown_until ?? 0) > now,
                billing_at: entry.billing_at ?? null,
                billing_ok: entry.billing_ok ?? false,
                unsupported: false,
                quota: channel.billing.quotaPeriod?.() ?? null,
                ok: entry.ok,
                fail: entry.fail,
                accounts: accountRowsOf(entry.accounts),
              },
            ],
          });
        }
        return ok({ rows, models: poolModels() });
      }
      case "accounts": {
        // 显式指定 cid 时照常返回（诊断入口）；列表模式只列启用的渠道 ——
        // 设置弹窗关闭的渠道在这里消失，账号池卡片随之隐藏。
        // 关闭集合循环外取一次：逐渠道 isChannelEnabled 是逐渠道同步读盘
        const disabled = disabledChannelSet();
        const targets =
          cid !== undefined && hasChannel(cid)
            ? [getChannel(cid)]
            : channels().filter((channel) => !disabled.has(channel.config.cid));
        if (targets.length === 0) return err("没有渠道被注册");
        const pools = targets.map((channel) => {
          const poolCid = channel.config.cid;
          runInChannel(poolCid, () => syncPool(poolCid));
          const index = runInChannel(poolCid, () => listAccounts(poolCid));
          return renderChannelPool(
            channel.config.cid,
            channel.upstream.DISPLAY_NAME,
            index,
            signinViewOf(poolCid, channel),
          );
        });
        // 展示顺序：用得多在前，同频按 cid（UI 只渲染这个顺序，不自己排）
        return ok({ channels: sortChannelsByUsage(pools as Array<{ cid: string }>) });
      }
      // —— API key 管理（新建 / 删除 / 改名 / 重建明文）——
      case "apiKeys": {
        // **白名单**显式取字段，不用 `...rest` 剔除：黑名单对新增字段默认放行 ——
        // 旧版明文 `secret` 正是这样漏出去的（keyring 不可用时迁移被跳过，明文留在
        // 记录上，剔除名单里没有它，于是随列表一起下发）。
        //
        // 四个字段即 `ApiKeyRecord` 的全部可下发面，与 UI 的 `ApiKeyRow` 一一对应：
        // id / name / prefix / createdAt。`keyHash` / `secretSealed` / 旧版 `secret`
        // 都不出这个函数。完整明文走需显式调用的 `revealApiKey`，不做批量下发。
        return ok({
          keys: listApiKeys().map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            createdAt: k.createdAt,
          })),
        });
      }
      case "revealApiKey": {
        const id = typeof args["id"] === "string" ? args["id"] : "";
        if (id === "") return err("参数 id 必填");
        const plain = revealApiKeyPlain(id);
        if (plain === null) return err("该 key 的明文不可用，请重建后再试");
        return ok({ id, plain });
      }
      case "regenerateApiKey": {
        const id = typeof args["id"] === "string" ? args["id"] : "";
        if (id === "") return err("参数 id 必填");
        const rebuilt = regenerateApiKey(id);
        if (rebuilt === null) return err("key 不存在");
        const { keyHash: _hash, secretSealed: _sealed, ...shown } = rebuilt.record;
        return ok({ key: shown, plain: rebuilt.plain });
      }
      case "createApiKey": {
        const name = typeof args["name"] === "string" ? args["name"] : "";
        if (name.trim() === "") return err("参数 name 必填");
        if (name.trim().length > API_KEY_NAME_MAX) return err(`参数 name 最长 ${API_KEY_NAME_MAX} 字`);
        const { record, plain } = createApiKey({ name });
        const { keyHash: _hash, secretSealed: _sealed, ...shown } = record;
        // plain 只在这里出现一次，前端必须当场展示并提示保存
        return ok({ key: shown, plain });
      }
      case "updateApiKey": {
        const id = typeof args["id"] === "string" ? args["id"] : "";
        if (id === "") return err("参数 id 必填");
        const patch: { name?: string } = {};
        if (typeof args["name"] === "string") {
          if (args["name"].trim().length > API_KEY_NAME_MAX) return err(`参数 name 最长 ${API_KEY_NAME_MAX} 字`);
          patch.name = args["name"];
        }
        const rec = updateApiKey(id, patch);
        if (rec === null) return err("key 不存在");
        const { keyHash: _hash, secretSealed: _sealed, ...shown } = rec;
        return ok({ key: shown });
      }
      case "deleteApiKey": {
        const id = typeof args["id"] === "string" ? args["id"] : "";
        if (id === "") return err("参数 id 必填");
        return deleteApiKey(id) ? ok({ id }) : err("key 不存在");
      }
      case "setChannelEnabled": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        const enabled = args["enabled"];
        if (typeof enabled !== "boolean") return err("参数 enabled 必须是布尔值");
        setChannelEnabled(cid, enabled);
        return ok({ cid, enabled });
      }
      case "activateAccount": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        const key = typeof args["key"] === "string" ? args["key"] : "";
        if (!key) return err("参数 key 必填");
        const account = runInChannel(cid, () => activateAccount(key, cid));
        return ok({ active: account.key });
      }
      case "resetAccount": {
        // 「解除」：清掉连败熔断（error）或额度冷却（cooldown），把账号放回可用状态。
        // 与 activateAccount 的区别：**不动凭证**，所以池里任何账号都能清（不只是生效那个）。
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        const key = typeof args["key"] === "string" ? args["key"] : "";
        if (!key) return err("参数 key 必填");
        const result = runInChannel(cid, () => clearAccountState(key, cid));
        if (!result.cleared) {
          // 没改状态也要如实说明为什么（账号不在池里 / 凭据失效需重登 / 本来就没标记）
          return { ok: false, error: result.reason ?? "该账号没有需要解除的标记", data: { key, health: result.health } };
        }
        return ok({ key, health: result.health });
      }
      case "removeAccount": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        const key = typeof args["key"] === "string" ? args["key"] : "";
        if (!key) return err("参数 key 必填");
        const result = runInChannel(cid, () => removeAccount(key, cid));
        if (!result.removed) return err(`账号 ${key} 不在 ${cid} 的池子里`);
        return ok({ removed: key, was_active: result.wasActive });
      }
      case "syncPool": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        runInChannel(cid, () => syncPool(cid));
        return ok({});
      }
      case "modelChannels": {
        // 每个对外模型的候选渠道 + 当前偏好（下拉的选项与选中项都来自这里）。
        // 只渲染 deepseek 族：glm / qwen 供给已收窄到唯一渠道，无偏好语义。
        return ok({
          models: poolModels()
            .filter((model) => isPrefsModel(model))
            .map((model) => ({
              model,
              channels: poolCandidates(model).map((candidate) => candidate.cid),
              preferred: loadModelPrefs()[model] ?? null,
            })),
        });
      }
      case "setModelChannel": {
        const model = typeof args["model"] === "string" ? args["model"] : "";
        const preferred = typeof args["cid"] === "string" && args["cid"] !== "" ? args["cid"] : null;
        if (model === "") return err("参数 model 必填");
        try {
          setPreferredChannel(model, preferred);
        } catch (e) {
          return err(String(e));
        }
        return ok({ model, preferred });
      }
      case "pasteCallback": {
        // 兜底路径：回调页线上是 404，code 只在用户浏览器地址栏里。
        // 长轮询拿不到时，由用户把那条链接粘回来完成登录。
        const raw = typeof args["url"] === "string" ? args["url"] : "";
        if (!raw.trim()) return err("参数 url 必填（粘贴浏览器地址栏里的回调链接）");
        if (!deps.submitCallback) {
          return err("当前运行形态不支持粘贴回调链接（未注入 submitCallback）");
        }
        deps.submitCallback(raw);
        return ok({ submitted: true, message: "已收到回调链接，登录流程将继续" });
      }
      case "submitInput": {
        // 两步登录（如 loomy 短信验证码）：渠道通过 `requestInput` 要输入，
        // 界面拿到 `state.login_input` 后把用户填的内容走这个动作交回去。
        const value = typeof args["value"] === "string" ? args["value"] : "";
        if (!value.trim()) return err("参数 value 必填（用户在登录弹窗里输入的内容）");
        if (!deps.submitInput) {
          return err("当前运行形态不支持登录输入（未注入 submitInput）");
        }
        deps.submitInput(value);
        return ok({ submitted: true, message: "已收到输入，登录流程将继续" });
      }
      case "cancelInput": {
        // 弹窗关了：让等待输入的渠道立刻收尾，而不是挂到 10 分钟超时。
        if (!deps.cancelInput) {
          return err("当前运行形态不支持取消登录输入（未注入 cancelInput）");
        }
        deps.cancelInput();
        return ok({ cancelled: true, message: "已取消登录输入" });
      }
      case "checkUpdate": {
        // 手动检查更新（设置页按钮）：忽略每日节流，失败如实上报
        const [{ VERSION }, { forceCheckForUpdate }] = await Promise.all([
          import("../../version.js"),
          import("../../runtime/update-check.js"),
        ]);
        const result = await forceCheckForUpdate(VERSION, () => {});
        if (!result.ok) return err(result.error ?? "检查更新失败");
        return ok({
          available: result.available,
          version: result.version,
          url: result.url,
          checkedAt: result.checkedAt,
        });
      }
      default:
        return err(`未知 action: ${String(action)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
  };
}

/**
 * 账本里的账号条目 → 控制台的账号额度行。
 *
 * `estimated_remain` 是「上次账单值 − 按 usage 累加的消耗」：**展示用估算**，
 * 不可扣减（单位不一致 / 无增量）时为 `null`，前端回落到真实账单值。
 * `tier` 是后台调度算出的刷新档位（active / idle / paused），排障时能看出
 * 「为什么这个账号额度一分钟一更、另一个三分钟一更」。
 */
function accountRowsOf(
  accounts: Record<string, poolUsage.AccountCount> | undefined,
): Array<Record<string, unknown>> {
  return Object.entries(accounts ?? {}).map(([key, count]) => ({
    key,
    ok: count.ok,
    fail: count.fail,
    credits: count.credits ?? null,
    billing_at: count.billing_at ?? null,
    billing_ok: count.billing_ok ?? false,
    // 当日基线（当天首个 bill 的 remain）：前端拿它当 100% 分母
    baseline: count.baseline ?? null,
    // 估算余额（真实值 − 累计消耗增量）；null = 不可扣减
    estimated_remain: estimatedRemainOf(count.credits, count.spent),
    // 消费档位（active / idle / paused）与上次成功转发时刻
    tier: count.billing_tier ?? null,
    last_ok_at: count.last_ok_at ?? null,
  }));
}

/**
 * 渠道的签到视图（渠道能力 + 本地台账）。
 *
 * **只读本地台账**（`<root>/channels/<cid>/state/signin.json`，旧布局回落 `<root>/<cid>/`），
 * 不查上游：账号池页是 15 秒一轮的高频页面，让它去打各渠道的上游签到端点既慢又会留下
 * 无谓的上游痕迹 —— 与 `mx status` 同一取舍（见 daemon.ts 的签到段）。上游的权威答案
 * 仍归渠道 billing（`mx <cid> checkin`）。
 *
 * `per_account` 由渠道声明（`signin.perAccount`）：为 true 时账号行读账号级记录，
 * 否则整条渠道共用一个「今天领过」—— 这类渠道的 `claim()` 只作用于生效凭证。
 *
 * 「今天」的口径收敛在 `signin-ledger.signinTodaySnapshot`（与 `claimedTodayPerLedger` /
 * `claimedTodayForAccount` 同一个日切入口）—— 控制台与自动签到各自算一遍的话，
 * 机器换过时区后界面会说「已签到」而调度器认为「未签」并再领一次。
 */
function signinViewOf(cid: string, channel: Channel): WebSigninView {
  // 契约要求每个渠道都给 `signin`。真缺了（契约违例 / 测试桩）时按**能力不可用**处理：
  // 报 supported=true 会让前端永久显示「未签到（渠道）」，把「没有这项能力」说成「今天没签」
  const module = channel.billing.signin as { perAccount?: boolean } | undefined;
  const supported = channelCapabilities(channel.config).signin && module !== undefined;
  const perAccount = supported && module.perAccount === true;
  const snapshot = signinTodaySnapshot(cid);
  const viewOf = (entry: ClaimToday): Omit<WebChannelSignin, "supported" | "per_account"> => ({
    claimed_today: entry.claimed,
    at: entry.at,
    reward: entry.reward,
    reward_source: entry.source,
    probe: entry.probe === null ? null : {
      claimable: entry.probe.claimable,
      claimed_today: entry.probe.claimed_today,
      summary: entry.probe.summary,
      at: entry.probe.at,
    },
  });
  const accounts: WebSigninView["accounts"] = {};
  if (perAccount) {
    for (const [key, entry] of Object.entries(snapshot.accounts)) accounts[key] = viewOf(entry);
  }
  return {
    channel: {
      supported,
      per_account: perAccount,
      ...viewOf(snapshot.channel),
    },
    accounts,
  };
}

/** login：经注入的回调触发渠道的登录流程（浏览器授权）。 */
function handleLogin(cid: string, force: boolean, deps: WebCommandDeps): WebCommandResult {
  // 登录本质是交互流程（弹浏览器/扫码等）；HTTP handler 只触发它并把控制权交还用户
  // ——真实完成态通过 `GET /web/api/state` 的 auth_url 轮询呈现。
  if (!deps.triggerLogin) {
    return err("当前运行形态不支持交互式登录（未注入 triggerLogin）");
  }
  // 回调实现方负责异步执行（可能阻塞几十秒）；这里立即返回，等 /web/api/state 轮询。
  setImmediate(() => {
    try {
      deps.triggerLogin!(cid, force);
    } catch {
      // 登录失败会反映在后续 /web/api/state 的 auth_url 或 gateway_error 上
    }
  });
  return ok({ started: true, message: "登录流程已启动，授权链接通过 /web/api/state 的 auth_url 轮询" });
}

function ok(data: Record<string, unknown>): WebCommandResult {
  return { ok: true, data };
}

function err(message: string): WebCommandResult {
  return { ok: false, error: message };
}
