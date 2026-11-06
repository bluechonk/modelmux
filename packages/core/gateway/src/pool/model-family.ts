/**
 * 对外模型家族：网关只暴露 deepseek 系列，客户端用**裸模型名**请求（不再带 `<cid>/` 前缀）。
 *
 * 渠道归属由网关按「账号池剩余额度」自动选择（见 `pool-targets.ts` / `http/chat/route.ts`），
 * 客户端不再关心模型来自哪家。模型家族是网关的**产品面**，不是渠道知识 ——
 * 渠道各自暴露什么仍由渠道目录决定，这里只声明「网关对外卖哪几个模型」。
 *
 * 别名：`deepseek-flash` 与 `deepseek-v4.1-flash` 是同一代模型的两个名字，
 * 双向匹配（请求任一名字都命中渠道目录里这两个 canonical 之一）。
 */

/** 对外暴露的模型 id（顺序即 `/v1/models` 与控制台的展示顺序）。 */
export const DEEPSEEK_MODEL_IDS = [
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-flash",
] as const;

/** 对外 id → 规范名（别名归并到同一个 canonical）。 */
const CANONICAL: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "deepseek-flash": "deepseek-v4.1-flash",
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
};

/** 规范名 → 该代模型的对外 id 集合（含别名）。 */
const ALIAS_GROUP: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4.1-flash": ["deepseek-v4.1-flash", "deepseek-flash"],
  "deepseek-v4-flash": ["deepseek-v4-flash"],
  "deepseek-v4-pro": ["deepseek-v4-pro"],
};

/**
 * 渠道级**型号互斥**：键是下位型号，值是「一旦该渠道供给其中任意一个，就不再让它承接键」。
 *
 * 语义：`deepseek-v4-flash` / `deepseek-v4-pro` 只服务**上游没有 v4.1-flash** 的渠道
 * （那两家渠道的目录里就是这两个型号）；渠道只要供给 v4.1-flash（含别名 `deepseek-flash`，
 * 以及上游各种大小写 / 前后缀写法 —— 归一化交给 `canonicalModelId`），
 * 这两个下位型号就不再选它。不这么收口的话，同一家渠道会被两个型号重复命中：
 * 请求 `deepseek-v4-flash` 仍可能被发到「本已升级到 v4.1-flash」的渠道上。
 *
 * 归一化写作要靠 `canonicalModelId()`（`DeepSeek-V4.1-Flash` / `sn-deepseek-v4-1-flash` /
 * 带 `-official`、`-0731` 尾饰）—— 判定走「渠道目录里有没有这个规范名」，不看字面写法。
 */
const SUPERSEDED_BY: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4-flash": ["deepseek-v4.1-flash"],
  "deepseek-v4-pro": ["deepseek-v4.1-flash"],
};

/**
 * 该规范名的**上位型号**集合：渠道供给其中任意一个时，这个型号不该再选它。
 *
 * 空数组 = 该型号不受互斥约束。执行点是 `pool-targets.isSupersededChannel`（候选收集与
 * 元数据聚合共用），它被 `candidatesOf` / `getPoolModelMeta` 调用 —— 改这条规则只需要改这里。
 */
export function supersedingModels(canonical: string): readonly string[] {
  return SUPERSEDED_BY[canonical] ?? [];
}

/**
 * 对外**列出**的模型 id：只列 canonical。
 *
 * `deepseek-flash` 是 `deepseek-v4.1-flash` 的别名（同一代模型），仍可被客户端**请求**，
 * 但不单独列出来 —— 否则模型池与「模型 × 渠道」表里会出现两行一模一样的条目。
 */
export const DEEPSEEK_EXPOSED_IDS: readonly string[] = DEEPSEEK_MODEL_IDS.filter(
  (id) => CANONICAL[id] === id,
);

/** 是否为对外暴露的模型 id（大小写不敏感）。 */
export function isDeepseekModel(id: string): boolean {
  return canonicalOf(id) !== null;
}

/**
 * 对外 id / 渠道目录名 → 规范模型名；不是本家族返回 `null`。
 *
 * 大小写不敏感：客户端可能写 `DeepSeek-V4.1-Flash`，渠道目录里的写法也各不相同
 * （TRAE 的 `DeepSeek-V4-Flash-Official`、raccoon 的 `sn-deepseek-v4-1-flash`）。
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
 * 与 `pool-targets.canonicalModelId` 的差别：这里只把「明显是同一个 deepseek 模型」的写法
 * 收敛到对外 id（`sn-` 包装前缀、`v4-1` → `v4.1`、`-official` / `-latest` / `-0731` 尾饰），
 * 不做渠道目录条目级的去重。
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
  out = out.replace(/-official$/, "").replace(/-\d{4}$/, "").replace(/-latest$/, "");
  return out;
}
