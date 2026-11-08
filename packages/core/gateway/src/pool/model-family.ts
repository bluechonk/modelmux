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
  "longcat-2.5",
  "deepseek-flash",
] as const;

/** 对外 id → 规范名（别名归并到同一个 canonical）。 */
const CANONICAL: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "glm-5.3-flash": "glm-5.3-flash",
  "longcat-2.5": "longcat-2.5",
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** 规范名 → 该代模型的对外 id 集合（含别名）。 */
const ALIAS_GROUP: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4.1-flash": ["deepseek-v4.1-flash", "deepseek-flash"],
  "glm-5.3-flash": ["glm-5.3-flash"],
  "longcat-2.5": ["longcat-2.5"],
};

/** canonical → `/v1/models` 里的 `owned_by`（厂商标识，展示用）。 */
const MODEL_OWNER: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek",
  "glm-5.3-flash": "zhipu",
  "longcat-2.5": "meituan",
};

/**
 * `[角色名, 池模型]` 表：接入写 profile 与入站解析共读（顺序即档位顺序）。
 *
 * Desktop 直连网关只会发 `claude-<role>-<n>-<n>` 这类真实 Anthropic 名（校验器拒自造名、
 * 斜杠与点号，且整组拒收），`labelOverride` 只改菜单显示名、**不进请求体** ——
 * 没有这层映射时三个槽只能落到「第一个池模型」，菜单选 glm 实际跑 deepseek
 * （2026-11-08 实测）。固定表而非按槽位下标取 `models[n]`：后者让实际模型随
 * `/v1/models` 展示顺序漂移。契约见 docs/CONTRACT-TS.md §4.1.1。
 */
export const DESKTOP_ROLE_MODELS: ReadonlyArray<readonly [roleId: string, model: string]> = [
  ["claude-sonnet-4-5", "deepseek-v4.1-flash"],
  ["claude-opus-4-5", "glm-5.3-flash"],
  ["claude-haiku-4-5", "longcat-2.5"],
];

/** 角色名 → 池模型的 canonical；不是角色名返回 `null`。 */
export function desktopRoleModel(roleId: string): string | null {
  const key = roleId.trim().toLowerCase();
  for (const [id, model] of DESKTOP_ROLE_MODELS) if (id === key) return model;
  return null;
}

/**
 * 只在表**自有键**里查值。
 *
 * 三张表都是普通对象字面量，直接用 `TABLES[key]` 会走原型链：
 * `canonicalOf("constructor")` 命中 `Object.prototype.constructor`（一个函数），
 * 于是 `isPoolModel("constructor")` 为 true，请求一路走到 `canonicalOf(function)` 报
 * `id.trim is not a function` —— 客户端拿到 500 而不是「模型不存在」的 400。
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * 对外**列出**的模型 id：只列 canonical。
 *
 * `deepseek-flash` 是 `deepseek-v4.1-flash` 的别名（同一代模型），仍可被客户端**请求**，
 * 但不单独列出来 —— 否则模型池与「模型 × 渠道」表里会出现两行一模一样的条目。
 */
export const POOL_EXPOSED_IDS: readonly string[] = POOL_MODEL_IDS.filter(
  (id) => lookup(CANONICAL, id) === id,
);

/** 是否为对外暴露的模型 id（大小写不敏感）。 */
export function isPoolModel(id: string): boolean {
  return canonicalOf(id) !== null;
}

/** canonical → `owned_by`；未登记的家族返回 `modelmux`（不编造厂商标识）。 */
export function ownerOf(canonical: string): string {
  return lookup(MODEL_OWNER, canonical) ?? "modelmux";
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
  const direct = lookup(CANONICAL, key);
  if (direct !== undefined) return direct;
  // 渠道目录里的等价写法：先按共享归一化再查表（`sn-` 包装、`v4-1` → `v4.1`、`-official` 等）
  const normalized = normalizeLoose(key);
  return lookup(CANONICAL, normalized) ?? null;
}

/** 规范名 → 该代模型的对外 id 集合（含别名）；未知规范名返回单元素 `[model]`。 */
export function aliasGroupOf(canonical: string): readonly string[] {
  return lookup(ALIAS_GROUP, canonical) ?? [canonical];
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
  // 顺序与 `pool-targets.normalize` 保持一致（`-official` / 4 位日期 / `-latest`）
  out = out.replace(/-official$/, "").replace(/-\d{4}$/, "").replace(/-latest$/, "");
  return out;
}
