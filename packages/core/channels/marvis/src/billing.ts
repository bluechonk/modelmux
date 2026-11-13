/**
 * Marvis 额度：`token.wallet`（本地 gateway）+ `list_agent_token_stats`（REST）。
 *
 * 关键约束（端点/字段/实测见 docs/marvis/PROTOCOL.md §15.5）：
 *   - 额度来自**本地 gateway**（`token.wallet`），不是 REST：返回
 *     `avail_tokens` / `total_tokens` / `used_tokens`（实测 1000 万可用）。
 *   - gateway 地址与 token 由客户端下发，未配置时**如实报错**，不编造数字。
 *   - Marvis 无签到接口。
 */

import type { CreditsResult, SigninModule, SigninOutcome, SigninStatus } from "@modelmux/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 数字（数字或数字字符串）→ number。 */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 查额度。
 *
 * 优先走本地 gateway 的 `token.wallet`；gateway 不可用时回落 REST 的
 * agent token 统计（那里有累计用量，但没有账户余额）。
 */
export async function fetchCredits(options?: {
  refreshOn401?: boolean;
  credential?: unknown;
  gatewayAddr?: string;
}): Promise<CreditsResult> {
  const credential = (options?.credential as cred.Credentials | undefined) ?? cred.load();
  // gateway 地址与 token 都在凭据里（由客户端下发）；配置文件的 gatewayAddr 作为兜底
  const addr = credential.gatewayAddr || options?.gatewayAddr || upstream.loadConfig()[0].gatewayAddr;
  const gatewayToken = credential.gatewayToken;

  if (addr && gatewayToken) {
    try {
      const wallet = await upstream.gatewayWallet(addr, gatewayToken);
      if (wallet) {
        const total = num(wallet["total_tokens"]) ?? 0;
        const used = num(wallet["used_tokens"]) ?? 0;
        const avail = num(wallet["avail_tokens"]) ?? Math.max(0, total - used);
        const pct = total > 0 ? (avail / total) * 100 : 0;
        return {
          ok: true,
          total: { remain: avail, size: total, used, unit: "tokens", remain_percent: pct },
          packages: [
            {
              name: "可用额度",
              remain: avail,
              size: total,
              used,
              unit: "tokens",
              remain_percent: pct,
            },
          ],
        };
      }
    } catch (err) {
      // gateway 不可用是常见情形（客户端未运行）：如实降级到 REST，并说明
      if (!(err instanceof Error)) throw err;
    }
  }

  // 回落：REST 的逐日用量（有 used，没有账户余额）
  const rows = await upstream.fetchUsageLogs(credential);
  const usedTotal = rows.reduce((sum, r) => sum + (num(r["total_tokens"]) ?? 0), 0);
  if (!rows.length) {
    throw new CreditsError(
      addr
        ? "Marvis 未返回额度数据（gateway 与 REST 均无结果）"
        : "Marvis 额度需本地 gateway：请在 upstream.json 配置 gatewayAddr（客户端运行时从 AiStarter.GetGatewayToken 获取）",
    );
  }
  return {
    ok: true,
    total: { remain: 0, size: usedTotal, used: usedTotal, unit: "tokens", remain_percent: 0 },
    packages: rows.map((r) => {
      const used = num(r["total_tokens"]) ?? 0;
      return {
        name: `${String(r["agent_tag"] ?? "unknown")} ${String(r["log_date"] ?? "")}`.trim(),
        remain: 0,
        size: used,
        used,
        unit: "tokens",
        remain_percent: 0,
      };
    }),
  };
}

/** 额度周期：Marvis 额度按 tokens 计，不公布固定刷新窗口。 */
export function quotaPeriod(): null {
  return null;
}

/** 签到：Marvis 没有签到接口。 */
export const signin: SigninModule = {
  async status(): Promise<SigninStatus> {
    return {
      claimable: false,
      claimedToday: null,
      summary: "Marvis 没有签到接口",
    };
  },
  async claim(): Promise<SigninOutcome> {
    return { ok: true, summary: "Marvis 没有签到接口，无需领取" };
  },
  perAccount: false,
};
