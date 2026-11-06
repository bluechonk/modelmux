/**
 * 控制台翻译代理：把 `POST /web/api/translate` 变成一次对**公开翻译端点**的转发。
 *
 * 为什么由网关代发而不是浏览器直连：跨域、CSP、端点暴露三件事都不该由前端承担；
 * 网关代发还能统一超时、单批字数上限与错误码（前端只认 `code`）。
 *
 * 端点是无密钥的公开服务（`edge.microsoft.com/translate/translatetext`），
 * 不消耗模型额度 —— 这里没有任何「模型在翻译」的成分。
 */

/** 翻译后端：微软 Edge 的公开翻译端点（无需 key / cookie，见 docs/TRANSLATION.md §5）。 */
const ENDPOINT = "https://edge.microsoft.com/translate/translatetext";

/** 单次请求的业务超时：翻译是同步短请求，超过这个时间基本可以判死。 */
const TIMEOUT_MS = 20_000;

/** 单批最多几条文本（前端按块切，一条消息通常 1-4 块）。 */
export const MAX_TEXTS = 12;

/** 单条文本上限（字符）。实测 3500 字符/块稳定，4000 留余量。 */
export const MAX_TEXT_CHARS = 4000;

/** 单批总字符上限：实测 42000 字符仍 200，70000 直接 400（见 docs/TRANSLATION.md §5.1）。 */
export const MAX_TOTAL_CHARS = 40_000;

/** 翻译失败的错误码（前端按 code 决定文案，不解析英文错误串）。 */
export type TranslateErrorCode =
  | "translate-unavailable"
  | "translate-timeout"
  | "translate-http-error"
  | "translate-invalid-response"
  | "translate-request-failed"
  | "translate-text-limit";

/** 一次翻译调用的结果。 */
export type TranslateOutcome =
  | { ok: true; texts: string[] }
  | { ok: false; code: TranslateErrorCode; error: string };

/** 校验一批文本：合法返回 `{ ok: true, texts }`（原样透传），不合法返回 `{ ok: false, code, error }`。 */
export function validateTexts(
  texts: unknown,
): { ok: true; texts: string[] } | { ok: false; code: TranslateErrorCode; error: string } {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: false, code: "translate-request-failed", error: "texts 必须是非空数组" };
  }
  if (texts.length > MAX_TEXTS) {
    return {
      ok: false,
      code: "translate-text-limit",
      error: `单批最多 ${MAX_TEXTS} 条（实际 ${texts.length}）`,
    };
  }
  let total = 0;
  const out: string[] = [];
  for (const item of texts) {
    if (typeof item !== "string") {
      return { ok: false, code: "translate-request-failed", error: "texts 每项必须是字符串" };
    }
    if (item.length > MAX_TEXT_CHARS) {
      return {
        ok: false,
        code: "translate-text-limit",
        error: `单条最多 ${MAX_TEXT_CHARS} 字符（实际 ${item.length}）`,
      };
    }
    total += item.length;
    out.push(item);
  }
  if (total > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      code: "translate-text-limit",
      error: `单批合计最多 ${MAX_TOTAL_CHARS} 字符（实际 ${total}）`,
    };
  }
  return { ok: true, texts: out };
}

/**
 * 把一批文本转成目标语言。
 *
 * 目标语言只允许中文：控制台界面语言固定，放开参数只是多一条被滥用的通路。
 * `texts` 已由 `validateTexts` 校验过（长度、条数、总字数）。
 */
export async function translateTexts(texts: string[], to = "zh-Hans"): Promise<TranslateOutcome> {
  if (texts.length === 0) return { ok: true, texts: [] };
  const url = `${ENDPOINT}?to=${encodeURIComponent(to)}&isEnterpriseClient=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(texts),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "translate-timeout" : "translate-request-failed",
      error: aborted ? `翻译超时（> ${TIMEOUT_MS / 1000}s）` : String(err),
    };
  }
  // 定时器覆盖到**体读取**为止（与 pingModel 同型）：上游发完头就卡住不吐体时，
  // 请求不能无限挂着。连接中断不置位 signal —— text() 只得到空串，走下方空体分支
  const raw = await res.text().catch(() => "");
  clearTimeout(timer);
  if (controller.signal.aborted) {
    return {
      ok: false,
      code: "translate-timeout",
      error: `翻译超时（> ${TIMEOUT_MS / 1000}s）`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "translate-http-error",
      error: raw.slice(0, 200) || `HTTP ${res.status}`,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // 空串与解析失败必须给出非空 error：空串传到前端会让失败态静默复原成「翻译」按钮
    return {
      ok: false,
      code: "translate-invalid-response",
      error: raw === "" ? "上游返回空响应体（或读取失败）" : raw.slice(0, 120),
    };
  }
  if (!Array.isArray(payload) || payload.length !== texts.length) {
    return {
      ok: false,
      code: "translate-invalid-response",
      error: `返回条数与请求不一致（${Array.isArray(payload) ? payload.length : "非数组"} vs ${texts.length}）`,
    };
  }
  const out: string[] = [];
  for (const item of payload) {
    const text = (item as { translations?: Array<{ text?: unknown }> } | null)?.translations?.[0]
      ?.text;
    if (typeof text !== "string") {
      return { ok: false, code: "translate-invalid-response", error: "缺少 translations[0].text" };
    }
    out.push(text);
  }
  return { ok: true, texts: out };
}
