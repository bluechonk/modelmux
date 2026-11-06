/**
 * 请求上下文弹窗的**滚动位置记忆**（按 request id 存 localStorage）：正文可达 MB 级，
 * 反复打开同一条请求不该每次都从顶部重滑（页面行为见 docs/WEB-CONSOLE.md 的请求日志行）。
 *
 * 三条硬约束：
 *   1. 位置只在**内容没变**时可信 —— 判据是记录集签名而不是高度：正文懒加载，重开时
 *      只有首片，`scrollHeight` 必然变小，拿它当判据等于让记忆失效；
 *   2. 过期与条目数都要有上限，否则 localStorage 只增不减（保留期见 docs/LOGGING.md §6/§9）；
 *   3. 存储不可用 / 值损坏一律当「没有记忆」，绝不抛错、绝不提示（静默降级）。
 *
 * 存储入参可注入（默认 `window.localStorage`）：单测据此构造损坏 / 超量 / 不可用的状态。
 */

/**
 * key 前缀：`modelmux.logs.ctx-scroll:<request id>`（request id 是日志里的 `req_xxx`，不含冒号）。
 *
 * 归到 `modelmux.` 命名空间下（与 `modelmux.logs.pageSize` / `modelmux.dashboard.range` 同族）：
 * 日后按前缀检索或清理不会漏掉这一族。
 */
export const CTX_SCROLL_PREFIX = "modelmux.logs.ctx-scroll:";

/**
 * 记忆有效期（天）。
 *
 * 真正决定「还能不能用」的是抓取记录保留期（`MODELMUX_LOG_PAYLOAD_DAYS`，默认 3 天）：
 * 记录一被清掉，签名判据立刻让旧位置作废（见 `loadCtxScroll`）。TTL 取 14 天是因为
 * access 日志保留期默认 14 天 —— 超过它请求已从列表里消失，记忆再也打不开；
 * 条目最多挂到那时，且有 `CTX_SCROLL_MAX_ENTRIES` 兜住容量。
 */
export const CTX_SCROLL_TTL_DAYS = 14;

/** 最多保留多少条记忆（超出按写入时间淘汰最旧的）。 */
export const CTX_SCROLL_MAX_ENTRIES = 200;

/** 取 `window.localStorage`；不可用（隐私模式、SSR、Node 测试）返回 null。 */
function defaultStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // localStorage 不可用：本次会话不记忆，不报错
  }
}

/** 存进 localStorage 的值：`t` 位置、`s` 内容签名、`a` 写入时刻（毫秒）。 */
interface StoredPos {
  t: number;
  s: string;
  a: number;
}

export function ctxScrollKey(id: string): string {
  return `${CTX_SCROLL_PREFIX}${id}`;
}

/**
 * 内容签名：由抓取记录的元数据拼成（`phase#seq:bytes`，**排序后**拼接）。
 *
 * 为什么用签名而不是 `scrollHeight`：正文懒加载，重开时高度必然不同（见文件头约束 1）。
 * 元数据（`records[]` 的 phase / seq / bytes）与加载进度无关，同一份记录重开必得同值 ——
 * 抓取记录被轮转 / 保留期清掉、或重试多出一条 attempt，都会改签名，正是「内容变了」的语义
 * （实测：payload 日志按 10MB 轮转，只留最近 4 个文件 —— 活跃写入下几分钟前的 client
 * 记录就会滚出窗口，签名随之变化，旧位置作废）。
 *
 * 排序后再拼：签名只认记录的**集合**，不认接口给数组的顺序（同毫秒写入的两条记录
 * 排序不稳定，会让同一份内容算出两个签名，记忆被无谓清掉）。
 * 无记录时返回空串（调用方据此不写记忆）。
 */
export function signatureOf(records: ReadonlyArray<{ phase: string; seq: number; bytes: number }>): string {
  if (records.length === 0) return "";
  const parts = records.map((record) => `${record.phase}#${record.seq}:${record.bytes}`).sort();
  const text = parts.join("|");
  // 记录多时签名会变长（每条几十字节）：超过 512 字符改用 FNV-1a 32 位哈希，
  // 位置记忆只做「一样 / 不一样」判断，不需要抗碰撞强度
  return text.length <= 512 ? text : `fnv:${fnv1a(text)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function parseStored(raw: string | null): StoredPos | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const rec = value as Record<string, unknown>;
    const t = rec["t"];
    const s = rec["s"];
    const a = rec["a"];
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return null;
    if (typeof s !== "string") return null;
    if (typeof a !== "number" || !Number.isFinite(a)) return null;
    return { t, s, a };
  } catch {
    return null; // 手动改坏 / 旧版本格式：当没有记忆
  }
}

/** 读一条原始字符串；存储被禁用 / 会话中途撤销时也可能抛，一律当「读不到」。 */
function readItem(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null; // 与写路径同一条契约：存储异常 = 没有记忆，不冒泡到 React effect
  }
}

/** 清理过期与超量条目（打开弹窗时跑一次，不放在滚动写入路径上）。 */
export function pruneCtxScroll(now: number = Date.now(), store: Storage | null = defaultStore()): void {
  if (store === null) return;
  const ttlMs = CTX_SCROLL_TTL_DAYS * 86_400_000;
  const live: Array<{ key: string; at: number }> = [];
  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (key === null || !key.startsWith(CTX_SCROLL_PREFIX)) continue;
      const rec = parseStored(readItem(store, key));
      // 过期（或损坏）直接删：损坏的条目永远读不出位置，留着只占地方
      if (rec === null || now - rec.a > ttlMs) {
        store.removeItem(key);
        continue;
      }
      live.push({ key, at: rec.a });
    }
    if (live.length > CTX_SCROLL_MAX_ENTRIES) {
      live.sort((a, b) => a.at - b.at);
      for (const item of live.slice(0, live.length - CTX_SCROLL_MAX_ENTRIES)) {
        store.removeItem(item.key);
      }
    }
  } catch {
    return; // 存储被禁用 / 配额异常：放弃清理（顺带不记忆），静默降级
  }
}

/**
 * 读回某条请求的记忆位置；**内容签名不一致时删掉缓存并返回 null**（回退置顶）。
 *
 * 返回 null 的三种情况语义相同：没有记忆 → 从顶部开始（与「首次打开」同一条路径）。
 */
export function loadCtxScroll(
  id: string,
  signature: string,
  now: number = Date.now(),
  store: Storage | null = defaultStore(),
): number | null {
  if (store === null || signature === "") return null;
  const key = ctxScrollKey(id);
  const rec = parseStored(readItem(store, key));
  if (rec === null) return null;
  if (rec.s !== signature || now - rec.a > CTX_SCROLL_TTL_DAYS * 86_400_000) {
    try {
      store.removeItem(key); // 内容变了 / 过期：旧位置已无意义，顺手清掉
    } catch {
      // 删不掉也只是留着垃圾，不影响本次「置顶」的结果
    }
    return null;
  }
  return rec.t;
}

/** 写入记忆位置（`signature` 为空 = 没有正文记录，不写）。 */
export function saveCtxScroll(
  id: string,
  top: number,
  signature: string,
  now: number = Date.now(),
  store: Storage | null = defaultStore(),
): void {
  if (store === null || signature === "" || !Number.isFinite(top) || top < 0) return;
  try {
    const value: StoredPos = { t: Math.round(top), s: signature, a: now };
    store.setItem(ctxScrollKey(id), JSON.stringify(value));
  } catch {
    // 配额满 / 存储被禁用：不记忆即可，绝不打断阅读
  }
}
