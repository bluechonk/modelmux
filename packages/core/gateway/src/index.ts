/**
 * `@modelmux/gateway`：各渠道 bridge 共享的 gateway 层。
 *
 * 对外导出各模块，供 bridge 入口与测试按需引入。渠道差异通过 `setChannel()`
 * 注册的 `Channel` 注入 —— 本包不 import 任何渠道模块。
 */

export * as authFlow from "./auth/auth-flow.js";
export * as autoSignin from "./auth/auto-signin.js";
export * as cli from "./app/cli/index.js";
export * as consoleApi from "./http/console/console.js";
export * as daemon from "./app/lifecycle/daemon.js";
export * as gateway from "./http/server.js";
export * as headless from "./app/lifecycle/headless.js";
export * as login from "./auth/login.js";
export * as loginFlow from "./auth/login-flow.js";
export * as modelFamily from "./pool/model-policy.js";
// 粘贴兜底的文本识别（授权失败页 / 授权码提取；与渠道无关的字符串启发式）
export * as pasteDetect from "./auth/paste-detect.js";
export type { PastedCallback } from "./auth/paste-detect.js";
// 通用 OpenAI 请求体归一化（与上游无关的形状修复；渠道判据由渠道传入）
export * as openaiNormalize from "./http/wire/openai-normalize.js";
export * as paths from "./runtime/paths.js";
export * as portfree from "./http/portfree.js";
export * as report from "./app/cli/report.js";
export * as sseStream from "./http/wire/sse-stream.js";

// 渠道注册表
export {
  setChannel,
  getChannel,
  hasChannel,
  channels,
  channelFor,
  channelCount,
  clearChannels,
  channelCapabilities,
  type ChannelCapabilities,
  type ChannelConfig,
  type Channel,
  type Credential,
  type CredModule,
  type UpstreamModule,
  type CatalogModule,
  type BillingModule,
  type UpstreamConfig,
  type CreditsResult,
  type CreditPackage,
  type LoginUi,
  type LoginInputRequest,
  type StreamTranslator,
  type SigninModule,
  type SigninStatus,
  type SigninOutcome,
  type QuotaPeriod,
  type QuotaSignal,
} from "./runtime/channel.js";

// 原子写盘（含密文件与上游连接配置共用）
export { writeSecretFile, writeJsonSecret, writeJsonFile } from "./runtime/secret-file.js";

// 签到台账（本地记"我们最后一次领到是什么时候"）
export * as signinLedger from "./auth/signin-ledger.js";
export type { SigninLedger, ClaimRecord } from "./auth/signin-ledger.js";

// 账号池（一个渠道下多个账号）
export * as accounts from "./runtime/account-pool.js";
export type { PoolAccount, PoolIndex, AccountHealth } from "./runtime/account-pool.js";

// 远端目录的磁盘缓存（渠道层内 cache/models.json）
export {
  CATALOG_CACHE_FILE,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
  catalogCacheFetchedAt,
} from "./runtime/catalog-cache.js";
export type { CachedModel } from "./runtime/catalog-cache.js";

// 渠道目录里的名字 → 上游 slug
export { resolvePoolModel } from "./pool/model-pool.js";

// 公共模型池：`<cid>/<模型>` 池 id + 归一化匹配
export {
  POOL_MODELS,
  canonicalModelId,
  asPoolModel,
  parsePoolModel,
  poolModelId,
  poolCandidates,
  type PoolModel,
  type PoolCandidate,
} from "./pool/pool-targets.js";

// 公共模型池的账本（账单已用量 + 失败冷却；落 <root>/pool-usage.json）
export * as poolUsage from "./pool/pool-usage.js";
export type { PoolLedger, ChannelLedger, RefreshResult } from "./pool/pool-usage.js";

// 渠道上下文（调用渠道模块前包一层，让渠道内部的 paths.* 解析到自己的落点）
export { runInChannel, activeCid } from "./runtime/channel-context.js";

// 默认值（随注册的渠道而变）
export {
  version,
  defaultAddr,
  defaultUiPort,
  REPO_DEFAULT_ADDR,
  REPO_UI_PREFIX,
} from "./runtime/cli-consts.js";

// 服务身份（池路由入口在 pool-targets.ts）
export { serviceName, knownServiceNames, IMPLEMENTATION } from "./http/server.js";

// 落点与凭据路径（渠道模块常用）
export {
  ROOT_DIR_NAME,
  ROOT_ENV,
  FILES,
  SUBDIRS,
  rootDir,
  channelDir,
  rootDirFor,
  channelDirFor,
  channelFile,
  rootFile,
  rootPidPath,
  rootLogPath,
  poolUsagePath,
  cacheDir,
  stateDir,
  debugDir,
  ensureCacheDir,
  ensureStateDir,
  ensureDir,
  rootPrefsPath,
  logPath,
  pidPath,
  prefsPath,
  credentialsPath,
  upstreamPath,
} from "./runtime/paths.js";

// CLI 入口
export { main, usage } from "./app/cli/index.js";
