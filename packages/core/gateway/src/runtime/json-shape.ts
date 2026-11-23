/**
 * 上游 JSON 的形状守卫与取值助手（渠道包共用）。
 *
 * 为什么放共享层：7 个渠道包各自解析上游报文，都要回答同样三个问题 ——
 * 「这是对象吗」「这个字段是字符串吗」「这个字段是数字吗」。这三件事与渠道无关，
 * 各写一份就是 11 处 `str()` + 8 处 `isRecord()` 的复制（实测）。
 *
 * 只做类型收窄，不做语义解释：字段名、默认值、兜底链仍由各渠道自己决定 ——
 * 那些才是渠道知识。
 */

/** 非 null、非数组的对象（上游 JSON 里 `{}` 与 `[]` 都是 object，必须分开）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 字符串取值：非字符串一律空串（上游把数字 id 下发成 number 时不让它变成 "123"）。 */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 有限数字取值：非有限值返回 null，调用方自己决定回落。 */
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 日志与错误文案里的凭据遮蔽。
 *
 * 为什么必须有：上游会把请求的 Authorization / token 回显进错误体，而错误体既回给
 * 客户端、也落 `error.log`。只在回客户端的路径上脱敏等于漏了日志这一半 ——
 * 所以这个函数放在日志汇聚点（`logLine`）与错误摘录（`snippetOf`）共用的位置。
 *
 * 只按**形态**打码，不改语义：报错信息本身仍完整可读。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}/gi, "$1 ***")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***jwt***")
    .replace(
      /(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|secret|password)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi,
      "$1$2***",
    )
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, (m) => `${m.slice(0, 3)}****${m.slice(7)}`);
}
