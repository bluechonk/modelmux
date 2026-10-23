/**
 * Loomy 额度：**两个积分池**、每日额度初始化与新手任务直领（PROTOCOL §6）。
 *
 * ## 本模块承载的渠道知识
 *
 * 1. **两个积分池**：永久积分（注册奖励 5000 + 新手任务 10000，`balance`）与
 *    每日赠送池（每天 5000，`dailyBalance`，**消耗后不回补**）。
 *    `availableBalance` 是两者之和。
 * 2. **查余额用 `points/records`（只读）而不是 `first-login`**：后者是**写**端点，
 *    在「打开面板」这种高频路径上调用会意外触发签到。
 * 3. **`dailyQuota` 只在 `first-login` 的响应里**（`points/records` 不返回它），
 *    故未签到时该字段缺省 —— **不要硬编码 5000**。
 * 4. **一键签到（`first-login`）的幂等判据是响应体的 `alreadyProcessed`**，
 *    故已处理映射成 `already-claimed` 而**不是** `completed`；
 *    它的语义是「触发每日额度重置」，**不是「+5000 积分」**。
 *    它是本渠道签到的**主判据**（见文件末尾 `signin`），失败返回 `failed` 而不抛错。
 * 5. **新手任务是纯 API 直领**：body 只有 `{key}`，服务端**不校验前置行为**
 *    （实测 8 个任务直领全部成功，余额 0 → 10000，没有真的发对话/生成 PPT/装技能）。
 *    ⚠ **不采信服务端 `earned`**，按本地表算；任一任务收到 `100002` 时**立即抛出**，
 *    不再对后续任务发请求。
 * 6. ⚠ **「查不到」不能显示成 0**：`balance` 缺失即抛 `CreditsError`。
 * 7. **签到是全自动能力，没有 CLI 动词**：网关 running 后由 `auth/auto-signin.ts`
 *    调度（启动跑一轮 + 每 30 分钟一轮，带台账去重与连败 3 次熔断）。
 *    本渠道的签到 = 每日额度重置（`first-login`）+ 新手任务直领，见文件末尾。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 额度单位。 */
const UNIT = "积分";

/** 额度查询/领取失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 任务 key → 积分与标题（顺序即执行顺序，合计 10000）。 */
const ONBOARDING_TASKS: Array<{ key: string; amount: number; label: string }> = [
  { key: "first_message", amount: 500, label: "发送你的第一条消息" },
  { key: "pick_skill", amount: 1000, label: "试试选择一个技能" },
  { key: "generate_ppt", amount: 1500, label: "生成第一份 PPT" },
  { key: "set_schedule", amount: 1000, label: "设置定时任务" },
  { key: "install_skill", amount: 1500, label: "在技能广场安装一个技能" },
  { key: "configure_remote", amount: 1000, label: "配置远程控制" },
  { key: "create_soul", amount: 1500, label: "创建你的第一个搭子" },
  { key: "share_soul", amount: 2000, label: "把搭子分享给朋友" },
];

const TASK_AMOUNT = new Map(ONBOARDING_TASKS.map((t) => [t.key, t.amount]));

interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used: number;
  unit: string;
  days_left: number | null;
  [key: string]: unknown;
}

interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
    /** `dailyQuota` 只在 first-login 的响应里 → 未签到时为 false（**不硬编码 5000**）。 */
    daily_quota_known: boolean;
  };
  packages: CreditPackage[];
  claimable: Array<Record<string, unknown>>;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 未完成的任务（按表顺序）；任务列表拉取失败时返回空表（不影响余额）。 */
async function claimableTasks(c: cred.Credentials): Promise<Array<Record<string, unknown>>> {
  let completed: Record<string, unknown> = {};
  try {
    const data = await upstream.fetchTasks(c);
    const tasks = data["tasks"];
    if (isRecord(tasks)) completed = tasks;
  } catch {
    return []; // 任务列表挂了不影响余额查询
  }
  const out: Array<Record<string, unknown>> = [];
  for (const task of ONBOARDING_TASKS) {
    if (completed[task.key] === true) continue;
    out.push({ campaign_id: task.key, label: task.label, amount: task.amount });
  }
  return out;
}

/**
 * 查询额度（**只读**）。
 *
 * 数据源：`GET /api/v1/points/records?pageNo=1&pageSize=1&recordType=all`。
 * `balance` 是核心字段：没有它就说明响应形状不对 —— **不编造数字，返回报错**。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: cred.Credentials } = {},
): Promise<CreditsResult> {
  const c = options.credential ?? cred.load(); // 未登录 → NotLoggedInError

  let data: Record<string, unknown>;
  try {
    const payload = await upstream.fetchPointsRecords(c);
    // `points/records` 返回完整信封；`env.data` 才是那两个积分池
    data = upstream.parseEnvelope(payload).data;
  } catch (err) {
    if (err instanceof upstream.UpstreamUnauthorized) {
      throw new cred.NotLoggedInError(`Loomy session is invalid (${String(err)}); please log in again`);
    }
    throw new CreditsError(`points query failed: ${String(err)}`);
  }

  const balance = numOrNull(data["balance"]);
  if (balance === null) {
    throw new CreditsError("points response has no balance field (wrong shape; not showing 0)");
  }
  const dailyBalance = numOrNull(data["dailyBalance"]) ?? 0;
  const available = numOrNull(data["availableBalance"]) ?? balance + dailyBalance;
  // ⚠ dailyQuota 只在 first-login 的响应里；未签到时缺省，不要硬编码
  const dailyQuota = numOrNull(data["dailyQuota"]);
  const dailyConsumed = numOrNull(data["dailyConsumed"]) ?? 0;

  const size = dailyQuota !== null ? balance + dailyQuota : available;
  const used = Math.max(0, size - available);
  const percent = size > 0 ? (available / size) * 100 : 0;

  return {
    ok: true,
    total: {
      remain: round2(available),
      size: round2(size),
      used: round2(used),
      unit: UNIT,
      remain_percent: Math.round(percent * 10) / 10,
      daily_quota_known: dailyQuota !== null,
    },
    packages: [
      {
        name: "永久积分",
        remain: round2(balance),
        size: round2(balance),
        used: 0,
        unit: UNIT,
        // 永久积分没有到期日；每日池按日重置（不是「若干天后到期」）
        days_left: null,
      },
      {
        name: "每日赠送",
        remain: round2(dailyBalance),
        size: round2(dailyQuota ?? dailyBalance + dailyConsumed),
        used: round2(dailyQuota !== null ? Math.max(0, dailyQuota - dailyBalance) : dailyConsumed),
        unit: UNIT,
        days_left: null,
      },
    ],
    claimable: await claimableTasks(c),
  };
}

interface ClaimResult {
  status: "completed" | "already-claimed" | "failed" | "skipped";
  key: string;
  amount: number;
  balance?: number;
  error?: string;
}

/**
 * 直领一个新手任务（服务端只做「幂等置位 + 加分」，不校验前置行为）。
 *
 * ⚠ 上报 body **只有 `key`**。未知 key → `100001` → `CreditsError`；
 * 登录失效 → `100002` → `NotLoggedInError`（调用方应立即终止后续请求）。
 */
async function claim(key: string, c?: cred.Credentials): Promise<ClaimResult> {
  const credential = c ?? cred.load();
  const amount = TASK_AMOUNT.get(key) ?? 0;
  let data: Record<string, unknown>;
  try {
    data = await upstream.completeTask(credential, key);
  } catch (err) {
    if (err instanceof upstream.UpstreamUnauthorized) {
      throw new cred.NotLoggedInError(`session became invalid while claiming task ${key}: ${String(err)}`);
    }
    const text = String(err);
    if (text.includes(upstream.BAD_REQUEST_CODE)) {
      throw new CreditsError(`unknown task key: ${key} (${text})`);
    }
    return { status: "failed", key, amount, error: text };
  }
  const balance = numOrNull(data["balance"]);
  const already = data["alreadyCompleted"] === true;
  return {
    status: already ? "already-claimed" : "completed",
    key,
    amount,
    ...(balance === null ? {} : { balance }),
  };
}

interface ClaimAllResult {
  earned: number;
  results: ClaimResult[];
}

/**
 * 串行领取全部新手任务。
 *
 * - 已完成的**跳过不发请求**（先读一次任务列表）
 * - **不采信服务端 `earned`**，按本地表算
 * - 任一任务收到 `100002`（登录失效）时**立即抛出**，不再对后续任务发请求
 */
async function claimAll(): Promise<ClaimAllResult> {
  const c = cred.load();
  let completed: Record<string, unknown> = {};
  try {
    const data = await upstream.fetchTasks(c);
    const tasks = data["tasks"];
    if (isRecord(tasks)) completed = tasks;
  } catch {
    completed = {};
  }

  const results: ClaimResult[] = [];
  let earned = 0;
  for (const task of ONBOARDING_TASKS) {
    if (completed[task.key] === true) {
      results.push({ status: "skipped", key: task.key, amount: task.amount });
      continue;
    }
    const result = await claim(task.key, c); // 100002 会直接抛出，后续任务不再请求
    results.push(result);
    if (result.status === "completed") earned += task.amount;
  }
  return { earned: round2(earned), results };
}

// ── 签到 / 领取能力（共享层自动签到调度器用；见 SigninModule 契约）────────────

import type { QuotaPeriod, SigninModule } from "@modelmux/gateway";

/** 每日额度重置的结果。 */
interface DailyResetResult {
  status: "completed" | "already-claimed" | "failed";
  error?: string;
}

/**
 * 触发每日额度重置（`POST /points/first-login`）—— **这才是 Loomy 的「签到」**。
 *
 * 幂等判据是响应体的 `alreadyProcessed`：已处理映射成 `already-claimed`（不是 `completed`），
 * 所以重复调用不会重复计账。**不抛错**（失败返回 `failed`），由调用方决定是否计一次失败。
 */
async function triggerDailyReset(c: cred.Credentials): Promise<DailyResetResult> {
  try {
    const data = await upstream.triggerFirstLogin(c);
    return { status: data["alreadyProcessed"] === true ? "already-claimed" : "completed" };
  } catch (err) {
    return { status: "failed", error: String(err) };
  }
}

/**
 * 签到 / 领取能力（**全自动**，共享层 `auth/auto-signin.ts` 调度，无 CLI 动词）。
 *
 * 本渠道的「签到」由两件事组成，顺序固定：
 * 1. **每日额度重置**（`first-login`，写）—— 主判据，`ok` 只看它；
 * 2. **新手任务直领**（`claimAll()`，写）—— 一次性 10000 分，失败不影响签到结论但如实报出。
 *
 * 状态查询返回 `claimable: null`：上游**没有**独立的签到状态端点，
 * `null` 是「不知道」（不是「没有」），故调度器每天都会走到 `claim()`，
 * 由 `alreadyProcessed` 保证幂等；调度器的台账（`state/signin.json`）保证**一天只打一次**。
 */
export const signin: SigninModule = {
  async status() {
    return {
      claimable: null,
      summary: "（该渠道没有独立的签到状态端点；claim 会触发每日额度重置并领新手任务）",
    };
  },
  async claim() {
    const c = cred.load();
    const reset = await triggerDailyReset(c);

    // 新手任务是一次性的：失败/登录失效都不改变「签到」结论，但要如实报出
    let tasks: ClaimAllResult | null = null;
    let tasksError = "";
    try {
      tasks = await claimAll();
    } catch (err) {
      tasksError = String(err);
    }

    const parts = [
      reset.status === "failed"
        ? `每日额度重置失败：${reset.error ?? "unknown"}`
        : reset.status === "already-claimed"
          ? "每日额度今天已处理"
          : "每日额度已触发重置",
    ];
    if (tasksError) parts.push(`新手任务：${tasksError}`);
    else if (tasks) {
      const claimed = tasks.results.filter((x) => x.status === "completed").length;
      parts.push(
        claimed > 0
          ? `领取 ${claimed} 项，+${tasks.earned}`
          : `新手任务无可领（${tasks.results.map((x) => x.status).join(", ")}）`,
      );
    }

    return {
      ok: reset.status !== "failed",
      summary: parts.join("；"),
      detail: { first_login: reset, tasks },
    };
  },
};

// ── 额度周期（`BillingModule.quotaPeriod`，供共享层展示与冷却截止时间）────────

/**
 * 每日额度周期：**每天 5000 积分，本地 0 点刷新**。
 *
 * 依据（不是猜的）：
 * - `dailyQuota = 5000`：2026-10-22 真机调 `POST /points/first-login` 实测返回
 *   （`dailyBalance=978 / dailyConsumed=4022`，见 `docs/channels/loomy/PROTOCOL.md` §6.3）；
 * - 0 点刷新：`points/records` 的 `dailyCycleDate` 是日期串，且实测跨天后额度回到满额。
 *
 * ⚠ `points/records` **不返回** `dailyQuota`（只有 first-login 响应里有），所以这里用
 * 实测常量而不是去查上游 —— 本函数是**纯本地**的（共享层可能在展示路径高频调用）。
 */
export function quotaPeriod(): QuotaPeriod {
  return {
    label: "每天送 5000 积分，本地 0 点刷新",
    size: 5000,
    unit: "积分",
    resets_at: nextLocalMidnight(),
  };
}

/** 下一次**本机时区**的 0 点（epoch ms）。 */
function nextLocalMidnight(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
