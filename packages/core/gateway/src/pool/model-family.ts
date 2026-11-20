/**
 * 对外模型家族：网关**卖哪几个模型**（产品面），客户端用裸模型名请求（不带 `<cid>/` 前缀）。
 *
 * 渠道归属由网关按「账号池剩余额度」自动选择（见 `pool-targets.ts` / `http/chat/route.ts`）。
 * 本表是共享层唯一允许出现模型名的地方（`scripts/verify-contract.mjs` 强制）。
 *
 * **对外只有下面这两个名字**：渠道目录里的上游写法（如 workbuddy 的 `deepseek-flash`）只在
 * 内部归一用，客户端写了照样 400（2026-11-15 产品口径）。`qwen3.8-flash`（千问办公档位名）
 * 已移出对外家族 —— 上游目录 2026-11 起扩到具体型号档，档位名失去存在意义；
 * `kimi-k3.1-pro` 为多渠道供给的具体型号（六家渠道在册）。
 */

/** 对外暴露的模型 id（顺序即 `/v1/models` 与控制台的展示顺序）。 */
export const POOL_MODEL_IDS = ["deepseek-v4.1-flash", "kimi-k3.1-pro"] as const;

/** 对外 id → 规范名。 */
const CANONICAL: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "kimi-k3.1-pro": "kimi-k3.1-pro",
};

/**
 * 渠道目录里的上游等价写法 → 规范名（**不对客户端开放**）。
 *
 * 为什么与 `CANONICAL` 分开：`canonicalOf` 两条路共用（客户端请求 + 渠道目录条目），
 * 而收口只针对前者（见 `isClientModelId`）。目录里的上游名（workbuddy 写
 * `deepseek-flash`）必须照旧能归到家族，否则它会从候选里消失。
 * `kimi-k3-1`（codebuddycn / workbuddy 目录里的**另一个**条目）不在这里：它与
 * `kimi-k3.1-pro` 是上游目录里并存的两个条目，归并会让候选出现重复映射。
 */
const UPSTREAM_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** canonical → `/v1/models` 里的 `owned_by`（厂商标识，展示用）。 */
const MODEL_OWNER: Readonly<Record<string, string>> = {
  "deepseek-v4.1-flash": "deepseek",
  "kimi-k3.1-pro": "moonshot",
};

/**
 * `[角色名, 池模型]` 表：入站解析读这份表（顺序即档位顺序）。
 *
 * Desktop 直连网关只会发 `claude-<role>-<n>-<n>` 这类真实 Anthropic 名（校验器拒自造名、
 * 斜杠与点号，且整组拒收），`labelOverride` 只改菜单显示名、**不进请求体** ——
 * 没有这层映射时三个槽只能落到「第一个池模型」（2026-11-08 实测）。固定表而非按槽位
 * 下标取 `models[n]`：后者让实际模型随 `/v1/models` 展示顺序漂移。
 * 三槽全落 deepseek：最低倍率的多渠道强档模型；kimi-k3.1-pro 是高价档（×2.4 级），
 * 不适合 haiku 槽。契约见 docs/CONTRACT-TS.md §4.1.1。
 */
export const DESKTOP_ROLE_MODELS: ReadonlyArray<readonly [roleId: string, model: string]> = [
  ["claude-sonnet-4-5", "deepseek-v4.1-flash"],
  ["claude-opus-4-5", "deepseek-v4.1-flash"],
  ["claude-haiku-4-5", "deepseek-v4.1-flash"],
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
 * 偏好功能覆盖的模型族（canonical 集合）：两家都多渠道供给，偏好有意义。模型名的唯一
 * 落点在家族表（verify-contract 校验共享层不得另行硬编码）。
 */
export const PREFS_CANONICALS: readonly string[] = [
  "deepseek-v4.1-flash",
  "kimi-k3.1-pro",
];

/**
 * 单渠道供给收窄表（canonical → 指定渠道；产品决策）。收窄模型只从指定渠道出，
 * 其余渠道的目录条目一律不进候选。为什么在候选出口统一过滤而不是逐渠道标
 * `hidden`：目录条目散在多渠道且形态各异（裸名 / 短别名 / person-* 变体），逐渠道
 * 标 hidden 漏一家就还进候选；出口一处过滤，目录现算与注册表兜底两个来源一起挡。
 * 曾收窄的模型恢复全渠道开放供给后不再出现在表中 —— `qwen3.8-flash` 移出家族后
 * 本表为空，机制保留给下一个单渠道模型。
 */
export const SINGLE_CHANNEL_SUPPLY: Readonly<Record<string, string>> = {};

/**
 * 对外**列出**的模型 id：只列 canonical。
 *
 * 每个对外名字只出现一次 —— 否则模型池与「模型 × 渠道」表里会出现两行一模一样的条目。
 */
export const POOL_EXPOSED_IDS: readonly string[] = POOL_MODEL_IDS.filter(
  (id) => lookup(CANONICAL, id) === id,
);

/** 是否为对外暴露的模型 id（大小写不敏感）。 */
export function isPoolModel(id: string): boolean {
  return canonicalOf(id) !== null;
}

/**
 * 客户端**可请求**的模型 id：只认对外公布的裸名。
 *
 * 与 `canonicalOf` 的分工：那个是「能归到家族就算」，把渠道目录里的上游写法
 * （`sn-deepseek-v4-1-flash-1017`、`deepseek-flash`）也算命中；这里只认公开面 ——
 * 对外只有一个名字，客户端写目录写法或历史别名一律 400（2026-11-15 产品口径）。
 */
export function isClientModelId(id: string): boolean {
  const key = id.trim().toLowerCase();
  return POOL_EXPOSED_IDS.includes(key);
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
  const direct = lookup(CANONICAL, key) ?? lookup(UPSTREAM_ALIASES, key);
  if (direct !== undefined) return direct;
  // 渠道目录里的等价写法：先按共享归一化再查表（`sn-` 包装、`v4-1` → `v4.1`、`-official` 等）
  const normalized = normalizeLoose(key);
  return lookup(CANONICAL, normalized) ?? lookup(UPSTREAM_ALIASES, normalized) ?? null;
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
