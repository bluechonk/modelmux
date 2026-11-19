/**
 * API key 端口（取代原多租户门禁）：对话端点鉴权、模型白名单、每分钟请求上限。
 *
 * 三个关键取舍：
 *  - **默认不校验**：`apiKeyGuard()` 为 null 时（未启用）请求直通 —— 本机单用户形态
 *    不该被迫先建 key；启用开关在设置页（`setting.json` 的 `api_key_required`）。
 *  - **key 明文只在创建时出现一次**：落盘/落库都是哈希 + 前缀，与市面通行做法一致。
 *  - **校验结果带白名单与限流**：白名单判定用归一后的对外模型名（角色名先过家族表），
 *    限流是每分钟固定窗口，与租户体系时代的 rpm 语义相同。
 */

/** 存储里的 key 记录（哈希 + 展示前缀 + 白名单 + 限流；明文不落盘）。 */
export interface ApiKeyRecord {
  id: string;
  /** 用户给的备注名（便于区分用途，如 "ci" / "笔记本"）。 */
  name: string;
  /** 明文前 8 位（`mmx_xxxxxxxx`），列表展示用。 */
  prefix: string;
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

/** 注入实现（组合根调用；`null` = 不启用校验）。 */
export function setApiKeyGuard(next: ApiKeyGuard | null): void {
  guard = next;
}

/** 当前门禁实现；null = 不校验（本机默认形态）。 */
export function apiKeyGuard(): ApiKeyGuard | null {
  return guard;
}
