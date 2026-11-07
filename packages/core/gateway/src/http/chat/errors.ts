/**
 * 网关应答与错误分类：JSON 应答、错误信封、上游额度耗尽判定。
 *
 * 关键约束：
 *   - 错误信封固定为 `{"error":{"type","code","message"}}`
 *   - 额度耗尽要与普通 4xx 分开：后者（参数、内容）是请求级问题，前者换账号也会失败
 *   - 上游报错**透传**给客户端（旧口径「只进本地日志」作废）：
 *     有上游错误就带渠道前缀透传原文（截断），没有上游信息才用网关描述
 */

import type { ServerResponse } from "node:http";

import { noteRequestError } from "../../runtime/log-store.js";
import { anthropicErrorBody } from "../protocol/anthropic.js";
import { protocolOf } from "../protocol/types.js";

/** 统一 JSON 应答（`/health`、`/v1/models` 等）。 */
export function writeJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/**
 * 错误响应 JSON 结构：`{"error":{"type","code","message"}}`。
 *
 * **统一协议收口**：res 上挂了入站协议时按该协议的信封回 —— 解析失败 / 池路由 400 /
 * 未登录 503 这些派发前的错误也都经过这里，逐调用点替换必然漏（评审抓到三条漏网路径）。
 */
export function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  noteRequestError(res, code, message);
  const protocol = protocolOf(res);
  if (protocol?.protocol.name === "anthropic") {
    writeJson(res, anthropicErrorBody(code, message), status);
    return;
  }
  writeJson(res, { error: { type: "error", code, message } }, status);
}

/**
 * 协议感知的错误应答：res 上挂了入站协议时按该协议的信封回
 * （Anthropic `{type:"error",error:{type,message}}`），否则是既有 OpenAI 信封。
 * Claude Code 只解析 Anthropic 形态的信封。
 */
export function writeProtocolError(res: ServerResponse, status: number, code: string, message: string): void {
  const protocol = protocolOf(res);
  if (protocol?.protocol.name === "anthropic") {
    noteRequestError(res, code, message);
    writeJson(res, anthropicErrorBody(code, message), status);
    return;
  }
  writeJsonError(res, status, code, message);
}

/**
 * 「本渠道承载不了这类输入」的信号错误。
 *
 * 渠道在 `buildChatBody` / `prepareChat` 里抛出它，表示**换一家渠道可能成功**
 * （如 catpaw 把请求体按纯文本渲染，图片段进不去）。共享层据此把这条候选判为
 * **可重试**，而不是终局 400 —— 后者会让「只有部分渠道不支持」的输入整条请求失败
 * （2026-11-07 实测：deepseek-v4.1-flash 的带图请求被 catpaw 守卫拦成 400，
 * 而 qodercn 等渠道本来能正常处理）。
 *
 * 与「用户输入非法」的区别：那种换渠道同样会失败（上下文超限、缺必填字段），
 * 必须终局 400，不浪费尝试预算。
 */
export class UnsupportedInputError extends Error {
  override name = "UnsupportedInputError";
}

/** 按类或类名识别（跨包/跨进程边界时 `instanceof` 可能失配，与 `NotLoggedInError` 同式）。 */
export function isUnsupportedInputError(err: unknown): boolean {
  return err instanceof UnsupportedInputError || (err instanceof Error && err.name === "UnsupportedInputError");
}

/**
 * 上游响应体是否表示**额度耗尽 / 用量超限**（不是请求参数/内容错误）。
 *
 * 额度类错误必须与普通 4xx 区分：后者（模型参数、tool 消息序列等）是请求级问题，
 * 换账号也会失败；前者继续打同一个账号只会重复失败，应把账号**冷却**起来。
 *
 * **这里只放通用措辞**（任何上游都可能用的说法）。渠道自己的业务码与专有措辞走
 * `upstream.quotaSignal()` 钩子上报 —— 共享层不许硬编码渠道知识
 * （AGENTS.md：共享层不许出现任何渠道知识）。实测出处：loomy `HTTP 402` +
 * `insufficient_quota`「积分余额不足」。
 */
export function isQuotaExhausted(body: string): boolean {
  if (!body) return false;
  return /insufficient_points|insufficient_quota|quota[_ -]?exceeded|credit[s]?[_ -]?(exhausted|insufficient)|余额不足|积分不足|额度不足|配额不足|超出配额|免费额度已用完|额度已用完|升级套餐|usage[_ ]exceeds|frequency[_ ]limit|频率限制/i.test(body);
}

/**
 * 是否为**账户级用量限额**（区别于「余额不足」）。
 *
 * 为什么要分：用量限额对**所有模型**生效 —— 实测 workbuddyai 用量打满时，连我们目录里
 * 标倍率 0 的模型也吃限额 —— 所以一律冷却；而余额不足只影响计费用量，免费模型不该被连坐。
 *
 * 同样只放通用措辞；渠道的专有业务码（如 workbuddyai 的 `6004`）由
 * `upstream.quotaSignal()` 上报，别写在这里。
 */
export function isUsageLimit(body: string): boolean {
  if (!body) return false;
  return /frequency[_ ]limit|usage[_ ]exceeds|频率限制/i.test(body);
}
