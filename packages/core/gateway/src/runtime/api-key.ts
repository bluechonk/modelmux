/**
 * API key 端口（取代原多租户门禁）：对话端点鉴权、模型白名单、每分钟请求上限。
 *
 * 三个关键取舍：
 *  - **对话请求必须带 key**：装配即注入，`apiKeyGuard()` 恒非 null；模型列表、状态类
 *    端点不经过这里（它们不承载模型调用）。
 *  - **明文可回读**：落盘既有 scrypt 哈希也有明文（同一 0600 文件、同一信任域），
 *    列表复制与一键接入都要完整值；校验恒走哈希比对。
 *  - **校验结果带白名单与限流**：白名单判定用归一后的对外模型名（角色名先过家族表），
 *    限流是每分钟固定窗口。
 */

/** 存储里的 key 记录（哈希 + 明文 + 展示前缀 + 白名单 + 限流）。 */
export interface ApiKeyRecord {
  id: string;
  /** 用户给的备注名（便于区分用途，如 "ci" / "笔记本"）。 */
  name: string;
  /** 明文前 8 位（`mmx_xxxxxxxx`），列表展示用。 */
  prefix: string;
  /**
   * 完整明文。
   *
   * 为什么保留可回读：列表的行内复制要给出完整 key，一键接入要把它写进客户端
   * 配置 —— 只有哈希时这两件事都做不到（旧版只能复制前缀、接入只能写占位）。
   * 存储边界是本地 `<root>/api-keys.json`（0600，只有本机同一用户可读），与哈希
   * 处于同一信任域，保留明文不降低实际安全等级；校验仍走 scrypt 恒时比对。
   * 早期记录没有这个字段（读出来是 undefined），由「重新生成」补齐。
   */
  secret?: string | null;
  /** scrypt 摘要（16 字节 hex）；校验时按前缀索引候选再恒时比对。 */
  keyHash: string;
  /** 允许的对外模型名；空数组 = 全部模型（白名单只在非空时生效）。 */
  allowedModels: string[];
  /** 每分钟请求上限；0 = 不限。 */
  rpmLimit: number;
  createdAt: string;
  /** 最近一次使用时间（鉴权通过时更新，仅本机文件形态持久化）。 */
  lastUsedAt?: string;
}

/** 校验结果：通过时给出白名单与限流，供请求路径判定。 */
export type ApiKeyDecision =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; reason: "invalid" | "forbidden" | "rate_limited"; message: string };

/** 门禁端口：组合根注入实现（本机文件 / 服务化存储）。 */
export interface ApiKeyGuard {
  /** 鉴权 + 白名单 + 限流一次判完（模型为归一后的对外名；null = 未解析出模型）。 */
  check(apiKey: string | null, model: string | null): Promise<ApiKeyDecision>;
}

let guard: ApiKeyGuard | null = null;

/** 注入实现（组合根装配时调用）。 */
export function setApiKeyGuard(next: ApiKeyGuard | null): void {
  guard = next;
}

/** 当前门禁实现。 */
export function apiKeyGuard(): ApiKeyGuard | null {
  return guard;
}
