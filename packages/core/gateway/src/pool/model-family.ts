/**
 * 对外模型家族：网关**卖哪几个模型**（产品面），客户端用裸模型名请求（不带 `<cid>/` 前缀）。
 *
 * 渠道归属由网关按「账号池剩余额度」自动选择（见 `pool-targets.ts` / `http/chat/route.ts`），
 * 客户端不关心模型来自哪家。模型家族是网关的产品面，不是渠道知识 ——
 * 渠道各自暴露什么仍由渠道目录决定，这里只声明「对外卖哪几个模型」。
 *
 * 家族表是共享层唯一允许出现模型名的地方（`scripts/verify-contract.mjs` 强制）。
 *
 * 别名：`deepseek-flash` 与 `deepseek-v4.1-flash` 是同一代模型的两个名字，双向匹配
 * （请求任一名字都命中渠道目录里这两个 canonical 之一）。
 */

/** 对外暴露的模型 id（顺序即 `/v1/models` 与控制台的展示顺序；别名排在最后）。 */
export const POOL_MODEL_IDS = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "deepseek-flash",
] as const;

/** 对外 id → 规范名（别名归并到同一个 canonical）。 */
const CANONICAL: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "glm-5.3-flash": "glm-5.3-flash",
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** 规范名 → 该代模型的对外 id 集合（含别名）。 */
const ALIAS_GROUP: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4.1-flash": ["deepseek-v4.1-flash", "deepseek-flash"],
  "glm-5.3-flash": ["glm-5.3-flash"],
};

/** canonical → `/v1/models` 里的 `owned_by`（厂商标识，展示用）。 */
const MODEL_OWNER: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek",
  "glm-5.3-flash": "zhipu",
};

/**
 * 对外**列出**的模型 id：只列 canonical。
 *
 * `deepseek-flash` 是 `deepseek-v4.1-flash` 的别名（同一代模型），仍可被客户端**请求**，
 * 但不单独列出来 —— 否则模型池与「模型 × 渠道」表里会出现两行一模一样的条目。
 */
export const POOL_EXPOSED_IDS: readonly string[] = POOL_MODEL_IDS.filter(
  (id) => CANONICAL[id] === id,
);

/** 是否为对外暴露的模型 id（大小写不敏感）。 */
export function isPoolModel(id: string): boolean {
  return canonicalOf(id) !== null;
}

/** canonical → `owned_by`；未登记的家族返回 `modelmux`（不编造厂商标识）。 */
export function ownerOf(canonical: string): string {
  return MODEL_OWNER[canonical] ?? "modelmux";
}

/**
 * 对外 id / 渠道目录名 → 规范模型名；不是本家族返回 `null`。
 *
 * 大小写不敏感：客户端可能写 `DeepSeek-V4.1-Flash`，渠道目录里的写法也各不相同
 * （TRAE 的 `DeepSeek-V4-Flash-Official`、raccoon 的 `sn-deepseek-v4-1-flash`、
 * loomy 的 `GLM-5.3-Flash`）。
 */
export function canonicalOf(id: string): string | null {
  const key = id.trim().toLowerCase();
  if (CANONICAL[key] !== undefined) return CANONICAL[key]!;
  // 渠道目录里的等价写法：先按共享归一化再查表（`sn-` 包装、`v4-1` → `v4.1`、`-official` 等）
  const normalized = normalizeLoose(key);
  return CANONICAL[normalized] ?? null;
}

/** 规范名 → 该代模型的对外 id 集合（含别名）；未知规范名返回单元素 `[model]`。 */
export function aliasGroupOf(canonical: string): readonly string[] {
  return ALIAS_GROUP[canonical] ?? [canonical];
}

/**
 * 宽松归一化：只处理**跨渠道等价写法**，不剥厂商路径段（那是 `canonicalModelId` 的职责）。
 *
 * 与 `pool-targets.canonicalModelId` 的差别：这里只把「明显是同一个模型」的写法收敛到对外 id
 * （`sn-` 包装前缀、`v4-1` → `v4.1`、`-official` / `-latest` / `-0731` 尾饰），
 * 不做渠道目录条目级的去重。**不剥型号后缀** —— `glm-5.3-flashx` 是另一个型号。
 */
function normalizeLoose(id: string): string {
  let out = id;
  for (const prefix of ["sn-", "z-ai-", "bytedance-"]) {
    if (out.startsWith(prefix)) {
      out = out.slice(prefix.length);
      break;
    }
  }
  out = out.replace(/(\d)-(\d)/g, "$1.$2");
  out = out.replace(/-official$/, "").replace(/-latest$/, "").replace(/-\d{4}$/, "");
  return out;
}
