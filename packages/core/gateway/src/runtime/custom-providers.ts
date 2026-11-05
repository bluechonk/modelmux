/**
 * 自定义提供商：把任意 OpenAI 兼容端点接进模型池（运行时渠道，注册表驱动）。
 *
 * 约束：注册表 `~/.modelmux/custom/providers.json`（0600）是唯一事实源；
 * 模型数据只在注册表里；无额度概念（capabilities.billing=false）；
 * key 不落日志（回显只给指纹）。内置渠道是静态包，不受本模块约束。
 *
 * 文档：docs/CONTRACT-TS.md、docs/STORAGE-CONVENTION.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonSecret } from "./secret-file.js";
import { credentialsPath, rootDir } from "./paths.js";
import { keyUid, syncKeyAccounts } from "./account-pool.js";
import {
  channels as registryChannels,
  deleteChannel,
  hasChannel,
  setChannel,
  type BillingModule,
  type CatalogModule,
  type Channel,
  type ChannelConfig,
  type CredModule,
  type UpstreamModule,
} from "./channel.js";

const REPO_VERSION = "0.1.2";

/** 自定义提供商的模型条目（用户填的内置表，也是「获取可用模型」的落点）。 */
export interface CustomModel {
  id: string;
  /** 展示名（模型列表/日志用）；缺省回落 id。 */
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 输入模态（缺省 ["text"]）；可填 "image" 表示可吃图。 */
  inputModalities?: string[];
}

/** 自定义提供商的一个 API key（= 账号池里的一个账号）。 */
export interface ProviderKey {
  key: string;
  /** 可选备注名（账号行显示它，缺省显示 key 指纹）。 */
  label?: string;
}

/** 一个自定义提供商（= 一个运行时渠道实例）。 */
export interface CustomProvider {
  /** 渠道 id（用户自定，规则同内置 cid：小写字母开头，`[a-z0-9-]`）。 */
  id: string;
  display: string;
  /** OpenAI 兼容基址，如 `https://api.longcat.chat/openai`。 */
  baseUrl: string;
  protocol: "openai";
  /** 多 API key：一个 key = 账号池一个账号（读时兼容旧单值 apiKey）。 */
  apiKeys: ProviderKey[];
  models: CustomModel[];
  createdAt: string;
  updatedAt: string;
}

/** key 指纹（账号行显示用；不回显原文）。 */
export function keyFingerprint(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "****";
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/** 兼容旧注册表：单值 `apiKey` 自动迁移成 `apiKeys` 一项。 */
function normalizeProvider(p: CustomProvider | (Record<string, unknown> & { apiKey?: unknown })): CustomProvider {
  const raw = p as Record<string, unknown>;
  if (!Array.isArray(raw["apiKeys"])) {
    const legacy = typeof raw["apiKey"] === "string" && raw["apiKey"].trim() !== "" ? [{ key: raw["apiKey"] as string }] : [];
    raw["apiKeys"] = legacy;
  }
  delete raw["apiKey"];
  return p as CustomProvider;
}

/**
 * 池同步用的 key 列表：label 缺省回落**指纹**（永不把 key 原文当展示名 ——
 * 账号行会把它整条显示出来，既是泄露也是噪声）。
 */
function labeledKeys(provider: CustomProvider): Array<{ key: string; label: string }> {
  return provider.apiKeys.map((k) => ({
    key: k.key,
    label: k.label?.trim() || keyFingerprint(k.key),
  }));
}

/** 读注册表：缺失 / 损坏一律当空（首次使用或手改坏时不应让网关起不来）。 */
export function readCustomProviders(): CustomProvider[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(providersPath(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isCustomProvider).map(normalizeProvider);
  } catch {
    return [];
  }
}

function isCustomProvider(value: unknown): value is CustomProvider {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  // apiKeys 数组（新）或 apiKey 单值（旧）至少认一种；两者都缺视为未填 key（合法，登录时补）
  const keysShape = p["apiKeys"] === undefined || Array.isArray(p["apiKeys"]);
  const legacyShape = p["apiKey"] === undefined || typeof p["apiKey"] === "string";
  return (
    typeof p["id"] === "string" &&
    typeof p["display"] === "string" &&
    typeof p["baseUrl"] === "string" &&
    p["protocol"] === "openai" &&
    keysShape &&
    legacyShape &&
    Array.isArray(p["models"])
  );
}

/**
 * 原子写注册表（0600）。空数组也写：删掉最后一个提供商是合法操作。
 *
 * 先建 `custom/` 目录：`~/.modelmux/custom` 默认不存在，直接写会 ENOENT ——
 * 而写失败若从请求回调里抛出去，会把网关进程带崩（实测 worker 反复退出）。
 */
export function writeCustomProviders(list: CustomProvider[]): void {
  mkdirSync(dirname(providersPath()), { recursive: true });
  writeJsonSecret(providersPath(), list);
}

function providersPath(): string {
  return join(rootDir(), "custom", "providers.json");
}

// ── 展示与校验 ────────────────────────────────────────────────────────────

/** key 脱敏：只给首尾，界面用于确认「已填过」（原文永不回显）。 */
export function maskKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * 生效 key：`credentials.json`（与真实渠道同构的生效凭据，账号池切换就改它）
 * → 回退注册表第一个 key（尚未同步入池时也能用）。
 */
export function activeKeyOfProvider(providerId: string): string {
  const record = findCustomProvider(providerId);
  if (!record) return "";
  try {
    const cred = JSON.parse(readFileSync(credentialsPath(providerId), "utf8")) as Record<string, unknown>;
    const active = typeof cred["accessToken"] === "string" ? cred["accessToken"] : "";
    if (active && record.apiKeys.some((k) => k.key === active)) return active;
  } catch {
    /* 无生效凭据文件 / 损坏：回退注册表第一个 */
  }
  return record.apiKeys[0]?.key ?? "";
}

/**
 * 把「生效 key 写进 credentials.json」——账号池 activateAccount 的复制语义之外的程序化写法。
 *
 * `uid` 必须用与账号文件相同的派生（`keyUid`）：两处不一致时 syncPool 会从凭据
 * 派生出池里不存在的幽灵账号。
 */
export function writeActiveKeyProvider(providerId: string, key: string): void {
  mkdirSync(dirname(credentialsPath(providerId)), { recursive: true });
  writeJsonSecret(credentialsPath(providerId), {
    accessToken: key,
    uid: keyUid(key),
    domain: providerId,
  });
}

/**
 * 新建/编辑表单的服务端校验。
 *
 * 返回 null = 通过；否则是给人看的错误文案（直接进 400 响应）。
 * 与内置渠道重名不在这一层拦（共享层不许硬编码渠道 id）：注册时跳过并让内置生效。
 */
export function validateProvider(p: CustomProvider): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(p.id)) {
    return "Provider ID 需以小写字母开头，仅含小写字母、数字与连字符";
  }
  if (!p.display.trim()) return "显示名称必填";
  if (!/^https?:\/\//.test(p.baseUrl)) return "API 地址需以 http(s):// 开头";
  if (p.protocol !== "openai") return "当前仅支持 OpenAI 兼容协议";
  const keys = new Set<string>();
  for (const item of p.apiKeys) {
    const key = item.key.trim();
    if (!key) return "存在空 API Key";
    if (keys.has(key)) return `API Key 重复：${keyFingerprint(key)}`;
    keys.add(key);
  }
  const ids = new Set<string>();
  for (const m of p.models) {
    if (!m.id.trim()) return "存在空模型 ID";
    if (ids.has(m.id)) return `模型 ID 重复：${m.id}`;
    ids.add(m.id);
  }
  return null;
}

// ── 运行时注册 ────────────────────────────────────────────────────────────

/**
 * 把注册表里的每个提供商注册成运行时渠道（同 id 覆盖，已删除的自然消失）。
 *
 * 启动时调一次；控制台的增删改之后调 `reloadCustomProviders()`。
 */
/**
 * 本进程内已注册的自定义渠道 cid。
 *
 * 用来区分「与内置渠道重名」和「重新注册我们自己」—— 共享层不允许硬编码渠道 id
 * （verify-wiring 会拦），所以只能靠运行时记住自己注册过哪些。
 */
const registeredCustomCids = new Set<string>();

export function registerCustomProviders(): void {
  for (const provider of readCustomProviders()) {
    if (hasChannel(provider.id) && !registeredCustomCids.has(provider.id)) {
      // 与内置渠道重名：不覆盖内置注册（内置渠道是编译期事实，自定义只能换 id）
      continue;
    }
    setChannel(customChannelFor(provider));
    registeredCustomCids.add(provider.id);
    // 启动 / 重挂时同步 key→账号池（幂等）：注册表是事实源，池只是投影
    syncKeyAccounts(provider.id, labeledKeys(provider));
  }
  // 注意：`/v1/models` 读的是目录快照**文件**，注册后需要在上层（app/http）
  // 显式 `refreshCatalog()` —— 本模块在最底层，不能反向依赖 pool 层。
}

/**
 * 增删改后整体重注册：先清掉本进程内所有自定义渠道，再按最新注册表重挂。
 *
 * 为什么不逐个 diff：注册表是整体原子写的，重挂一遍最简单且不会漏
 * （自定义渠道数量是用户自定的，通常为个位数）。
 */
export function reloadCustomProviders(): void {
  for (const channel of channelsSnapshot()) {
    if (isCustomCid(channel.config.cid)) deleteChannel(channel.config.cid);
  }
  registerCustomProviders();
}

/** 本进程内已注册的渠道快照（`channels()` 的只读副本）。 */
function channelsSnapshot(): Channel[] {
  return [...registryChannels()];
}

/** 自定义 cid 的识别：注册表里存在的 id 才是自定义渠道。 */
function isCustomCid(cid: string): boolean {
  return readCustomProviders().some((p) => p.id === cid);
}

// ── 增删改 ────────────────────────────────────────────────────────────────

export function saveCustomProvider(provider: CustomProvider): void {
  const list = readCustomProviders();
  const now = new Date().toISOString();
  // 统一落 apiKeys 形态（旧单值 apiKey 字段不写盘）
  const raw = { ...provider, apiKeys: provider.apiKeys ?? [], updatedAt: now, createdAt: provider.createdAt || now } as CustomProvider & { apiKey?: unknown };
  delete raw.apiKey;
  const next = raw as CustomProvider;
  const index = list.findIndex((p) => p.id === next.id);
  if (index >= 0) list[index] = next;
  else list.push(next);
  writeCustomProviders(list);
  reloadCustomProviders();
  // 一个 key = 池里一个账号：注册表是事实源，保存即同步（新增/移除/换生效 key）
  syncKeyAccounts(next.id, labeledKeys(next));
}

export function removeCustomProvider(id: string): void {
  writeCustomProviders(readCustomProviders().filter((p) => p.id !== id));
  reloadCustomProviders();
  // 渠道没了：清空该 cid 的池账号与生效凭据（同步空列表即全清）
  syncKeyAccounts(id, []);
}

/** 单个提供商的当前记录（编辑表单回显用）。 */
export function findCustomProvider(id: string): CustomProvider | undefined {
  return readCustomProviders().find((p) => p.id === id);
}

// ── 远端模型拉取（「获取可用模型」）────────────────────────────────────────

/**
 * `GET {baseUrl}/models`（OpenAI 兼容），返回 `{id, ...}` 列表。
 *
 * 失败抛错（调用方在 UI 上提示），不静默返回空 —— 空列表与「拉取失败」
 * 在界面上必须可区分。
 */
export async function fetchCustomModels(baseUrl: string, apiKey: string): Promise<CustomModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const resp = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`模型列表请求失败：HTTP ${resp.status}`);
  const body: unknown = await resp.json().catch(() => null);
  const list =
    body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)["data"])
      ? ((body as Record<string, unknown>)["data"] as unknown[])
      : [];
  const out: CustomModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>)["id"];
    if (typeof id !== "string" || id.trim() === "") continue;
    out.push({ id });
  }
  if (out.length === 0) throw new Error("上游返回的模型列表为空");
  return out;
}

// ── 动态渠道装配 ──────────────────────────────────────────────────────────

/** 错误类型：key 缺失（登录流程据此提示用户）。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message = "自定义提供商尚未填写 API Key") {
    super(message);
  }
}

/** 上游 401/403（key 失效）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
  constructor(message = "上游拒绝：API Key 无效或已过期") {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 环境变量兜底名：`<CID 大写，非字母数字转 _>_API_KEY`。 */
function envKeyFor(cid: string): string {
  return `${cid.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function baseOf(provider: CustomProvider): string {
  return provider.baseUrl.replace(/\/+$/, "");
}

/**
 * 由提供商记录组装 `Channel`。
 *
 * 四个模块都是**每次调用新生成**的对象（闭包持有 provider 记录）：
 * 这样编辑提供商后重注册即生效，不需要重建模块实例。
 */
export function customChannelFor(provider: CustomProvider): Channel {
  const cid = provider.id;
  const base = baseOf(provider);

  const cred: CredModule = {
    DEFAULT_BASE_URL: provider.baseUrl,
    NotLoggedInError,
    load: () => {
      const key = activeKeyOfProvider(cid);
      if (!key) throw new NotLoggedInError();
      // 除 apiKey 外还回**账号池契约字段**（accessToken / uid / domain）：
      // 池机制按它们派生账号身份（sha256(domain\0uid)）；只回 apiKey 会让
      // syncPool 派生出常量 key，在池里长出幽灵账号（实测踩过）
      return { apiKey: key, accessToken: key, uid: keyUid(key), domain: cid, source: "custom-provider", obtainedAt: nowIso() };
    },
    save: async (c) => {
      // 生效凭据落 credentials.json（与真实渠道同构）：账号池的切换/入池都认这个文件
      const key = String(c.apiKey ?? "");
      if (!key) throw new NotLoggedInError();
      writeActiveKeyProvider(cid, key);
    },
    login: async (_baseUrl, options) => {
      // 幂等：非 force 且已有可用 key 时直接复用
      if (!options?.force) {
        try {
          return cred.load();
        } catch {
          /* 没有就继续问用户要 */
        }
      }
      const fromEnv = process.env[envKeyFor(cid)];
      const input =
        fromEnv ??
        (await options?.requestInput?.({
          kind: "code",
          prompt: `请输入 ${provider.display} 的 API Key`,
        }));
      const apiKey = String(input ?? "").trim();
      if (!apiKey) throw new NotLoggedInError("未填写 API Key");
      // 追加进注册表（一个 key = 池里一个账号）并让它立即生效：
      // saveCustomProvider 内部会 syncKeyAccounts，preferredActive 保证新 key 是生效账号
      const record = findCustomProvider(cid) ?? emptyProvider(cid, provider);
      const next: CustomProvider = record.apiKeys.some((k) => k.key === apiKey)
        ? record
        : { ...record, apiKeys: [...record.apiKeys, { key: apiKey }], updatedAt: nowIso() };
      saveCustomProvider(next);
      syncKeyAccounts(cid, labeledKeys(next), apiKey);
      return { apiKey, source: "custom-provider", obtainedAt: next.updatedAt };
    },
    refresh: async (c) => {
      // 有效性探测：带 key 拉模型列表；只有 401/403 算失效
      const resp = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${String(c.apiKey ?? "")}` },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (resp && (resp.status === 401 || resp.status === 403)) {
        throw new Error(`${provider.display} API Key 已失效（上游 ${resp.status}）`);
      }
      return c;
    },
    resolveBaseUrl: () => base,
  };

  const upstream: UpstreamModule = {
    DEFAULT_BASE_URL: provider.baseUrl,
    WIRE: "openai",
    DISPLAY_NAME: provider.display,
    UpstreamUnauthorized,
    defaultConfig: () => ({ ...provider }),
    loadConfig: () => [findCustomProvider(cid) ?? emptyProvider(cid, provider), true],
    saveConfig: async () => {},
    chatUrl: () => `${base}/chat/completions`,
    modelsUrl: () => `${base}/models`,
    buildHeaders: () => {
      // 每次现读生效 key：账号池切换（credentials.json 改写）立即对上游生效
      const apiKey = activeKeyOfProvider(cid);
      return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    },
    fetchModels: async () => {
      const record = findCustomProvider(cid);
      const apiKey = activeKeyOfProvider(cid);
      if (!record || !apiKey) throw new NotLoggedInError();
      const resp = await fetch(`${baseOf(record)}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`模型列表请求失败：HTTP ${resp.status}`);
      const body: unknown = await resp.json().catch(() => null);
      const list =
        body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)["data"])
          ? ((body as Record<string, unknown>)["data"] as unknown[])
          : [];
      const rows: Record<string, unknown> = {};
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const id = (item as Record<string, unknown>)["id"];
        if (typeof id !== "string" || id.trim() === "") continue;
        rows[id] = { ...(item as Record<string, unknown>), key: id };
      }
      return rows;
    },
    isQueueError: () => false,
    // 以下三个是契约要求的「同一套接口」成员；`WIRE=openai` 时网关不会调用
    // newTranslator，但接口必须齐（同 workbuddyai 的做法）
    buildChatBody: (req, upstreamModel) => ({ ...req, model: upstreamModel }),
    resolveConfig: (data, fallback) => ({ ...(fallback ?? {}), ...(data ?? {}) }),
    newTranslator: () => ({ feed: (chunk: Buffer) => [chunk], finish: () => [] }),
  };

  const catalog: CatalogModule = {
    exposedIds: () => provider.models.map((m) => m.id),
    resolveModel: (name) => name,
    modelSpec: (id) => {
      const m = provider.models.find((row) => row.id === id);
      if (!m) return undefined;
      return {
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        effort: undefined,
        multiplier: undefined,
      };
    },
    refresh: async (): Promise<void> => {
      // 有远端目录：真实拉一次并写缓存（供离线时兜底）；失败抛错（显式刷新必须可见）
      const remote = await fetchCustomModels(provider.baseUrl, activeKeyOfProvider(cid));
      const { writeCatalogCache } = await import("./catalog-cache.js");
      writeCatalogCache(
        remote.map((m) => ({ ...m })),
        cid,
      );
      return;
    },
  };

  const billing: BillingModule = {
    CreditsError: class CreditsError extends Error {},
    fetchCredits: async () => {
      throw new Error(`${provider.display} 无额度概念（自定义提供商不查额度）`);
    },
    signin: {
      status: async () => ({ claimable: null, summary: "自定义提供商无签到端点" }),
      claim: async () => ({ ok: false, summary: "自定义提供商无签到端点" }),
    },
  };

  const config: ChannelConfig = {
    cid,
    display: provider.display,
    version: REPO_VERSION,
    defaultAddr: "127.0.0.1:0",
    uiPort: 0,
    debugDumpEnv: `${cid.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DEBUG_DUMP`,
    capabilities: { billing: false, signin: false },
  };

  return { config, cred, upstream, catalog, billing };
}

/** 新建提供商时的空壳（login 里没有注册表记录时用）。 */
function emptyProvider(id: string, like: CustomProvider): CustomProvider {
  return {
    id,
    display: like.display || id,
    baseUrl: like.baseUrl,
    protocol: "openai",
    apiKeys: [],
    models: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}
