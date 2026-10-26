/**
 * 上游鉴权链路：短路失效凭据、刷新 token、原账号重试、鉴权失败归类。
 *
 * 关键约束：
 *   - 只处理鉴权类失败（401/403、刷新失败）；上游 5xx / 网络错误照旧直接报错
 *   - 鉴权失败**不自动切号**：账号切换一律由用户手动完成
 *   - 刷新失败不在本层记账：一次失败只由上层记一次（两处都记会算成两次连败）
 *
 * 铁律：失败后保留凭据并如实报错，不替用户决定换哪个账号。
 */

import { type Channel, type Credential } from "../../runtime/channel.js";
import { activeAccountCooldown, activeAccountIsError, markActiveHealth } from "../../runtime/account-pool.js";
import { logThrottled } from "../../runtime/logger.js";
import { inChannel } from "./channel.js";
import { openStream, type UpstreamCall } from "./upstream.js";

/** 取上游流式响应的结果；把"调不动上游"的几种情形分开，好给出准确的错误语义。 */

export type UpstreamOutcome =
  | { kind: "ok"; call: UpstreamCall }
  | { kind: "not_authenticated"; error: string }
  | { kind: "auth_exhausted"; error: string }
  /** 账号仍在额度冷却窗口内：本地短路，未打上游。**不是**鉴权失败，不记账连败。 */
  | { kind: "cooling"; until: string; reason: string }
  /** 账号已被标 `error`（终态，再记连败只会虚增数字）：调用方**不记账**。 */
  | { kind: "account_error"; error: string };

/**
 * 向上游发起请求，鉴权失败时**不自动切换池内账号**。
 *
 * 账号切换一律由用户手动完成（`mx acct <cid> use <key>` / Web 账号池）：自动切号会
 * 让请求在用户不知情时落到另一个账号上（额度、配额、IP 风控各算一份），排障时也
 * 看不出究竟是哪个账号在服务。故这里只做「刷新 token → 重试一次」，失败就标记
 * 当前账号不可用并如实报错，下一步交给用户。
 *
 * 只在**鉴权类**失败（401/403、刷新失败）时处理；上游 5xx / 网络错误照旧直接报错。
 */

export async function callUpstream(
  channel: Channel,
  sendBody: Buffer,
  logger: (m: string) => void,
  options: { freeModel?: boolean } = {},
): Promise<UpstreamOutcome> {
  const cid = channel.config.cid;
  const { cred } = channel;

  // 连续失败被标记 error 的凭据：直接短路，不再对上游发起请求（凭证保留，等用户处理）。
  // ⚠ 这是**真故障**（凭据坏了），连免费模型也救不了，故不区分模型。
  // ⚠ **不记账**：error 已是终态，短路再累加连败只会把 fail_streak 刷成无意义的大数
  //   （2026-10-24 实测 11 次 not_authenticated 把它刷到 11）。
  if (activeAccountIsError(cid)) {
    return {
      kind: "account_error",
      error: `active account is marked error after repeated failures; switch account (mx acct use) or re-login (mx login ${cid})`,
    };
  }

  // 额度耗尽的**冷却**只挡付费模型：倍率 0 的模型不吃额度，冷却期必须照常可路由
  //（2026-10-23 实测：loomy 冷却后连免费模型 spark-x 都被锁死）。
  //
  // ⚠ 必须用独立的 `cooling` 类别，**不能**混进 `not_authenticated`：那个分支在
  // `attempt.ts` 里会记连败，冷却期内每来一个请求就 +1，3 次就把账号打成 `error`
  //（2026-10-24 实测 workbuddy：11 次短路 = fail_streak 11，从此免费模型也锁死且无自动恢复）。
  if (options.freeModel !== true) {
    const cooling = activeAccountCooldown(cid);
    if (cooling) {
      return { kind: "cooling", until: cooling.until, reason: cooling.reason };
    }
  }

  let credential: Credential;
  try {
    credential = inChannel(channel, () => cred.load());
  } catch (err) {
    return { kind: "not_authenticated", error: String(err) };
  }

  let call = await inChannel(channel, () => openStream(channel, credential, sendBody));
  if (!call.ok && call.connectFailed) {
    // 连接从未建立（请求没发出去），重试一次即可自愈网络抖动
    logger(`upstream connect failed, retrying once: ${String(call.error)}`);
    call = await inChannel(channel, () => openStream(channel, credential, sendBody));
  }
  if (call.ok || (call.status !== 401 && call.status !== 403)) return { kind: "ok", call };

  // 401/403：先刷新当前账号的 token，刷成则原账号重试一次（仍是同一个账号）
  logThrottled(logger, `chat:auth-rejected:${cid}`, `[${cid}] token rejected, trying refresh${call.error ? ` (${call.error.message})` : ""}`);
  try {
    const refreshed = await inChannel(channel, () => cred.refresh(credential));
    const retry = await inChannel(channel, () => openStream(channel, refreshed, sendBody));
    if (retry.ok || (retry.status !== 401 && retry.status !== 403)) return { kind: "ok", call: retry };
  } catch (err) {
    // ⚠ 这里**不记账**：本次失败会由上层 `handleChat` 的 `auth_exhausted` 分支统一记一次。
    // 两处都记会让「一次鉴权失败」算成两次连败 → 两次请求就打到 FAIL_STREAK_LIMIT，
    // 账号被提前标成 `error`（下次直接短路，连上游都不打）。
    logger(`refresh failed: ${String(err)}`);
  }

  // 当前账号确定不可用：标健康度（后续请求由 `activeAccountIsError` 短路），但**不自动切号**
  markActiveHealth("unauthorized", cid);
  logger(
    `auth failed (${cid}): token rejected by upstream and refresh unusable; ` +
      `credentials kept, switch account manually (\`mx acct ${cid} use <key>\`) or \`mx login ${cid}\``,
  );
  return {
    kind: "auth_exhausted",
    error: `the current account's token was rejected; switch account (mx acct ${cid} use <key>) or log in again`,
  };
}
