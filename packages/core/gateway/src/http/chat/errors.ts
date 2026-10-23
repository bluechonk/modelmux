/**
 * 网关应答与错误分类：JSON 应答、错误信封、上游额度耗尽判定。
 *
 * 关键约束：
 *   - 错误信封固定为 `{"error":{"type","code","message"}}`
 *   - 额度耗尽要与普通 4xx 分开：后者（参数、内容）是请求级问题，前者换账号也会失败
 *
 * 铁律：上游错误正文只进本地日志，不回传客户端。
 */

import type { ServerResponse } from "node:http";

import { noteRequestError } from "../../runtime/log-store.js";

/** 统一 JSON 应答（`/health`、`/v1/models` 等）。 */
export function writeJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 错误响应 JSON 结构：`{"error":{"type","code","message"}}`。 */
export function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  noteRequestError(res, code, message);
  writeJson(res, { error: { type: "error", code, message } }, status);
}

/**
 * 上游响应体是否表示**额度耗尽 / 用量超限**（不是请求参数/内容错误）。
 *
 * 额度类错误必须与普通 4xx 区分：后者（模型参数、tool 消息序列等）是请求级问题，
 * 换账号也会失败；前者继续打同一个账号只会重复失败，应把账号**冷却**起来。
 *
 * ⚠ 词表来自实测，别凭感觉加：
 * - `insufficient_quota` / `insufficient_points` / 「积分余额不足」—— loomy 实测（HTTP 402）；
 * - `code:6004` + `usage exceeds frequency limit` —— workbuddyai 实测（HTTP 429，2026-10-23
 *   真机拿到原文：「usage exceeds frequency limit, but don't worry, your usage will reset at
 *   2026-10-23 17:36:25 UTC+8」）。此前词表不认这句，6004 被当成普通 502 放过、账号不冷却。
 */
export function isQuotaExhausted(body: string): boolean {
  if (!body) return false;
  return /insufficient_points|insufficient_quota|quota[_ -]?exceeded|credit[s]?[_ -]?(exhausted|insufficient)|余额不足|积分不足|额度不足|配额不足|超出配额|免费额度已用完|额度已用完|升级套餐|usage[_ ]exceeds|frequency[_ ]limit|频率限制|code["'\s:=]{1,4}6004\b/i.test(body);
}

/**
 * 是否为**账户级用量限额**（区别于「余额不足」）。
 *
 * 为什么要分：workbuddyai 的 `6004` 是**账号用量限额**（`usage exceeds frequency limit`），
 * 它对**所有模型**生效 —— 包括我们目录里标成倍率 0 的模型（实测：倍率 0 的
 * `deepseek-v4.1-flash` 一样吃 6004）。而 loomy 的 `insufficient_quota`（余额不足）
 * 主要影响计费用量。所以：**账户级限额 → 冷却与模型倍率无关**；余额类 → 只冷却付费模型
 * （免费模型不消耗额度，让它去打上游拿真实结论）。
 */
export function isUsageLimit(body: string): boolean {
  if (!body) return false;
  return /frequency[_ ]limit|usage[_ ]exceeds|频率限制|code["'\s:=]{1,4}6004\b/i.test(body);
}
