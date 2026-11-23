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
