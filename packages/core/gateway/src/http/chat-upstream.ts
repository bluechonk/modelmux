/**
 * 向上游建连：发起请求、首包超时、空闲守卫（连续无数据即中止）。
 *
 * 关键约束：
 *   - 空闲判定按「连续无数据时长」而非总时长（持续出字的长任务不该被切断）
 *   - 渠道可用 `idleTimeoutMs()` 放宽静默上限（首字慢的上游 200 后长时间零字节）
 *   - 连接阶段失败与业务错误分开标记：前者请求未发出，可安全重试
 *
 * 铁律：只发起请求与判定上游应答，不含任何渠道知识。
 */

import { type Channel, type Credential } from "../runtime/channel.js";

const READ_TIMEOUT_MS = 120_000;

/** 空闲超时可用环境变量覆盖（测试/长任务部署按需调整）。 */
function readTimeoutMs(): number {
  const raw = process.env["MODELMUX_READ_TIMEOUT_MS"];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : READ_TIMEOUT_MS;
}

/**
 * 把上游响应体包成「空闲超时」流：**每读到一块就重置计时**。
 *
 * 判定依据是「连续无数据时长」，不是「总时长」：长任务（agent 轮次、
 * 长 tool 循环）总耗时超过阈值但持续出字时不会被切断。
 */
function idleGuardedBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => {
      controller.abort(new Error(`upstream idle timeout after ${timeoutMs}ms without data`));
    }, timeoutMs);
    timer.unref?.();
  };
  arm();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clear();
          ctrl.close();
          return;
        }
        arm();
        ctrl.enqueue(value);
      } catch (err) {
        clear();
        ctrl.error(err);
      }
    },
    async cancel(reason) {
      clear();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export interface UpstreamCall {
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  error?: Error;
  /** 连接阶段失败（请求未发出）—— 重试无副作用。 */
  connectFailed?: boolean;
  /** 连接/首字节阶段超时（区别于普通上游错误）。 */
  timeout?: boolean;
  /** 非 200 时的上游响应体片段（判断额度类错误用；不回传客户端）。 */
  bodySnippet?: string;
}

/**
 * 向上游发起流式请求。
 *
 * 401/403 由调用方刷新后重试；连接阶段失败归 `connectFailed`（请求未发出，可安全重试）。
 */

export async function openStream(channel: Channel, c: Credential, body: Buffer): Promise<UpstreamCall> {
  const { upstream } = channel;
  // 渠道声明了对话专用头族就用它，否则回退基础头
  const headers = upstream.buildChatHeaders ? upstream.buildChatHeaders(c) : upstream.buildHeaders(c);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept")) {
    headers["Accept"] = "text/event-stream";
  }

  let resp: Response;
  const controller = new AbortController();
  let timeoutMs = readTimeoutMs();
  // 渠道可放宽静默上限（首字慢的上游：200 后长时间零字节，见 UpstreamModule.idleTimeoutMs）
  const channelIdleMs = upstream.idleTimeoutMs?.();
  if (channelIdleMs !== undefined) timeoutMs = Math.max(timeoutMs, channelIdleMs);
  const headerTimer = setTimeout(() => {
    controller.abort(new Error(`upstream header timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  headerTimer.unref?.();
  try {
    resp = await fetch(upstream.chatUrl(), {
      method: "POST",
      body: new Uint8Array(body),
      headers,
      signal: controller.signal,
    });
    clearTimeout(headerTimer);
  } catch (err) {
    clearTimeout(headerTimer);
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as { code?: string }).code;
    const connectFailed =
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET";
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      body: null,
      error: new Error(`upstream request failed: ${String(err)}`),
      connectFailed,
      timeout: /timeout/i.test(String(err)) || (err as { name?: string }).name === "TimeoutError",
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    // 鉴权类失败也**读响应体**：有的上游用 403 表示「账号被限制」，
    // 不读 body 就永远分不清「令牌过期」和「账号被封」
    const snippet = await resp.text().catch(() => "");
    return {
      ok: false,
      status: resp.status,
      headers: resp.headers,
      body: null,
      error: new Error(`upstream returned HTTP ${resp.status}: ${snippet.slice(0, 2048)}`),
      bodySnippet: snippet,
    };
  }
  if (resp.status !== 200) {
    const snippet = await resp.text().catch(() => "");
    // 渠道可声明「非标准状态码的鉴权失败」（如 400 + 渠道特有错误码）：
    // 归一成 401，让调用方走刷新/换账号链路
    if (upstream.isAuthFailure && upstream.isAuthFailure(resp.status, snippet)) {
      return { ok: false, status: 401, headers: resp.headers, body: null };
    }
    return {
      ok: false,
      status: resp.status,
      headers: resp.headers,
      body: null,
      error: new Error(`upstream returned HTTP ${resp.status}: ${snippet.slice(0, 2048)}`),
      bodySnippet: snippet,
    };
  }
  return {
    ok: true,
    status: resp.status,
    headers: resp.headers,
    body: resp.body ? idleGuardedBody(resp.body, controller, timeoutMs) : null,
  };
}
