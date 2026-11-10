/**
 * QwenWorkCN 凭据：OAuth 设备授权登录（PKCE S256）+ 续期 + 机器指纹。
 *
 * 关键约束（端点/字段/实测见 docs/channels/qwenworkcn/PROTOCOL.md）：
 *   - 机器指纹**随机生成并持久化**（不按 uid 派生）：多账号互不关联，与参考实现同口径。
 *   - 续期 body 只带 `refresh_token`，**不带 `machine_id`**（对齐参考实现）。
 *   - 设备码流无本机回环：`pasteCode` 只作「浏览器已完成」信号，转交同一轮询处理器再取一次令牌。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
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

/** 本渠道固定绑定的产品区（QwenWorkCN 只有国内站）。 */
const PRODUCT = {
  label: "QwenWorkCN / 千问办公",
  /** 授权页站点。 */
  website: "https://gateway.qwenwork.cn",
  /** 开放 API：轮询 / 续期 / userinfo / 额度 / 签到。 */
  openapi: "https://gateway.qwenwork.cn",
  /** 推理网关（COSY 签名）。 */
  gateway: "https://gateway.qwenwork.cn",
  clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
  redirectUri: "qwenwork-cn://",
  /** 凭据 `domain`（账号池 key 的组成部分）。 */
  domain: "qwenwork.cn",
  userAgent: "qoderwork/1.0.4",
} as const;

/** 契约要求：渠道的默认基址。 */
export const DEFAULT_BASE_URL = PRODUCT.openapi;

/** 默认身份类型（实测值，服务端按它区分试用/正式）。 */
const DEFAULT_USER_TYPE = "personal_professional_trial";

/** 登录轮询的超时与间隔（官方设备码语义）。 */
const POLL_INTERVAL_MS = 1000;
const POLL_EXPIRES_SEC = 300;

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
  /** 有它才可静默续期。 */
  readonly refreshToken: string;
  readonly nickname: string;
  /** COSY 机器指纹（随机生成、落盘持久化；换账号不复用）。 */
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineType: string;
  readonly userType: string;
  /** 最近一次被上游接受的主机（单主机部署，正常为空）。 */
  readonly gatewayHost: string;
  /** 毫秒时间戳；`null` = 上游没给。 */
  readonly expireAt: number | null;
  readonly refreshExpireAt: number | null;
}

/** 契约的 `resolveBaseUrl(realm)`：登录与上游共用的默认基址。 */
export function resolveBaseUrl(_realm?: string): string {
  return PRODUCT.openapi;
}

/** 本渠道的产品配置（upstream 构造签名与请求体时读它）。 */
export function productOf(): typeof PRODUCT {
  return PRODUCT;
}

// ── 机器指纹 ──────────────────────────────────────────────────────────────────

/**
 * 生成一套随机机器指纹。
 *
 * 与 `qodercn` 的「按 uid 派生」不同，这里**随机生成并落盘**：参考实现
 * （`Buddy2api` 的 `providers/qwenwork/store.py`）就是每次新账号
 * 随机一套，不复用、不派生。派生值会把「同一个人」暴露给上游风控，随机值不会。
 */
function makeMachineFingerprint(): { machineId: string; machineToken: string; machineType: string } {
  return {
    machineId: randomUUID(),
    // 50 字节随机 → base64url（无 padding），与参考实现的 `base64.RawURLEncoding` 同形
    machineToken: randomBytes(50).toString("base64url"),
    machineType: randomUUID().replace(/-/g, "").slice(0, 18),
  };
}

/** 缺指纹时补一套并落盘（老凭据升级用；正常路径在登录时就写全了）。 */
function ensureMachineFingerprint(raw: Record<string, unknown>): {
  machineId: string;
  machineToken: string;
  machineType: string;
} {
  const machineId = typeof raw["machineId"] === "string" ? raw["machineId"] : "";
  const machineToken = typeof raw["machineToken"] === "string" ? raw["machineToken"] : "";
  const machineType = typeof raw["machineType"] === "string" ? raw["machineType"] : "";
  if (machineId && machineToken && machineType) {
    return { machineId, machineToken, machineType };
  }
  const generated = makeMachineFingerprint();
  try {
    writeJsonSecret(credentialsPath(), { ...raw, ...generated });
  } catch {
    /* 写不回去也不影响本次使用：内存里这套已经能用于签名 */
  }
  return generated;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

/** PKCE verifier 的字符集（RFC 7636 的 unreserved）。 */
const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * 生成 PKCE 对。
 *
 * challenge = base64url(sha256(verifier)) 且**不带 `=` padding** ——
 * 带 padding 会被服务端判为校验失败。
 */
function makePkce(): { verifier: string; challenge: string } {
  const length = 43 + Math.floor(86 * Math.random()); // 43..128
  const bytes = randomBytes(length);
  let verifier = "";
  for (let i = 0; i < length; i += 1) {
    verifier += PKCE_CHARS[bytes[i]! % PKCE_CHARS.length];
  }
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

/**
 * 上游到期时刻（epoch ms）：优先绝对时刻（`expires_at` / `expiresAt`），否则按 `expires_in`。
 *
 * `expires_in` 的单位在参考实现里是**毫秒**（Go 的 `time.Duration(out.ExpiresIn) * time.Millisecond`），
 * 与常见的秒不同；算出来超过一年视为字段语义不符，宁可不报 —— `null` 在共享层语义是
 * 「不知道」，不会误判成过期（见共享层 `isExpiredAt`）。
 */
function expireAtOf(data: Record<string, unknown>): number | null {
  const absolute = shared.parseExpireTime(data["expires_at"] ?? data["expiresAt"]);
  if (absolute !== null) return absolute;
  const raw = data["expires_in"] ?? data["expiresIn"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw < 366 * 24 * 3600_000 ? Date.now() + raw : null;
}

/**
 * 构造授权页 URL。
 *
 * **必须带 `machine_id`**：实测（2026-11-10）不带它时上游直接
 * `400 INVALID_DEVICE_FLOW / field:query / reason:not_allowed`；补上就 302 到
 * SSO 授权页（`client_id=qwenwork-desktop-app`）。官方桌面端与设备码参考实现
 * （`REALOIYO/dsh-qwenwork-connector`）都带这个参数。
 */
function buildAuthUrl(challenge: string, nonce: string, machineId: string): string {
  const query = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineId,
    client_id: PRODUCT.clientId,
    redirect_uri: PRODUCT.redirectUri,
  });
  return `${PRODUCT.website}/device/selectAccounts?${query.toString()}`;
}

// ── 最近身份（供 upstream 构造请求体） ────────────────────────────────────────

/**
 * 最近一次读到的身份。
 *
 * 为什么需要：`upstream.buildChatBody()` 要填 `aliyun_user_type`，但它的签名（契约固定）
 * **拿不到凭据** —— 凭据是在之后 `buildHeaders()` 阶段才加载的。所以由本模块在
 * `load()` / `login()` / `refresh()` 时记下，上游读这里。
 */
let lastIdentity: { userType: string; gatewayHost: string } = {
  userType: DEFAULT_USER_TYPE,
  gatewayHost: "",
};

/** 当前生效账号的身份类型（请求体 `aliyun_user_type` 用它）。 */
export function currentUserType(): string {
  return lastIdentity.userType;
}

/**
 * 当前生效账号可用的推理主机（空串 = 还没探到）。
 *
 * 为什么要记：签名只覆盖 path 不含 host，换主机后签名仍有效；记下被接受的主机可以
 * 省掉每次「先失败一次再切换」的开销。
 */
export function currentGatewayHost(): string {
  return lastIdentity.gatewayHost;
}

/** 记下上游接受的主机（由 upstream 在请求成功后调用，并回写凭据文件）。 */
export function rememberGatewayHost(host: string): void {
  if (!host || lastIdentity.gatewayHost === host) return;
  lastIdentity = { ...lastIdentity, gatewayHost: host };
  try {
    const current = load();
    writeJsonSecret(credentialsPath(), { ...current, gatewayHost: host });
  } catch {
    /* 没登录 / 写不进去都无所谓：内存里那份已经生效，下次请求仍走对的主机 */
  }
}

/** 记下身份（由 `load` / `login` / `refresh` 调用）。 */
function rememberIdentity(userType: string, gatewayHost = ""): void {
  lastIdentity = {
    userType: userType || DEFAULT_USER_TYPE,
    gatewayHost: gatewayHost || lastIdentity.gatewayHost,
  };
}

// ── 凭据读写 ──────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读凭据；未登录 / 文件损坏都抛 `NotLoggedInError`（共享层靠它判断"没东西"）。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `qwenworkcn login` to authorize in the browser");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const accessToken = str(parsed["accessToken"]);
  if (!accessToken) throw new NotLoggedInError("Credential has no access_token, please log in again");
  const uid = str(parsed["uid"]);
  const userType = str(parsed["userType"]) || DEFAULT_USER_TYPE;
  const gatewayHost = str(parsed["gatewayHost"]);
  rememberIdentity(userType, gatewayHost);
  const fingerprint = ensureMachineFingerprint(parsed);
  return {
    accessToken,
    uid,
    domain: str(parsed["domain"]) || PRODUCT.domain,
    refreshToken: str(parsed["refreshToken"]),
    nickname: str(parsed["nickname"]),
    ...fingerprint,
    userType,
    gatewayHost,
    expireAt: shared.parseExpireTime(parsed["expireAt"]),
    refreshExpireAt: shared.parseExpireTime(parsed["refreshExpireAt"]),
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断"已登录"）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
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
   * 设备码流**没有本机回环**：令牌由服务端按 `nonce` 下发，浏览器的
   * `qwenwork-cn://` 深链也打不到本机。故粘回的内容只作「浏览器那一步已完成」
   * 的信号 —— 转交**同一个轮询处理器**立刻再取一次令牌，**不是**第二条登录路径。
   */
  pasteCode?: () => string | undefined;
}

interface DeviceToken {
  accessToken: string;
  refreshToken: string;
  uid: string;
  expireAt: number | null;
  refreshExpireAt: number | null;
}

/** 账号档案（`/api/v1/userinfo` 的 data 字段）。 */
interface UserProfile {
  /** 账号 id（轮询响应没带 uid 时的兜底）。 */
  uid: string;
  nickname: string;
  /** 请求体 `aliyun_user_type` 用的身份类型（取不到回落默认值）。 */
  userType: string;
}

const EMPTY_PROFILE: UserProfile = { uid: "", nickname: "", userType: "" };

/**
 * 取账号档案：设备码轮询响应**不带**昵称与身份类型，必须单独取。
 *
 * 尽力而为，失败不阻塞登录（uid 回落轮询响应，身份类型回落默认值）。
 * 字段名两种写法都认（snake_case / camelCase），与 `qodercn` 同口径。
 */
async function fetchUserProfile(accessToken: string): Promise<UserProfile> {
  if (!accessToken) return EMPTY_PROFILE;
  try {
    const resp = await shared.fetchWithTimeout(
      `${PRODUCT.openapi}/api/v1/userinfo`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": PRODUCT.userAgent,
        },
      },
      15_000,
    );
    if (!resp.ok) return EMPTY_PROFILE;
    const data = (await resp.json()) as Record<string, unknown>;
    return {
      uid: str(data["id"]) || str(data["user_id"]) || str(data["userId"]),
      nickname: str(data["name"]) || str(data["nickname"]),
      userType: str(data["user_type"]) || str(data["userType"]),
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

/**
 * 完整设备授权登录：构造授权 URL → 用户浏览器授权 → 轮询取 token → 补账号档案 → 落盘。
 *
 * 轮询的 HTTP 404 / 202 是**正常中间态**（官方语义：用户还没点同意），必须继续轮询；
 * 其它非 2xx 才是错误。
 */
export async function login(_baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { verifier, challenge } = makePkce();
  const nonce = randomUUID();
  // 指纹先建：授权页要求带 `machine_id`，且落盘的那份必须与授权时用的是同一个
  const fingerprint = makeMachineFingerprint();

  const authUrl = buildAuthUrl(challenge, nonce, fingerprint.machineId);
  options.onUrl?.(authUrl);
  options.onStatus?.(
    `${PRODUCT.label}: open the URL above in your browser to authorize` +
      (options.pasteCode
        ? " — after authorizing you can paste the browser address bar back here to fetch the token immediately."
        : ""),
  );

  const pollQuery = new URLSearchParams({ nonce, verifier, challenge_method: "S256" });
  const pollUrl = `${PRODUCT.openapi}/api/v1/deviceToken/poll?${pollQuery.toString()}`;

  let pasteReported = false;
  const token = await loginFlow.pollDeviceCode<DeviceToken>({
    intervalMs: POLL_INTERVAL_MS,
    expiresInSec: POLL_EXPIRES_SEC,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    attempt: async () => {
      // 粘贴兜底：粘回的内容 = 「浏览器那一步已完成」的信号。
      // 失败措辞的识别是**渠道无关**的通用启发式（见共享层 auth/paste-detect.ts）：
      // 国内站授权后浏览器会跳 `qwenwork-cn://` 深链（打不开），用户拒绝授权时
      // 页面/地址栏里会留下错误措辞 —— 认出来就能**立刻**结束等待，而不是白等 5 分钟。
      const pasted = options.pasteCode?.();
      if (typeof pasted === "string" && pasted.trim()) {
        const reason = pasteDetect.pastedAuthFailureReason(pasted);
        if (reason) {
          return {
            kind: "fatal",
            error: new Error(`browser authorization failed: ${reason}`),
          };
        }
        if (!pasteReported) {
          options.onStatus?.("已收到粘回的回调，正在换取令牌...");
          pasteReported = true;
        }
      }
      const resp = await shared.fetchWithTimeout(
        pollUrl,
        { headers: { Accept: "application/json", "User-Agent": PRODUCT.userAgent } },
        20_000,
      );
      // 404 / 202 = 尚未授权（官方语义），不是错误
      if (resp.status === 404 || resp.status === 202) return { kind: "pending" };
      if (!resp.ok) {
        return { kind: "fatal", error: new Error(`Device authorization polling failed: HTTP ${resp.status}`) };
      }
      const data = (await resp.json()) as Record<string, unknown>;
      // 字段名登录与续期不一致，三种都认
      const accessToken =
        str(data["token"]) || str(data["device_token"]) || str(data["access_token"]);
      if (!accessToken) return { kind: "pending" }; // 还没好，继续等
      return {
        kind: "done",
        value: {
          accessToken,
          refreshToken: str(data["refresh_token"]) || str(data["refreshToken"]),
          uid: str(data["user_id"]) || str(data["userId"]),
          expireAt: expireAtOf(data),
          refreshExpireAt: shared.parseExpireTime(
            data["refresh_token_expires_at"] ?? data["refreshTokenExpiresAt"],
          ),
        },
      };
    },
  });

  if (!token.accessToken) throw new Error("Device authorization succeeded but no access token was returned");

  // 账号档案（昵称 / 身份类型）：轮询响应不带，必须单独取一次（失败不阻塞登录）。
  const profile = await fetchUserProfile(token.accessToken);
  const uid = token.uid || profile.uid;
  const userType = profile.userType || DEFAULT_USER_TYPE;
  const nickname = profile.nickname;
  rememberIdentity(userType);
  const credential: Credentials = {
    accessToken: token.accessToken,
    uid,
    domain: PRODUCT.domain,
    refreshToken: token.refreshToken,
    nickname,
    ...fingerprint,
    userType,
    // 新登录：还不知道哪个推理主机能被接受，留给第一次成功请求去记
    gatewayHost: "",
    expireAt: token.expireAt,
    refreshExpireAt: token.refreshExpireAt,
  };
  await save(credential);
  options.onStatus?.(`已登录 ${PRODUCT.label}${nickname ? `（${nickname}）` : ""}`);
  return credential;
}

/**
 * 续期：`POST {openapi}/api/v1/deviceToken/refresh`，body `{refresh_token}`。
 *
 * 设备码**登录**必须带 `machine_id`（见 `buildAuthUrl`），但**续期**不必：参考实现
 * （`Buddy2api` 的 `token.py`）只发 `refresh_token`（1.3.1 客户端另带 `target: "c"`）。
 *
 * - 401/403 → 终态（`NotLoggedInError`，提示重新登录）
 * - 200 但无 token → 同样终态
 * - 其余（5xx/429/网络）→ 普通 Error，共享层会当作可重试
 *
 * 续期响应**不含** `machine_id` / `uid` / `nickname`，必须从旧凭据保留 ——
 * 丢了机器指纹会破坏服务端设备绑定。
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  if (!credential.refreshToken) throw new Error("Credential has no refresh_token, cannot refresh silently");

  let resp: Response;
  try {
    resp = await shared.fetchWithTimeout(
      `${PRODUCT.openapi}/api/v1/deviceToken/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": PRODUCT.userAgent,
        },
        body: JSON.stringify({ refresh_token: credential.refreshToken }),
      },
      20_000,
    );
  } catch (err) {
    throw new Error(`Refresh request failed (retryable): ${String(err)}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new NotLoggedInError("refresh_token expired, please run `qwenworkcn login` again");
  }
  if (!resp.ok) throw new Error(`Refresh failed: HTTP ${resp.status} (retryable)`);

  const data = (await resp.json()) as Record<string, unknown>;
  const accessToken = str(data["token"]) || str(data["device_token"]) || str(data["access_token"]);
  if (!accessToken) throw new NotLoggedInError("Refresh response has no token, please log in again");

  const next: Credentials = {
    ...credential,
    accessToken,
    refreshToken:
      str(data["refresh_token"]) || str(data["refreshToken"]) || credential.refreshToken,
    expireAt: expireAtOf(data) ?? credential.expireAt,
    refreshExpireAt:
      shared.parseExpireTime(data["refresh_token_expires_at"] ?? data["refreshTokenExpiresAt"]) ??
      credential.refreshExpireAt,
  };
  rememberIdentity(next.userType);
  await save(next);
  return next;
}
