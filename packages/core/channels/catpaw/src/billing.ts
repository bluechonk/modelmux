/**
 * CatPaw 额度查询与注册奖励申领（个人版网关积分中心）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/catpaw/PROTOCOL.md）：
 *   - 额度只有「可用积分」一个字段，used 恒 0、size=remain 是如实映射，不是伪造。
 *   - 上游没有每日签到；「签到」对应注册奖励申领（幂等，老用户不重复发放）。
 *   - 鉴权是网关域 X-Auth-Token，与对话用的直连域头（X-Passport-Token + Cookie）不是同一套。
 */

import * as cred from "./cred.js";
import type { SigninModule } from "@modelmux/gateway";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(message = "credit query failed") {
    super(message);
  }
}

/**
 * 额度查询端点（`GET`）。端点、鉴权与响应字段见 docs/channels/catpaw/PROTOCOL.md。
 *
 * 实现侧：取 `data.availableCredits`（可用积分）。
 */
const CREDIT_BALANCE_PATH = "/api/gateway/credit/balance";

/**
 * 注册奖励申领端点（`POST`）。端点与实测见 docs/channels/catpaw/PROTOCOL.md。
 *
 * 实现侧：幂等——老用户回 `newUser:false`；body 的渠道字段取下面那个常量。
 */
const CREDIT_REGISTER_PATH = "/api/gateway/credit/register";

/** 注册奖励的申领渠道（参考实现 RegisterChannel 常量）。 */
const REGISTER_CHANNEL = "CATPAW_PC";

function gatewayHeaders(token: string): Record<string, string> {
  return { "X-Auth-Token": token, Accept: "application/json" };
}

/**
 * 凭据失效业务码：`4010` = 没带 token，`4011` = token 无效。
 *
 * 上游把它们装在 **HTTP 200** 的 body 里（与 HTTP 401 同义），只看状态码会把「登录已失效」
 * 误报成「额度响应缺 availableCredits」，既不触发刷新也提示不到重登。
 */
const CREDENTIAL_INVALID_CODES = new Set([4010, 4011]);

/** body 顶层的 `code` 是否表示凭据失效（容忍数字与数字字符串两种形态）。 */
export function isCredentialInvalid(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const code = (payload as Record<string, unknown>)["code"];
  const n = typeof code === "number" ? code : typeof code === "string" ? Number(code) : Number.NaN;
  return Number.isFinite(n) && CREDENTIAL_INVALID_CODES.has(n);
}

/** 剥信封：网关响应形如 `{code, data}`；无 code 字段时视 body 本身即 data。 */
function unwrap(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new CreditsError("credit response is not an object");
  }
  const env = payload as Record<string, unknown>;
  const data = env["data"];
  if (typeof env["code"] !== "undefined" && data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return env;
}

function numOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 对外额度视图（字段与 loomy 等渠道的 CreditsResult 对齐）。 */
export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: Array<Record<string, unknown>>;
  claimable: Array<Record<string, unknown>>;
}

/**
 * 查询额度：`credit/balance` 的 `availableCredits` 是**可用积分**。
 *
 * 上游只给「可用余额」，没有「已用 / 总额」字段 —— used 恒 0、size=remain
 * 是**如实映射**而不是伪造（从余额无法推出已用量）。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: cred.Credentials } = {},
): Promise<CreditsResult> {
  const c = options.credential ?? cred.load(); // 未登录 → NotLoggedInError

  let payload: unknown;
  try {
    const resp = await fetch(`${cred.GATEWAY_HOST}${CREDIT_BALANCE_PATH}`, {
      headers: gatewayHeaders(c.accessToken),
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new cred.NotLoggedInError("CatPaw gateway rejected the token; please log in again");
    }
    if (resp.status !== 200) {
      throw new CreditsError(`credit balance request failed: HTTP ${resp.status}`);
    }
    payload = await resp.json();
  } catch (err) {
    if (err instanceof CreditsError || err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(`credit balance request failed: ${String(err)}`);
  }
  if (isCredentialInvalid(payload)) {
    throw new cred.NotLoggedInError("CatPaw gateway rejected the token; please log in again");
  }

  const data = unwrap(payload);
  const remain = numOf(data["availableCredits"]);
  if (remain === null) {
    throw new CreditsError(`credit balance response has no availableCredits: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return {
    ok: true,
    total: { remain, size: remain, used: 0, unit: "积分", remain_percent: 100 },
    packages: [],
    claimable: [],
  };
}

/** 申领结果（register 的响应字段，见参考实现 RegisterResult）。 */
export interface RegisterResult {
  registrationBonus: number | null;
  registerBonusValueYuan: string;
  rewardExpireDays: number | null;
  rewardLastValidDate: string;
  newUser: boolean;
}

/**
 * 申领注册奖励（`credit/register`，幂等：老用户 newUser=false 不重复发放）。
 *
 * 这是「签到」在这个渠道上的对应物 —— 上游没有每日签到，只有注册奖励与活动。
 */
async function claimRegister(): Promise<{ result: RegisterResult; raw: Record<string, unknown> }> {
  const c = cred.load();
  let payload: unknown;
  try {
    const resp = await fetch(`${cred.GATEWAY_HOST}${CREDIT_REGISTER_PATH}`, {
      method: "POST",
      headers: { ...gatewayHeaders(c.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ registerChannel: REGISTER_CHANNEL }),
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new cred.NotLoggedInError("CatPaw gateway rejected the token; please log in again");
    }
    if (resp.status !== 200) {
      throw new CreditsError(`credit register request failed: HTTP ${resp.status}`);
    }
    payload = await resp.json();
  } catch (err) {
    if (err instanceof CreditsError || err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(`credit register request failed: ${String(err)}`);
  }
  if (isCredentialInvalid(payload)) {
    throw new cred.NotLoggedInError("CatPaw gateway rejected the token; please log in again");
  }
  const data = unwrap(payload);
  return {
    result: {
      registrationBonus: numOf(data["registrationBonus"]),
      registerBonusValueYuan: String(data["registerBonusValueYuan"] ?? ""),
      rewardExpireDays: numOf(data["rewardExpireDays"]),
      rewardLastValidDate: String(data["rewardLastValidDate"] ?? ""),
      newUser: data["newUser"] === true,
    },
    raw: data,
  };
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * 上游没有**每日**签到端点；这里的「领取」对应注册奖励申领（幂等，
 * 领过就 newUser=false），能领的时候会真实入账。
 */
export const signin: SigninModule = {
  async status() {
    // claimable=false 是契约对「上游没有每日签到」的指定表达：报 true 会让自动签到
    // 每天对 credit/register 发无效请求，并把台账记成假「已签到」透给 UI。
    return {
      claimable: false,
      summary: "上游没有每日签到；signin 只承载注册奖励申领（credit/register，幂等）",
    };
  },
  async claim() {
    const { result } = await claimRegister();
    const bonus = result.registrationBonus;
    const summary = result.newUser
      ? `注册奖励已入账：+${bonus ?? "?"} 积分（价值 ¥${result.registerBonusValueYuan || "?"}，${result.rewardExpireDays ?? "?"} 天有效）`
      : `该账号已是注册老用户，无新奖励可领（newUser=false）`;
    return { ok: true, summary };
  },
};
