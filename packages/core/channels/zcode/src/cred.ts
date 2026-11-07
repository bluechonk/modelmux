/**
 * ZCode 凭据：OAuth 轮询登录（JWT 首选 + API Key 兑换回退）+ 有效性探测。
 *
 * 关键约束（端点/字段/实测见 docs/channels/zcode/PROTOCOL.md）：
 *   - 无续期端点：`refresh()` 只做有效性探测，失效抛错 —— 不假装续期成功。
 *   - 模式随凭据而异（jwt / apiKey），对话端点与鉴权头都由模式决定，`upstream` 读 `currentMode()`。
 *
 * 铁律：绝不虚构凭据；登录只走本渠道真实授权链路，不读外部应用本地文件。
 */

import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  loginFlow,
  pasteDetect,
  writeJsonSecret,
  type Credential,
} from "@modelmux/gateway";

/** OAuth 与对话凭据的基座域（授权页 / OAuth API / 计费都在它下面）。 */
export const SITE_BASE = "https://zcode.z.ai";
/** OAuth init / poll 的 API 基址。 */
export const API_BASE = `${SITE_BASE}/api/v1`;
/** 计费基址（额度查询与凭据有效性探测）。 */
export const BILLING_BASE = `${SITE_BASE}/api/v1/zcode-plan`;
/** api.z.ai 兑换域（API Key 模式的对话上游，也是兑换链路的宿主）。 */
export const ZAI_API_BASE = "https://api.z.ai";
/** 官方客户端身分（参考实现写死，头族见 PROTOCOL §2.2）。 */
export const CLIENT_USER_AGENT = "ZCode/3.0.1";

/** 凭据模式：Coding Plan JWT（首选）或 zcode-api-key（回退）。 */
export type CredMode = "jwt" | "apiKey";

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  readonly accessToken: string;
  /** JWT `sub`（解析不出为空串；空串时账号池 key 退化为按 token 派生）。 */
  readonly uid: string;
  /** jwt 模式 `zcode.z.ai`，apiKey 模式 `api.z.ai`。 */
  readonly domain: string;
  readonly mode: CredMode;
  /** 兑换到的 API Key（尽力而为，jwt 模式下可能为空）。 */
  readonly apiKey: string;
  /** JWT `exp`（毫秒；解析不出为 `null` —— 无静默续期，仅展示）。 */
  readonly expireAt: number | null;
  /**
   * 账号池展示名（人读）。
   *
   * 上游**没有**可读身份字段可拿（2026-11-07 实测：JWT 只含 `sub`/`user_id`；
   * `zcode-plan` 下 user/me/profile/account 全部 404；`/billing/current` 只有 `plans`；
   * `getCustomerInfo` 需要 zcode JWT 换不出的业务 token），所以不做「假装拿到昵称」，
   * 而是给出**能区分账号且人读**的形态：`ZCode · JWT · 87448da0`。
   * 池层的 `NAME_FIELDS` 认 `nickname` 字段，故这里用它承载（零改动自动进 label）。
   */
  readonly nickname: string;
}

/**
 * 生成人读展示名：模式 + uid 前 8 位。
 *
 * 为什么不用完整 UUID：账号池一行只放得下一个短标识，完整值在详情浮层与凭据文件里
 * 都能看到；而裸 UUID 既占宽又无从辨认。前 8 位在同一账号池里足够区分（UUIDv4 前缀
 * 碰撞概率可忽略）。
 */
function displayNameOf(mode: CredMode, uid: string): string {
  const short = uid.replace(/-/g, "").slice(0, 8);
  if (short === "") return `ZCode · ${mode === "jwt" ? "JWT" : "API Key"}`;
  return `ZCode · ${mode === "jwt" ? "JWT" : "API Key"} · ${short}`;
}

/** 契约要求：登录与上游共用的默认基址。 */
export const DEFAULT_BASE_URL = API_BASE;

/** 契约的 `resolveBaseUrl(realm)`：单区域渠道，恒返回同一基址。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return API_BASE;
}

// ── 最近身份（供 upstream 选端点） ─────────────────────────────────────────────

/**
 * 最近一次加载的凭据模式。
 *
 * 为什么需要：对话端点按模式分 host（jwt → zcode.z.ai，apiKey → api.z.ai），但网关的
 * `chatUrl()` / `buildChatBody()` 签名拿不到凭据。与 qodercn 的 `activeRealm` 同款：
 * 凭据加载/登录时记下，`buildHeaders(credential)` 再校正一次兜住切换账号的窗口。
 */
let lastMode: CredMode = "jwt";

/** 当前生效凭据的模式（upstream 选对话端点用）。 */
export function currentMode(): CredMode {
  return lastMode;
}

function rememberMode(mode: CredMode): void {
  if (mode === "jwt" || mode === "apiKey") lastMode = mode;
}

// ── 凭据读写 ──────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 按凭证形状判模式（参考实现同判据：两处点号 = JWT 3 段）。
 *
 * 判错模式的代价不是崩溃而是 401：JWT 拿去当 x-api-key、API Key 拿去当 Bearer
 * 都会被上游拒，refresh 探测后提示重新登录即可。
 */
function modeOf(secret: string): CredMode {
  return secret.split(".").length === 3 ? "jwt" : "apiKey";
}

/** 读凭据；未登录 / 文件损坏都抛 `NotLoggedInError`（共享层靠它判断「没东西」）。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `mx login zcode` to authorize in the browser");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const accessToken = str(parsed["accessToken"]);
  if (!accessToken) throw new NotLoggedInError("Credential has no access_token, please log in again");
  const mode = parsed["mode"] === "apiKey" ? "apiKey" : modeOf(accessToken);
  rememberMode(mode);
  const uid = str(parsed["uid"]);
  const stored = str(parsed["nickname"]);
  const nickname = stored || displayNameOf(mode, uid);
  // 老凭据（升级前登录）没有 nickname：**补出后回写**，否则账号池的 label 刷新
  // 读不到新字段（`refreshLabels` 从凭据文件取 `NAME_FIELDS`），UUID 会一直显示下去。
  // 写失败不影响本次读取：内存里已经是可读值，下一次 load 再试。
  if (stored === "" && uid !== "") {
    try {
      save({ accessToken, uid, domain: str(parsed["domain"]) || (mode === "jwt" ? "zcode.z.ai" : "api.z.ai"), mode, apiKey: str(parsed["apiKey"]), expireAt: shared.parseExpireTime(parsed["expireAt"]), nickname });
    } catch {
      /* 回写是尽力而为：只读路径不能因为写盘失败而失败 */
    }
  }
  return {
    accessToken,
    uid,
    // 老凭据缺 domain 时按模式补默认值，不拒绝整条凭据（契约 §5.1）
    domain: str(parsed["domain"]) || (mode === "jwt" ? "zcode.z.ai" : "api.z.ai"),
    mode,
    apiKey: str(parsed["apiKey"]),
    expireAt: shared.parseExpireTime(parsed["expireAt"]),
    nickname,
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断「已登录」）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  rememberMode(credential.mode);
  writeJsonSecret(credentialsPath(), credential);
}

// ── 登录 ─────────────────────────────────────────────────────────────────────

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /** 测试注入的 sleep（不起真实定时器）。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 取走用户粘回的浏览器回调内容（可选，一次性消费）。
   *
   * OAuth 轮询流**没有本机回环**：令牌由服务端按 `flow_id` 下发，浏览器不回调本机。
   * 故粘回内容只作「浏览器那一步已完成」的信号 —— 转交**同一个轮询处理器**立刻再
   * 轮询一次，**不是**第二条登录路径。
   */
  pasteCode?: () => string | undefined;
}

/** 轮询 `ready` 时拿到的原始凭证。 */
interface OAuthGrant {
  /** Coding Plan JWT（可能为空 —— 此时只能走兑换出的 API Key）。 */
  jwt: string;
  /** 用于兑换 API Key 的 OAuth access token。 */
  zaiAccessToken: string;
}

/** 安全取字符串字段（非字符串一律空串，不抛错）。 */
function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 响应信封里取 `data`（对象形态；不是对象回空）。 */
function dataOf(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload["data"];
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * API Key 兑换链路（PROTOCOL §1.2）：业务 token → 机构/项目 → 查/建 key → 复制出 secretKey。
 *
 * 尽力而为：任何一步失败都抛错由调用方吞掉 —— JWT 已到手就不该被回退凭证拖死登录。
 * 「默认机构/默认项目」优先，缺失退第一个；key 名固定 `zcode-api-key`（参考实现同款）。
 */
async function exchangeApiKey(zaiAccessToken: string): Promise<string> {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const loginResp = await shared.fetchWithTimeout(
    `${ZAI_API_BASE}/api/auth/z/login`,
    { method: "POST", headers, body: JSON.stringify({ token: zaiAccessToken }) },
    20_000,
  );
  if (!loginResp.ok) throw new Error(`z.ai login failed: HTTP ${loginResp.status}`);
  const biz = dataOf((await loginResp.json()) as Record<string, unknown>);
  const bizToken = strOf(biz["access_token"]) || strOf(biz["accessToken"]);
  if (!bizToken) throw new Error("z.ai login response has no business token");

  const auth = { Accept: "application/json", Authorization: `Bearer ${bizToken}` };
  const infoResp = await shared.fetchWithTimeout(
    `${ZAI_API_BASE}/api/biz/customer/getCustomerInfo`,
    { headers: auth },
    20_000,
  );
  if (!infoResp.ok) throw new Error(`getCustomerInfo failed: HTTP ${infoResp.status}`);
  const info = dataOf((await infoResp.json()) as Record<string, unknown>);
  const orgs = Array.isArray(info["organizations"]) ? (info["organizations"] as Array<Record<string, unknown>>) : [];
  // 「默认机构/默认项目」优先（参考实现同口径），缺失退第一个
  const org = orgs.find((o) => strOf(o["organizationName"]).includes("默认机构")) ?? orgs[0];
  if (!org) throw new Error("no z.ai organization available");
  const projects = Array.isArray(org["projects"]) ? (org["projects"] as Array<Record<string, unknown>>) : [];
  const project = projects.find((p) => strOf(p["projectName"]).includes("默认项目")) ?? projects[0];
  if (!project) throw new Error("no z.ai project available");
  const keyUrl =
    `${ZAI_API_BASE}/api/biz/v1/organization/${encodeURIComponent(strOf(org["organizationId"]))}` +
    `/projects/${encodeURIComponent(strOf(project["projectId"]))}/api_keys`;

  const keysResp = await shared.fetchWithTimeout(keyUrl, { headers: auth }, 20_000);
  if (!keysResp.ok) throw new Error(`list api keys failed: HTTP ${keysResp.status}`);
  const listBody = (await keysResp.json()) as Record<string, unknown>;
  // 参考实现的取法：`res.json().get("data") or []` —— 清单就在 `data`（数组）
  const keysList = Array.isArray(listBody["data"]) ? (listBody["data"] as Array<Record<string, unknown>>) : [];
  let keyObj = keysList.find((k) => strOf(k["name"]) === "zcode-api-key");
  if (!keyObj) {
    const createResp = await shared.fetchWithTimeout(
      keyUrl,
      {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify({ name: "zcode-api-key" }),
      },
      20_000,
    );
    if (!createResp.ok) throw new Error(`create api key failed: HTTP ${createResp.status}`);
    const created = (await createResp.json()) as Record<string, unknown>;
    keyObj = (created["data"] && typeof created["data"] === "object" ? created["data"] : created) as Record<string, unknown>;
  }
  const apiKey = strOf(keyObj?.["apiKey"]);
  if (!apiKey) throw new Error("created api key has no apiKey field");

  const copyResp = await shared.fetchWithTimeout(
    `${keyUrl}/copy/${encodeURIComponent(apiKey)}`,
    { headers: auth },
    20_000,
  );
  if (!copyResp.ok) throw new Error(`copy api key failed: HTTP ${copyResp.status}`);
  const secretKey = strOf(dataOf((await copyResp.json()) as Record<string, unknown>)["secretKey"]);
  if (!secretKey) throw new Error("copied api key has no secretKey");
  return `${apiKey}.${secretKey}`;
}

/**
 * 完整 OAuth 轮询登录（PROTOCOL §1.1）：init 拿授权页 → 用户浏览器授权 → 轮询 ready
 * → JWT 优先、API Key 兑换尽力 → 落盘。
 *
 * 轮询终态判据：HTTP 2xx 且 `status` 字段决定（pending / ready / failed）；
 * 4xx（除 408/429）为终态失败，5xx 与网络错误继续重试（共享骨架的失败计数兜底）。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  void baseUrl; // 单区域渠道：端点写死，入参只为满足契约签名
  const pollToken = shared.randomHex(32);

  const initResp = await shared.fetchWithTimeout(
    `${API_BASE}/oauth/cli/init`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ provider: "zai" }),
    },
    20_000,
  );
  if (!initResp.ok) throw new Error(`OAuth init failed: HTTP ${initResp.status}`);
  const initData = dataOf((await initResp.json()) as Record<string, unknown>);
  const flowId = strOf(initData["flow_id"]);
  const authorizeUrl = strOf(initData["authorize_url"]);
  if (!flowId || !authorizeUrl) throw new Error("OAuth init response is incomplete (flow_id/authorize_url)");

  options.onUrl?.(authorizeUrl);
  options.onStatus?.(
    "ZCode: open the URL above in your browser to authorize" +
      (options.pasteCode
        ? " — after authorizing you can paste the browser address bar back here to finish immediately."
        : ""),
  );

  let pasteReported = false;
  const grant = await loginFlow.pollDeviceCode<OAuthGrant>({
    intervalMs: 2000,
    expiresInSec: 600,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    attempt: async () => {
      // 粘贴兜底：认出「授权被拒」立刻收尾；否则只当「浏览器已完成」信号再轮询一次
      const pasted = options.pasteCode?.();
      if (typeof pasted === "string" && pasted.trim()) {
        const reason = pasteDetect.pastedAuthFailureReason(pasted);
        if (reason) return { kind: "fatal", error: new Error(`browser authorization failed: ${reason}`) };
        if (!pasteReported) {
          options.onStatus?.("已收到粘回的回调，正在等待授权结果...");
          pasteReported = true;
        }
      }
      const resp = await shared.fetchWithTimeout(
        `${API_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        { headers: { Authorization: `Bearer ${pollToken}`, Accept: "application/json" } },
        20_000,
      );
      // 4xx（除 408/429）= flow 无效等终态；408/429/5xx/网络错误交给骨架按可重试处理
      if (resp.status >= 400 && resp.status !== 408 && resp.status !== 429) {
        return { kind: "fatal", error: new Error(`OAuth polling failed: HTTP ${resp.status}`) };
      }
      if (!resp.ok) return { kind: "pending" };
      const data = dataOf((await resp.json()) as Record<string, unknown>);
      const status = strOf(data["status"]);
      if (status === "failed") return { kind: "fatal", error: new Error("authorization failed in browser") };
      if (status !== "ready") return { kind: "pending" };
      const zai = data["zai"] && typeof data["zai"] === "object" ? (data["zai"] as Record<string, unknown>) : {};
      return {
        kind: "done",
        value: { jwt: strOf(data["token"]), zaiAccessToken: strOf(zai["access_token"]) },
      };
    },
  });

  // JWT 首选；没有 JWT 才尝试兑换 API Key（两条凭证来源互为兜底）
  let apiKey = "";
  let mode: CredMode = "jwt";
  if (grant.jwt) {
    if (grant.zaiAccessToken) {
      try {
        apiKey = await exchangeApiKey(grant.zaiAccessToken);
      } catch {
        // 兑换失败不影响 JWT 登录（参考实现同口径）：回退凭证缺失只损失 apiKey 模式
      }
    }
  } else if (grant.zaiAccessToken) {
    apiKey = await exchangeApiKey(grant.zaiAccessToken);
    mode = "apiKey";
  }
  const accessToken = grant.jwt || apiKey;
  if (!accessToken) throw new Error("authorization ready but no credential was returned");

  const credential: Credentials = {
    accessToken,
    uid: mode === "jwt" ? shared.jwtSubject(accessToken) : "",
    domain: mode === "jwt" ? "zcode.z.ai" : "api.z.ai",
    mode,
    apiKey,
    // jwtExpMs 无 exp 时回 0：归一成 null，语义是「不知道」而不是「已过期」
    expireAt: mode === "jwt" ? shared.jwtExpMs(accessToken) || null : null,
    nickname: displayNameOf(mode, mode === "jwt" ? shared.jwtSubject(accessToken) : ""),
  };
  await save(credential);
  options.onStatus?.(`已登录 ZCode（${mode === "jwt" ? "JWT 模式" : "API Key 模式"}）`);
  return credential;
}

// ── 有效性探测（无续期端点的渠道，refresh() = 探测，契约 §5.1） ─────────────────

/**
 * 探测凭据是否仍被上游接受：打计费端点（不发对话请求、不耗额度）。
 *
 * - 401/403 → `NotLoggedInError`（共享层走「提示重新登录」链路）
 * - 其余失败（5xx/网络）→ 普通 Error，按可重试处理
 * - 2xx → 原凭据返回（没有新 token 可换，不假装续期）
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (credential.mode === "jwt") headers["Authorization"] = `Bearer ${credential.accessToken}`;
  else headers["x-api-key"] = credential.accessToken;
  let resp: Response;
  try {
    resp = await shared.fetchWithTimeout(`${BILLING_BASE}/billing/current`, { headers }, 20_000);
  } catch (err) {
    throw new Error(`Credential probe failed (retryable): ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new NotLoggedInError("credential rejected by upstream, please run `mx login zcode` again");
  }
  if (!resp.ok) throw new Error(`Credential probe failed: HTTP ${resp.status} (retryable)`);
  return credential;
}
