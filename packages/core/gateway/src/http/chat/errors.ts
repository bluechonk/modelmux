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
 * 上游响应体是否表示**额度耗尽**（不是请求参数/内容错误）。
 *
 * 额度类错误必须与普通 4xx 区分：后者（模型参数、tool 消息序列等）是请求级问题，
 * 换账号也会失败；前者继续打同一个账号只会重复失败，应直接把账号标不可用。
 */
export function isQuotaExhausted(body: string): boolean {
  if (!body) return false;
  return /insufficient_points|insufficient_quota|quota[_ -]?exceeded|credit[s]?[_ -]?(exhausted|insufficient)|余额不足|积分不足|额度不足|配额不足|超出配额|免费额度已用完|额度已用完|升级套餐/i.test(body);
}
