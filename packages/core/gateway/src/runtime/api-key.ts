/**
 * API key 端口：对话端点鉴权。
 *
 * 两个关键取舍：
 *  - **对话请求必须带 key**：装配即注入，`apiKeyGuard()` 恒非 null；模型列表、状态类
 *    端点不经过这里（它们不承载模型调用）。
 *  - **密文可解密回读**：落盘 scrypt 哈希 + AES-GCM 密文（0600 文件、同一信任域），
 *    列表复制与一键接入经 `revealApiKey` 按需解密；校验恒走哈希比对。
 *    本机单人形态，key 只承担「准入」一个职责 —— 模型白名单与每分钟限流是
 *    多租户时代的产物，已随初心裁剪移除。
 */

/** 存储里的 key 记录（哈希 + 加密明文 + 展示前缀）。 */
export interface ApiKeyRecord {
  id: string;
  /** 用户给的备注名（便于区分用途，如 "ci" / "笔记本"）。 */
  name: string;
  /** 明文前 8 位（`mmx_xxxxxxxx`），列表展示用。 */
  prefix: string;
  /**
   * 明文的**密文**（AES-256-GCM，见 api-key-crypto.ts）。
   *
   * 为什么需要回读：列表的行内复制要给出完整 key，一键接入要把它写进客户端
   * 配置 —— 只有哈希时这两件事都做不到。为什么不存明文：备份 / 快照 / 支持包 /
   * 日志采集会带走整个数据文件，明文等于直接交出可用凭据（CWE-256）。
   * 加密密钥单独落 OS 配置目录（0600），拿到数据文件也解不开。
   * 早期记录没有这个字段，由「重建」补齐。
   */
  secretSealed?: string | null;
  /** scrypt 摘要（16 字节 hex）；校验时按前缀索引候选再恒时比对。 */
  keyHash: string;
  createdAt: string;
}

/** 校验结果：通过时给出命中的记录。 */
export type ApiKeyDecision =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; reason: "invalid"; message: string };

/** 门禁端口：组合根注入实现（本机文件形态）。 */
export interface ApiKeyGuard {
  /** 鉴权一次判完（只判「这把 key 是否有效」，不再判模型白名单与限流）。 */
  check(apiKey: string | null): Promise<ApiKeyDecision>;
}

let guard: ApiKeyGuard | null = null;

/** 注入实现（组合根装配时调用）。 */
export function setApiKeyGuard(next: ApiKeyGuard | null): void {
  guard = next;
}

/**
 * 当前门禁实现；未装配时返回 `null`（测试用）。
 *
 * 调用方**必须**把 null 当「拒绝服务」处理，不能放行：装配顺序错了就静默关闭鉴权，
 * 比明确失败危险得多（见 relay.ts 的 `withApiKeyGuard`）。
 */
export function apiKeyGuard(): ApiKeyGuard | null {
  return guard;
}

/** 仅供测试清空门禁（生产路径不许调用）。 */
export function resetApiKeyGuard(): void {
  guard = null;
}
