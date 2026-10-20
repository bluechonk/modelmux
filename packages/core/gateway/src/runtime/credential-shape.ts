/**
 * 凭证形状归一化：账号池按账号查额度时，需要把磁盘上的原始凭证交给渠道 billing。
 *
 * 各渠道落盘的字段命名不统一（`accessToken` vs `access_token`、`firstKeyfrom` vs
 * `first_keyfrom`），而渠道 billing 只认自己 `cred.load()` 的形状。这里做一次通用
 * 「snake_case → camelCase」深度转换。
 *
 * 归一化的**落点**在池层：按账号查额度时，池层先用本函数把磁盘上的原始凭证转成
 * 渠道认得的形状，再交给 `billing.fetchCredits`（见 `pool/pool-usage.ts` 的
 * `refreshAccountCredits`）。
 *
 * ⚠ 只做形状转换，不解释语义、不派生字段；转换结果是**只读副本**，不回写磁盘。
 */

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** 深度转换对象/数组的 key（snake_case → camelCase）；非容器值原样返回。 */
export function normalizeCredentialShape(value: unknown): Record<string, unknown> {
  const converted = convert(value);
  return converted && typeof converted === "object" && !Array.isArray(converted)
    ? (converted as Record<string, unknown>)
    : {};
}

function convert(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convert);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[camelKey(key)] = convert(raw);
  }
  return out;
}
