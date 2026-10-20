/**
 * 粘贴兜底的文本识别：**这段文字是不是「授权失败页」**，以及**能不能从里面捞出授权码**。
 *
 * 关键约束：
 *   - 纯字符串启发式：**不认渠道、不发请求**（失败措辞与回调形态都是通用事实）
 *   - 判失败时给**原因**而不是布尔：原因要原样回给用户看
 *   - 提取授权码只认「像码」的形态，垃圾输入一律当没粘到（不猜）
 *
 * 铁律：共享层不许出现任何渠道知识，这里只放通用启发式。
 */

/** 授权失败页里的措辞（中英各一组；匹配前统一小写）。 */
const AUTH_ERROR_MARKERS = ["error=", "errmsg=", "denied", "access_denied", "拒绝", "失败"];

/** 命中失败措辞但问不出更具体原因时，回给用户的话术。 */
const DEFAULT_FAILURE_REASON = "the browser reported an authorization error";

/** 像整条 URL 的粘贴内容（带 scheme）。 */
const CALLBACK_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 像裸授权码的粘贴内容（URL 安全字符，不含空白与分隔符）。 */
const BARE_CODE_RE = /^[A-Za-z0-9._~%-]+$/;

/**
 * 粘回的内容是不是「授权被拒 / 出错」；是则给出**原因**（可直接回给用户）。
 *
 * 认出来就能**立刻**结束等待，而不是白等 5 分钟。返回空串 = 不是失败页。
 *
 * 判据是**措辞命中**（`error=` / `denied` / 「拒绝」/「失败」…）：授权被拒时
 * 地址栏与页面里剩下的就是这些字样。命中后再从 query 里取更具体的原因
 * （`errmsg` / `error_description` / `error`）。
 */
export function pastedAuthFailureReason(raw: string): string {
  const text = raw.trim().toLowerCase();
  for (const marker of AUTH_ERROR_MARKERS) {
    if (text.includes(marker.toLowerCase())) {
      const params = new URLSearchParams(text.split("?")[1] ?? "");
      return (
        params.get("errmsg") ??
        params.get("error_description") ??
        params.get("error") ??
        DEFAULT_FAILURE_REASON
      );
    }
  }
  return "";
}

/**
 * 粘回的内容是否表示「授权被拒 / 出错」。
 *
 * 判据与 `pastedAuthFailureReason` 一致（原因非空即算失败）：`?errmsg=`
 * 这类**空值**错误参数按现状**不算失败**。
 */
export function isPastedAuthFailure(raw: string): boolean {
  return pastedAuthFailureReason(raw) !== "";
}

/** 从粘贴文本里提取到的回调信息。 */
export interface PastedCallback {
  /** 授权码（`code` 参数或裸码）；没有则空串。 */
  code: string;
  /** 回调携带的 `state`；没有则空串。 */
  state: string;
  /** 整条回调 URL；粘的不是 URL 则空串。 */
  url: string;
}

/** 取分隔符之后、片段符（`#`）之前的参数串。 */
function paramSlice(text: string, at: number): string {
  const hash = text.indexOf("#", at + 1);
  return hash < 0 ? text.slice(at + 1) : text.slice(at + 1, hash);
}

/**
 * 从用户粘回的内容里提取授权码 / 回调 URL。
 *
 * 接受四种形态：整条回调 URL、`?code=…&state=…` 查询串、`#code=…&state=…` 片段、
 * 裸 `code=…&state=…` 或裸码。
 *
 * ⚠ **不猜**：认不出来就返回空串（垃圾输入宁可当没粘到，也不要换出一个假 code）。
 * 授权失败页里没有授权码 —— 直接返回空。
 */
export function extractPastedCallback(raw: string): PastedCallback {
  const text = raw.trim();
  const none: PastedCallback = { code: "", state: "", url: "" };
  if (!text) return none;
  if (pastedAuthFailureReason(text)) return none; // 失败页里没有授权码

  // 整条 URL：query 优先，其次 fragment
  if (CALLBACK_URL_RE.test(text)) {
    let params: URLSearchParams;
    try {
      const url = new URL(text);
      params = url.searchParams;
      if (!params.get("code") && !params.get("state")) {
        const hash = url.hash.replace(/^#/, "");
        if (hash.includes("=")) params = new URLSearchParams(hash);
      }
    } catch {
      return none;
    }
    return {
      code: (params.get("code") ?? "").trim(),
      state: (params.get("state") ?? "").trim(),
      url: text,
    };
  }

  // 查询串 / 片段：`?code=…` / `#code=…`
  for (const sep of ["?", "#"]) {
    const at = text.indexOf(sep);
    if (at < 0) continue;
    const params = new URLSearchParams(paramSlice(text, at));
    const code = (params.get("code") ?? "").trim();
    if (code) return { code, state: (params.get("state") ?? "").trim(), url: "" };
  }
  // 裸查询串（没有 ? / # 前缀）：整串按 query 解析
  if (text.includes("=")) {
    const params = new URLSearchParams(text);
    const code = (params.get("code") ?? "").trim();
    if (code) return { code, state: (params.get("state") ?? "").trim(), url: "" };
  }
  // 裸码：不含空白与分隔符才算
  return BARE_CODE_RE.test(text) ? { code: text, state: "", url: "" } : none;
}
