/**
 * 演示模式的数据源（**本地预览**：界面完整渲染，动作只改内存状态）。
 *
 * 控制台页面要 `fetch('/web/api/*')` 读本机网关，而演示构建没有网关（CORS /
 * 同源写校验 / Private Network Access 三重拦截）—— 演示模式在 `api` 层用本模块
 * 替换 fetch。由**演示构建**（`DEMO=1`）使用，发布到 GitHub Pages
 * （`.github/workflows/demo-pages.yml`；本地预览见 docs/WEB-CONSOLE.md）。
 *
 * 数据纪律：页面**公开** —— 账号 uid / 手机号 / 域名一律用明显虚构的占位值，
 * 不读取、不复制 `~/.modelmux/` 下的任何真实数据。
 */

import { tokensPerSecOfEntry } from "./log-format.ts";
import type {
  AccessLogEntry,
  AccessLogPage,
  AccessLogStats,
  AccessOutcome,
  LogQuery,
  OverviewResponse,
  UiSnapshot,
  UsageDaily,
  UsageModelRow,
  UsageRange,
  UsageStats,
} from "./types";

/** 渠道：cid + 展示名 + 是否已登录 + 有没有额度概念（虚构）。 */
interface DemoChannel {
  cid: string;
  display: string;
  present: boolean;
  /** 有没有额度/倍率概念（订阅制 = false）—— 对应真实快照的 `channel_caps`。 */
  billing: boolean;
}

/** 一个虚构账号。uid/label/name 全部明显是占位值，不含任何真实身份信息。 */
interface DemoAccount {
  key: string;
  uid: string;
  label: string;
  /** 名称类字段；空串表示该渠道只有 uid（演示「无名字 → 显示脱敏 id」）。 */
  name?: string;
  health: string;
  /** 凭据到期：相对今天的天数（负数 = 已过期）；不填 = 渠道不给到期时间。 */
  expiresInDays?: number;
  /** 连续失败次数（`health === "error"` 时展示，演示「连败熔断」）。 */
  failStreak?: number;
  /** 冷却截止：相对现在的分钟数（`health === "cooldown"` 时展示）。 */
  cooldownInMinutes?: number;
  cooldownReason?: string;
}

/**
 * 演示渠道：**必须与真实注册的 12 个渠道一致**。
 *
 * 早先这份表停在 6 个渠道，演示站点看起来像「这个网关只接了 6 家」——
 * 与真实控制台对不上，也就失去了演示的意义。新增渠道时同步加这里。
 */
/**
 * 对外端点清单 —— **必须与后端 `console.ts` 的 `emptySnapshot().endpoints` 一致**。
 *
 * UI 引不到后端模块（两套构建、不同 tsconfig），只能在这里抄一份；抄错了演示站就会
 * 显示一份不存在的端点表（早先只抄了 3 条，真实是 6 条）。
 * `demo.test.ts` 有一条断言把两边的清单读出来比对，漂移会红。
 */
const DEMO_ENDPOINTS: string[] = [
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/responses",
  "/v1/models",
  "/health",
];

const DEMO_CHANNELS: DemoChannel[] = [
  { cid: "astudio", display: "AStudio", present: true, billing: false },
  { cid: "autoclaw", display: "AutoClaw", present: true, billing: true },
  { cid: "catpaw", display: "CatPaw", present: true, billing: true },
  { cid: "lobsterai", display: "LobsterAI", present: false, billing: true },
  { cid: "loomy", display: "Loomy", present: true, billing: true },
  { cid: "qoder", display: "Qoder", present: true, billing: true },
  { cid: "qodercn", display: "Qoder 国内版", present: true, billing: true },
  { cid: "raccoon", display: "Raccoon", present: true, billing: true },
  { cid: "traecn", display: "TRAE", present: true, billing: true },
  // 故意留一个未登录渠道：「登录」这条动线需要演示对象（`demo.test.ts` 有此断言）
  { cid: "workbuddy", display: "WorkBuddy", present: false, billing: true },
  { cid: "workbuddyai", display: "WorkBuddyAI", present: true, billing: true },
  { cid: "qwenworkcn", display: "千问办公", present: true, billing: true },
];

/**
 * 各渠道对外暴露的模型（演示集；候选集必须落在网关对外家族内）。
 *
 * 对外模型：`deepseek-v4.1-flash` / `glm-5.3-flash` / `qwen3.8-flash`。
 */
const DEMO_MODELS: Record<string, string[]> = {
  astudio: [],
  autoclaw: ["glm-5.3-flash"],
  catpaw: ["deepseek-v4.1-flash"],
  lobsterai: ["deepseek-v4.1-flash", "glm-5.3-flash"],
  loomy: ["deepseek-v4.1-flash"],
  qoder: ["deepseek-v4.1-flash", "glm-5.3-flash"],
  // 渠道级范围：qodercn 只暴露 glm-5.3-flash（deepseek 系在它的 models.json 里标了 hidden）
  qodercn: ["glm-5.3-flash"],
  raccoon: ["deepseek-v4.1-flash"],
  traecn: ["deepseek-v4.1-flash"],
  workbuddy: ["deepseek-v4.1-flash"],
  workbuddyai: ["deepseek-v4.1-flash", "glm-5.3-flash"],
  // 渠道级范围：qwenworkcn 只卖「标准」档 qwen3.8-flash
  qwenworkcn: ["qwen3.8-flash"],
};

/** 演示账号池：key / uid / label / name 全是虚构占位值。 */
const DEMO_ACCOUNTS: Record<string, DemoAccount[]> = {
  catpaw: [
    // 连败熔断：路由会跳过它，等退避到期半开试探（或切号 / 重登）
    { key: "demo000000000000a1", uid: "demo-uid-catpaw-1", label: "demo-uid-catpaw-1", health: "error", failStreak: 3, expiresInDays: 12 },
    { key: "demo000000000000a2", uid: "demo-uid-catpaw-2", label: "demo-uid-catpaw-2", health: "ok", expiresInDays: 40 },
    // 5 个账号：演示折叠（含熔断 / 冷却的混合状态）
    { key: "demo000000000000a3", uid: "demo-uid-catpaw-3", label: "demo-uid-catpaw-3", health: "cooldown", cooldownInMinutes: 95, cooldownReason: "上游 429 用量限额，等额度窗口刷新", expiresInDays: 18 },
    { key: "demo000000000000a4", uid: "demo-uid-catpaw-4", label: "demo-uid-catpaw-4", health: "ok", expiresInDays: 60 },
    { key: "demo000000000000a5", uid: "demo-uid-catpaw-5", label: "demo-uid-catpaw-5", health: "ok" },
  ],
  // 额度冷却：到期惰性恢复
  loomy: [{ key: "demo000000000000d1", uid: "demo-uid-loomy-1", label: "13712340004", name: "13712340004", health: "ok", expiresInDays: 8 }],
  qodercn: [{ key: "demo000000000000e1", uid: "demo-uid-qodercn-1", label: "demo-qoder-user", name: "demo-qoder-user", health: "ok", expiresInDays: 30 }],
  raccoon: [{ key: "demo000000000000f1", uid: "demo-uid-raccoon-1", label: "demo-raccoon-user", name: "demo-raccoon-user", health: "ok" }],
  traecn: [
    { key: "demo000000000000g1", uid: "demo-uid-trae-1", label: "demo-trae-user", name: "demo-trae-user", health: "ok", expiresInDays: 3 },
    // 凭据失效：只能重新登录（清标记也不会让它恢复可用）
    { key: "demo000000000000g2", uid: "demo-uid-trae-2", label: "demo-uid-trae-2", health: "unauthorized", expiresInDays: -2 },
  ],
  // 以下为后加入的渠道，账号数据保持最简（演示重点是「渠道存在且能展示」）
  astudio: [{ key: "demo000000000000h1", uid: "demo-uid-astudio-1", label: "demo-astudio-user", name: "demo-astudio-user", health: "ok" }],
  autoclaw: [{ key: "demo000000000000i1", uid: "demo-uid-autoclaw-1", label: "demo-autoclaw-user", name: "demo-autoclaw-user", health: "ok", expiresInDays: 21 }],
  qoder: [{ key: "demo000000000000j1", uid: "demo-uid-qoder-1", label: "demo-qoder-intl", name: "demo-qoder-intl", health: "ok", expiresInDays: 14 }],
  workbuddyai: [{ key: "demo000000000000k1", uid: "demo-uid-wbai-1", label: "demo-wbai-user", name: "demo-wbai-user", health: "ok" }],
  qwenworkcn: [{ key: "demo000000000000m1", uid: "demo-uid-qwc-1", label: "demo-qwc-user", name: "demo-qwc-user", health: "ok" }],
};

/**
 * 演示额度（虚构）：每个有额度概念的渠道一份「总量 / 剩余 / 单位」。
 *
 * 账号卡片的额度条与百分比按它渲染 —— 不补这份数据的话，演示页上每张卡都写着
 * 「未查到」，看起来像功能坏了（订阅制渠道 `billing: false` 本就没有额度概念，不列）。
 */
const DEMO_QUOTA: Record<string, { size: number; remain: number; unit: string }> = {
  catpaw: { size: 500, remain: 486, unit: "积分" },
  loomy: { size: 5000, remain: 4820, unit: "积分" },
  qodercn: { size: 600, remain: 228, unit: "credits" },
  qwenworkcn: { size: 100, remain: 64, unit: "credits" },
  raccoon: { size: 800, remain: 610, unit: "积分" },
  traecn: { size: 2000, remain: 797, unit: "credits" },
};

/** 池账本（虚构用量）。`accounts` 是按生效账号拆分的请求计数。 */
const DEMO_LEDGER: Record<string, { used: number; unit: string; ok: number; fail: number; cooling: boolean }> = {
  catpaw: { used: 128, unit: "credits", ok: 96, fail: 2, cooling: false },
  loomy: { used: 42, unit: "积分", ok: 30, fail: 0, cooling: false },
  qodercn: { used: 672, unit: "credits", ok: 210, fail: 3, cooling: false },
  qwenworkcn: { used: 36, unit: "credits", ok: 12, fail: 0, cooling: false },
  raccoon: { used: 0, unit: "", ok: 12, fail: 1, cooling: true },
  traecn: { used: 1450, unit: "credits", ok: 88, fail: 4, cooling: false },
  workbuddy: { used: 0, unit: "", ok: 0, fail: 0, cooling: false },
};

/**
 * 演示态：全部在内存里。
 *
 * 只保留**可变的最小状态**（登录标志 + 生效账号），其余从上面的常量派生 ——
 * 这样「添加账号 / 切换 / 删除」能真实反映到界面上，而不必维护一份完整镜像。
 */
export interface DemoState {
  channels: DemoChannel[];
  /** cid → 生效账号 key。 */
  active: Record<string, string>;
  /** cid → 账号列表（可增删）。 */
  accounts: Record<string, DemoAccount[]>;
  /**
   * 正在演示登录的渠道（`null` = 无）。
   *
   * 登录弹窗靠轮询 `ui_state / auth_url / qr_url` 推进步骤；演示模式必须也走
   * 这条状态机，否则弹窗会永远停在「正在准备登录会话…」（实测出现过）。
   */
  login: { cid: string; snapshot: UiSnapshot } | null;
}

/** 演示登录流程形态：两步输入（手机号 → 验证码）与授权码（打开授权页）。 */
const DEMO_LOGIN_KIND: Record<string, "input" | "code"> = {
  loomy: "input",
  raccoon: "code",
};

export function createDemoState(): DemoState {
  const active: Record<string, string> = {};
  const accounts: Record<string, DemoAccount[]> = {};
  for (const ch of DEMO_CHANNELS) {
    const list = (DEMO_ACCOUNTS[ch.cid] ?? []).map((a) => ({ ...a }));
    accounts[ch.cid] = list;
    const first = list[0];
    if (first) active[ch.cid] = first.key;
  }
  return { channels: DEMO_CHANNELS.map((c) => ({ ...c })), active, accounts, login: null };
}

/** 对外模型池的「模型 × 渠道」行，只含已登录渠道。 */
export function demoModels(state: DemoState): Array<{ model: string; cid: string }> {
  const out: Array<{ model: string; cid: string }> = [];
  for (const ch of state.channels) {
    if (!ch.present) continue;
    for (const model of DEMO_MODELS[ch.cid] ?? []) out.push({ model, cid: ch.cid });
  }
  return out;
}

/** 去重后的对外模型 id（用量 / 概览用）。 */
export function demoModelIds(state: DemoState): string[] {
  return [...new Set(demoModels(state).map((row) => row.model))];
}

/** 状态快照（对应 `GET /web/api/state`）。 */
export function demoSettings(state: DemoState): UiSnapshot {
  const base = demoSettingsBase(state);
  // 登录进行中：把登录态叠加到快照上（弹窗据此推进步骤）
  if (state.login) return { ...base, ...state.login.snapshot };
  return base;
}

/**
 * 演示用的模型元数据：「模型 × 渠道」行，`meta` 是**该渠道**的值。
 *
 * 字段必须与 `UiSnapshot.models[].meta`（`ModelInfo`）逐字段对齐（倍率 / 营销角标 /
 * 上下文窗口 / 单次输出上限 / 输入模态 / 思考档位 / **取值来源**）——
 * 少一个字段就是一处类型错误，而 `npm run typecheck` 覆盖本包，这类缺口会被当场拦住。
 */
function demoModelRows(state: DemoState): UiSnapshot["models"] {
  /** 倍率（虚构）：同一模型在不同渠道给不同档，演示「按渠道比较」。 */
  const DEMO_MULTIPLIER: Record<string, number> = {
    "deepseek-v4.1-flash": 0.06,
    "glm-5.3-flash": 0.1,
  };
  const DEMO_MARKETING: Record<string, string> = {
    "deepseek-v4.1-flash": "新",
  };
  // 演示思考档位（虚构）：只给一部分模型声明，其余为 null（=「不支持」）——
  // 刻意与真实数据同形，避免演示页把「没声明」显示成「支持」。
  const DEMO_EFFORT: Record<string, { supportedLevels: string[]; defaultLevel: string }> = {
    "deepseek-v4.1-flash": { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
    "glm-5.3-flash": { supportedLevels: ["high", "max"], defaultLevel: "high" },
  };
  /**
   * 演示窗口 / 输出上限（虚构，只取常见量级）。
   *
   * 每个模型一组不同数值是**刻意的**：全填同一个值时「最大上下文」「输出上限」
   * 两列看不出在比什么，多模态那列也永远只有「文本」。
   */
  const DEMO_SIZE: Record<string, { contextWindow: number; maxOutputTokens: number; vision?: boolean }> = {
    "deepseek-v4.1-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216, vision: true },
    "glm-5.3-flash": { contextWindow: 1_000_000, maxOutputTokens: 393_216 },
    // qwen3.8-flash：千问办公的「标准」档（1M 上下文 + 图片输入，与注册表口径一致）
    "qwen3.8-flash": { contextWindow: 1_000_000, maxOutputTokens: 32_000, vision: true },
  };
  /**
   * 演示「跨渠道推断」的渠道（真实口径见 POOL-ARCHITECTURE §2.7）：
   * 本渠道拿不到窗口 / 输出 / 档位时取自同 id 的兄弟渠道，来源标 `cross`。
   * 不给几个例子的话，README 截图里看不到这个标记。
   */
  const crossCids = new Set(["workbuddy", "qodercn"]);
  return demoModels(state).map(({ model, cid }) => {
    const size = DEMO_SIZE[model];
    const cross = crossCids.has(cid);
    const effort = DEMO_EFFORT[model] ?? null;
    return {
      model,
      cid,
      meta: {
        multiplier: DEMO_MULTIPLIER[model] ?? null,
        marketing: DEMO_MARKETING[model] ?? "",
        // 演示值（虚构）：量级取自常见的窗口 / 输出档位
        contextWindow: size?.contextWindow ?? 128_000,
        maxOutputTokens: size?.maxOutputTokens ?? 8192,
        inputModalities: size?.vision ? ["text", "image"] : ["text"],
        effort,
        sources: {
          contextWindow: size ? (cross ? "cross" : "upstream") : "default",
          maxOutputTokens: size ? (cross ? "cross" : "upstream") : "default",
          effort: effort ? (cross ? "cross" : "upstream") : "default",
        },
      },
    };
  });
}

/**
 * 演示「模型走哪家」：候选渠道取该模型真实出现的渠道（去重），偏好留空
 * （= 自动选路）—— 演示站要让用户看到下拉能选，但默认值不该伪装成已有偏好。
 */
function demoModelPrefs(state: DemoState): UiSnapshot["model_prefs"] {
  const byModel = new Map<string, Set<string>>();
  for (const { model, cid } of demoModels(state)) {
    const set = byModel.get(model) ?? new Set<string>();
    set.add(cid);
    byModel.set(model, set);
  }
  return [...byModel.entries()].map(([model, set]) => ({
    model,
    channels: [...set],
    preferred: null,
  }));
}

function demoSettingsBase(state: DemoState): UiSnapshot {
  return {
    ui_state: "running",
    // 一次性登录结果：演示站不预先带 done/error，否则一打开就显示「登录失败」
    login_result: "idle",
    message: "演示模式：数据均为虚构，未连接任何真实网关",
    auth_url: "",
    qr_url: "",
    login_input: null,
    base_url: "http://127.0.0.1:4412/v1",
    chat_url: "http://127.0.0.1:4412/v1/chat/completions",
    endpoints: DEMO_ENDPOINTS,
    version: "0.1.3",
    models: demoModelRows(state),
    model_prefs: demoModelPrefs(state),
    channel_caps: Object.fromEntries(state.channels.map((c) => [c.cid, { billing: c.billing }])),
    theme_mode: "dark",
    integrations: { zcode: true, dsh: false, "claude-desktop": false, codex: true },
    gateway_error: "",
  };
}

/**
 * 开始一轮演示登录：写入状态机，让弹窗从「正在准备」推进到具体步骤。
 *
 * 与 `LoginModal` 的渲染分支一致：
 * - `input`：两步输入卡（`login_input`）—— 如 loomy 的短信验证码；
 * - `code`：授权页（`auth_url`）—— 如 raccoon 的浏览器授权。
 */
export function demoStartLogin(state: DemoState, cid: string): void {
  const kind = DEMO_LOGIN_KIND[cid] ?? "code";
  const base = demoSettingsBase(state);
  state.login =
    kind === "input"
      ? {
          cid,
          snapshot: {
            ...base,
            ui_state: "login",
            message: "演示模式：loomy 走手机验证码，先在下面填手机号",
            login_input: { kind: "phone", prompt: "手机号（+86）" },
          },
        }
      : {
          cid,
          snapshot: {
            ...base,
            ui_state: "login",
            message: "演示模式：点「复制授权链接」完成授权",
            auth_url: "https://example.com/oauth/authorize?demo=1&state=demo-state",
          },
        };
}

/**
 * 提交两步登录的输入（演示）：第一次是手机号，第二次是验证码。
 *
 * 真实流程里这两步由渠道的 `requestInput` 驱动、输入直接发给上游；
 * 演示只推进状态机，不访问任何真实上游。
 */
export function demoSubmitLoginInput(
  state: DemoState,
  value: string,
): { message: string } {
  const login = state.login;
  if (!login) return { message: "当前没有进行中的登录" };
  const base = demoSettingsBase(state);
  if (login.snapshot.login_input?.kind === "phone") {
    login.snapshot = {
      ...base,
      ui_state: "login",
      message: "演示模式：验证码已发送（虚构），请输入",
      login_input: { kind: "code", prompt: `验证码已发送至 ${value}` },
    };
    return { message: "演示模式：验证码已发送（虚构）" };
  }
  return demoCompleteLogin(state);
}

/** 结束演示登录（弹窗关闭或回调提交后）。 */
export function demoEndLogin(state: DemoState): void {
  state.login = null;
}

/** `status` 命令的返回（每渠道一条）。 */
export function demoStatus(state: DemoState): { channels: Array<{ cid: string; display: string; present: boolean }> } {
  return { channels: state.channels.map((c) => ({ cid: c.cid, display: c.display, present: c.present })) };
}

/** `accounts` 命令的返回（每渠道一个池）。 */
export function demoAccountPools(state: DemoState): { channels: unknown[] } {
  const channels = state.channels.map((ch) => {
    const list = state.accounts[ch.cid] ?? [];
    // 签到演示：按账号签到的渠道（loomy，与真实渠道声明一致）只让首个账号「已签到」，
    // 其余渠道用渠道级记录；catpaw 演示「没有签到功能」—— 详情面板整行不渲染
    const perAccount = ch.cid === "loomy";
    const supported = ch.cid !== "catpaw";
    const signinAt = "2026-11-06T01:20:00.000Z";
    return {
      cid: ch.cid,
      display: ch.display,
      signin: { supported, per_account: perAccount, claimed_today: supported, at: supported ? signinAt : null },
      index: {
        version: 1,
        active: state.active[ch.cid] ?? null,
        accounts: list.map((a, i) => ({
          key: a.key,
          uid: a.uid,
          domain: "demo.local",
          label: a.label,
          name: a.name,
          added_at: "2026-10-01T00:00:00.000Z",
          last_used_at: "2026-10-18T00:00:00.000Z",
          // 相对今天算，避免演示数据越放越像「全过期」
          expires_at:
            a.expiresInDays === undefined ? null : Date.now() + a.expiresInDays * 86_400_000,
          health: a.health,
          health_at: "2026-10-18T00:00:00.000Z",
          fail_streak: a.failStreak ?? 0,
          cooldown_until:
            a.cooldownInMinutes === undefined
              ? null
              : new Date(Date.now() + a.cooldownInMinutes * 60_000).toISOString(),
          cooldown_reason: a.cooldownReason,
          signin: perAccount
            ? i === 0
              ? { claimed_today: true, at: signinAt }
              : { claimed_today: false, at: null }
            : null,
        })),
      },
    };
  });
  return { channels };
}

/** `billing` 命令的返回（每模型一条 + 供给它的候选渠道）。 */
export function demoBilling(state: DemoState): { rows: unknown[]; models: string[] } {
  const pairs = demoModels(state);
  const models = [...new Set(pairs.map((row) => row.model))];
  const rows = models.map((model) => ({
    model,
    candidates: pairs
      .filter((row) => row.model === model)
      .map(({ cid }) => {
        const channel = state.channels.find((c) => c.cid === cid);
        const ledger = DEMO_LEDGER[cid];
        const totalOk = ledger?.ok ?? 0;
        const totalFail = ledger?.fail ?? 0;
        // 把渠道级 ok/fail 按账号**均分到底**（末位吃掉余数），
        // 保证「按账号拆分」各项之和恒等于渠道合计 —— 否则演示数据自相矛盾。
        const list = state.accounts[cid] ?? [];
        // 额度（虚构）：有额度概念的渠道按 DEMO_QUOTA 给「总量 / 剩余」，
        // 账号卡片据此画额度条与百分比；没数据的渠道如实给 null（卡片显示「未查到」）。
        const quota = DEMO_QUOTA[cid];
        // 账单时刻取「刚刚」：写死日期会让卡片上的新鲜度显示成「更新于 7 天前」，
        // 看起来像演示数据放坏了
        const billingAt = quota ? new Date(Date.now() - 90_000).toISOString() : null;
        const accounts = list.map((a, i) => {
          const n = list.length;
          const base = Math.floor(totalOk / n);
          const extra = totalOk - base * n;
          const fbase = Math.floor(totalFail / n);
          const fextra = totalFail - fbase * n;
          return {
            key: a.key,
            ok: base + (i < extra ? 1 : 0),
            fail: fbase + (i < fextra ? 1 : 0),
            credits: quota
              ? {
                  remain: quota.remain,
                  size: quota.size,
                  used: quota.size - quota.remain,
                  unit: quota.unit,
                  remain_percent: Math.round((quota.remain / quota.size) * 100),
                }
              : null,
            // 额度基线 = 当前窗口第一次账单的剩余量（百分比的分母，见 POOL-ARCHITECTURE §2.3）
            baseline: quota
              ? { window: "24h", date: "2026-10-18", remain: quota.size, at: "2026-10-18T00:00:00.000Z" }
              : null,
            billing_at: billingAt,
            billing_ok: quota !== undefined,
          };
        });
        return {
          cid,
          display: channel?.display ?? cid,
          exposed_id: model,
          used: ledger?.used ?? 0,
          unit: ledger?.unit ?? "",
          cooling: ledger?.cooling ?? false,
          unsupported: channel?.billing === false,
          ok: totalOk,
          fail: totalFail,
          billing_at: billingAt,
          accounts,
        };
      }),
  }));
  return { rows, models };
}

/** `login` 命令：进入演示登录状态机（二维码 / 授权页两种形态）。 */
export function demoLogin(state: DemoState, cid: string): { started: boolean; message: string } {
  const ch = state.channels.find((c) => c.cid === cid);
  if (!ch) return { started: false, message: `未知渠道 ${cid}` };
  demoStartLogin(state, cid);
  return { started: true, message: "演示模式：已进入登录引导（未访问任何真实上游）" };
}

/**
 * 提交回调链接 / 两步登录的最后一步：演示模式下视为授权完成 —— 标记渠道已登录并造一个
 * 虚构账号入池，然后把状态机推到 `done`（页面据此自动关弹窗）。
 *
 * 不在这里清空 `state.login`：`done` 要留到页面关掉弹窗为止。
 * 下一次 `demoStartLogin` 会覆盖它；取消走 `demoEndLogin`。
 */
export function demoCompleteLogin(state: DemoState): { message: string } {
  const cid = state.login?.cid ?? "";
  const ch = state.channels.find((c) => c.cid === cid);
  if (ch) ch.present = true;
  const list = state.accounts[cid] ?? [];
  if (cid && list.length === 0) {
    const key = `demo${cid.padEnd(14, "0").slice(0, 14)}`;
    list.push({ key, uid: `demo-uid-${cid}`, label: "演示账号", health: "ok" });
    state.accounts[cid] = list;
    state.active[cid] = key;
  }
  if (cid) {
    const base = demoSettingsBase(state);
    state.login = {
      cid,
      snapshot: {
        ...base,
        ui_state: "done",
        message: "演示模式：登录成功，账号已入池（虚构数据）",
      },
    };
  }
  return { message: "演示模式：已模拟完成登录并自动入池" };
}

/** `activateAccount` / `removeAccount`：只改内存池。 */
export function demoActivate(state: DemoState, cid: string, key: string): boolean {
  if (!(state.accounts[cid] ?? []).some((a) => a.key === key)) return false;
  state.active[cid] = key;
  return true;
}

export function demoRemove(state: DemoState, cid: string, key: string): boolean {
  const list = state.accounts[cid] ?? [];
  const idx = list.findIndex((a) => a.key === key);
  if (idx < 0) return false;
  list.splice(idx, 1);
  if (state.active[cid] === key) state.active[cid] = list[0]?.key ?? "";
  return true;
}

/**
 * `resetAccount`：清掉连败熔断 / 额度冷却（与后端 `clearAccountState` 同语义）。
 *
 * `unauthorized` 拒绝 —— 凭据本身失效，清标记只会让界面假装正常。
 */
export function demoReset(
  state: DemoState,
  cid: string,
  key: string,
): { cleared: boolean; health: string; reason?: string } {
  const hit = (state.accounts[cid] ?? []).find((a) => a.key === key);
  if (!hit) return { cleared: false, health: "unknown", reason: `账号 ${key} 不在池里` };
  if (hit.health === "unauthorized") {
    return {
      cleared: false,
      health: hit.health,
      reason: "该账号凭据已失效，需要重新登录（清标记不会让它恢复可用）",
    };
  }
  const changed = hit.health === "error" || hit.health === "cooldown" || (hit.failStreak ?? 0) > 0;
  hit.health = "ok";
  hit.failStreak = 0;
  hit.cooldownInMinutes = undefined;
  hit.cooldownReason = undefined;
  return { cleared: changed, health: hit.health };
}

/**
 * 演示日志的模板（虚构）。
 *
 * 刻意把每种情况都放一条：成功 / 失败 / 中断、慢请求、流式与非流式、
 * 有 usage 与没有 usage、带工具调用与不带 —— 少一种，演示页就少展示一条该有的路径
 * （比如「没有 tokens 时显示 -」这种边界就永远看不到）。
 */
const DEMO_LOG_SEED: Array<{
  cid: string;
  model: string;
  stream: boolean;
  outcome: AccessOutcome;
  status: number;
  durationMs: number;
  upstreamMs: number;
  ttfbMs: number;
  /** 纯生成窗口（毫秒）；缺省 = 该行没记（演示数据大多不写，速率走减法兜底）。 */
  generateMs?: number;
  tokens: { prompt: number; completion: number; total: number } | null;
  error?: string;
  message?: string;
  toolCount?: number;
  messageCount?: number;
}> = [
  { cid: "loomy", model: "deepseek-v4.1-flash", stream: true, outcome: "success", status: 200, durationMs: 8420, upstreamMs: 610, ttfbMs: 1180, tokens: { prompt: 12480, completion: 1332, total: 13812 }, toolCount: 2, messageCount: 14 },
  { cid: "catpaw", model: "deepseek-v4.1-flash", stream: true, outcome: "success", status: 200, durationMs: 3140, upstreamMs: 380, ttfbMs: 640, tokens: { prompt: 8120, completion: 402, total: 8522 }, messageCount: 9 },
  { cid: "loomy", model: "deepseek-v4.1-flash", stream: false, outcome: "success", status: 200, durationMs: 2210, upstreamMs: 1900, ttfbMs: 2210, tokens: { prompt: 4020, completion: 88, total: 4108 }, messageCount: 5 },
  { cid: "traecn", model: "glm-5.3-flash", stream: true, outcome: "failure", status: 502, durationMs: 61040, upstreamMs: 60020, ttfbMs: 60020, tokens: null, error: "upstream_timeout", message: "upstream stream timed out: The operation was aborted due to timeout", messageCount: 22 },
  { cid: "raccoon", model: "deepseek-v4.1-flash", stream: true, outcome: "failure", status: 503, durationMs: 980, upstreamMs: 940, ttfbMs: 980, tokens: null, error: "not_authenticated", message: "not logged in: credential expired", messageCount: 3 },
  { cid: "qodercn", model: "glm-5.3-flash", stream: true, outcome: "success", status: 200, durationMs: 33120, upstreamMs: 520, ttfbMs: 900, tokens: { prompt: 31240, completion: 6210, total: 37450 }, toolCount: 6, messageCount: 31 },
  { cid: "catpaw", model: "deepseek-v4.1-flash", stream: false, outcome: "failure", status: 400, durationMs: 12, upstreamMs: 0, ttfbMs: 0, tokens: null, error: "invalid_request", message: "messages must not be empty", messageCount: 0 },
  { cid: "catpaw", model: "deepseek-v4.1-flash", stream: true, outcome: "failure", status: 0, durationMs: 240, upstreamMs: 0, ttfbMs: 0, tokens: null, error: "no_status", message: "client disconnected before response finished", messageCount: 4 },
  { cid: "loomy", model: "deepseek-v4.1-flash", stream: true, outcome: "success", status: 200, durationMs: 15240, upstreamMs: 700, ttfbMs: 1420, tokens: { prompt: 5600, completion: 3180, total: 8780 }, toolCount: 1, messageCount: 11 },
  // 慢判定的两个归因维度各给一条：首字慢（速率正常）/ 速率慢（首字正常）——
  // 演示页的「慢」标签与两维归因要有可展示的样本，种子全是快行会让功能像不存在
  { cid: "raccoon", model: "deepseek-v4.1-flash", stream: true, outcome: "success", status: 200, durationMs: 14200, upstreamMs: 12400, ttfbMs: 12500, tokens: { prompt: 3200, completion: 520, total: 3720 }, messageCount: 6 },
  { cid: "workbuddy", model: "deepseek-v4.1-flash", stream: true, outcome: "success", status: 200, durationMs: 12600, upstreamMs: 11500, ttfbMs: 1200, tokens: { prompt: 8400, completion: 120, total: 8520 }, messageCount: 2 },
  { cid: "workbuddy", model: "deepseek-v4.1-flash", stream: false, outcome: "success", status: 200, durationMs: 4400, upstreamMs: 4100, ttfbMs: 4400, tokens: { prompt: 980, completion: 640, total: 1620 }, messageCount: 2 },
  { cid: "workbuddy", model: "glm-5.3-flash", stream: true, outcome: "failure", status: 429, durationMs: 1620, upstreamMs: 1580, ttfbMs: 1620, tokens: null, error: "upstream_error", message: "upstream returned HTTP 429: quota exceeded for this window", messageCount: 7 },
  { cid: "loomy", model: "deepseek-v4.1-flash", stream: true, outcome: "success", status: 200, durationMs: 1180, upstreamMs: 300, ttfbMs: 480, tokens: { prompt: 240, completion: 96, total: 336 }, messageCount: 1 },
  { cid: "qodercn", model: "glm-5.3-flash", stream: true, outcome: "success", status: 200, durationMs: 40210, upstreamMs: 880, ttfbMs: 2600, tokens: { prompt: 20480, completion: 9140, total: 29620 }, toolCount: 9, messageCount: 44 },
  { cid: "catpaw", model: "deepseek-v4.1-flash", stream: false, outcome: "success", status: 200, durationMs: 2620, upstreamMs: 2400, ttfbMs: 2620, tokens: { prompt: 1240, completion: 520, total: 1760 }, messageCount: 6 },
];

/** 演示的可用日期（今天起往前三天）。 */
function demoLogDates(now: number): string[] {
  return [0, 1, 2].map((i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10));
}

/** 日志查询（对应 `GET /web/api/logs`）；过滤与分页口径与后端保持一致。 */
export function demoLogs(state: DemoState, query: LogQuery = {}): AccessLogPage {
  const now = Date.now();
  const dates = demoLogDates(now);
  const entries: AccessLogEntry[] = DEMO_LOG_SEED.map((seed, i) => ({
    id: `req_demo${String(i).padStart(4, "0")}9f3c`,
    ts: new Date(now - i * 47_000).toISOString(),
    method: "POST",
    path: "/v1/chat/completions",
    cid: seed.cid,
    model: seed.model,
    stream: seed.stream,
    status: seed.status,
    outcome: seed.outcome,
    ...(seed.error ? { error: seed.error } : {}),
    ...(seed.message ? { message: seed.message } : {}),
    durationMs: seed.durationMs,
    upstreamMs: seed.upstreamMs,
    ttfbMs: seed.ttfbMs,
    requestBytes: 2400 + i * 137,
    messageCount: seed.messageCount ?? 0,
    systemChars: 1180,
    toolCount: seed.toolCount ?? 0,
    // 演示数据：按 prompt 的 ~70% 命中合成（虚构值，但字段形态与真实归一化结果一致）
    tokens:
      seed.tokens === null
        ? null
        : {
            ...seed.tokens,
            cache: {
              hit: Math.round(seed.tokens.prompt * 0.7),
              miss: Math.round(seed.tokens.prompt * 0.3),
            },
          },
    slow: false,
    slowTtfb: false,
    slowTps: false,
  }));

  // 「慢」判定与后端 `log-store.slowVerdictOf` 同口径（首字延迟 + 生成速率）。
  // 速率公式复用本包 `log-format`（与网关同值的唯一 UI 侧实现，勿再内联副本）；
  // 下方三个常量（10000 / 30 / 20）是 log-store `SLOW_*` 的同值副本，改动必须两边同步
  //（docs/LOGGING.md §3.5 / §6）。
  // 判定在**建好的行**上做（不是拿种子另算一遍）：平均 TPS 等统计同样从这些行派生，
  // 演示页与真机才会走同一份样本、同一套字段。
  for (const entry of entries) {
    const completion = entry.tokens?.completion ?? null;
    const tps = completion !== null && completion >= 20 ? tokensPerSecOfEntry(entry) : null;
    entry.slowTtfb = entry.stream === true && (entry.ttfbMs ?? 0) >= 10_000;
    entry.slowTps = tps !== null && tps < 30;
    entry.slow = entry.slowTtfb || entry.slowTps;
  }

  const stats: AccessLogStats = {
    requests: entries.length,
    success: entries.filter((e) => e.outcome === "success").length,
    failure: entries.filter((e) => e.outcome === "failure").length,
    slow: entries.filter((e) => e.slow).length,
    slowTtfb: entries.filter((e) => e.slowTtfb).length,
    slowTps: entries.filter((e) => e.slowTps).length,
    avgDurationMs: Math.round(
      entries.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / Math.max(1, entries.length),
    ),
    // 平均速率只采成功请求的样本（与后端 `queryAccessLogs` 同口径，与上面各字段同一批行）
    avgTps: (() => {
      const rates = entries
        .filter((e) => e.outcome === "success")
        .map(tokensPerSecOfEntry)
        .filter((value): value is number => value !== null);
      return rates.length > 0 ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null;
    })(),
    noUsage: entries.filter((e) => e.tokens === null).length,
    tokens: entries.reduce(
      (acc, e) => ({
        prompt: acc.prompt + (e.tokens?.prompt ?? 0),
        completion: acc.completion + (e.tokens?.completion ?? 0),
        total: acc.total + (e.tokens?.total ?? 0),
      }),
      { prompt: 0, completion: 0, total: 0 },
    ),
    // 加权命中率（口径与后端一致：Σhit / Σ(hit+miss)，见 docs/CACHE-HIT-RATE.md）
    cache: (() => {
      const t = entries.reduce(
        (acc, e) => {
          const c = e.tokens?.cache;
          if (c?.hit === null || c?.hit === undefined || c.miss === null) return acc;
          acc.hit += c.hit;
          acc.total += c.hit + c.miss;
          return acc;
        },
        { hit: 0, total: 0 },
      );
      return { ...t, hitRate: t.total > 0 ? t.hit / t.total : null };
    })(),
  };

  const matched = entries.filter((e) => {
    if (query.outcome !== undefined && e.outcome !== query.outcome) return false;
    if (query.cid !== undefined && e.cid !== query.cid) return false;
    if (query.stream !== undefined && e.stream !== query.stream) return false;
    if (query.slow === true && !e.slow) return false;
    if (query.model !== undefined && !(e.model ?? "").toLowerCase().includes(query.model.toLowerCase())) {
      return false;
    }
    return true;
  });

  const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
  const offset = Math.max(0, query.offset ?? 0);
  return {
    ok: true,
    date: query.date ?? dates[0] ?? "",
    dates,
    cids: [...new Set(entries.map((e) => e.cid ?? ""))].filter((c) => c !== "").sort(),
    slowThresholds: { ttfbMs: 10_000, tps: 30 },
    scanned: entries.length,
    truncated: false,
    total: matched.length,
    stats,
    entries: matched.slice(offset, offset + limit),
  };
}

/** 演示的请求上下文（虚构）：客户端原样体 + 两次尝试的上行体。 */
/** 本地日期 `YYYY-MM-DD`（与日志目录的切分口径一致）。 */
function localDate(d: Date): string {
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 演示用的（渠道 × 模型）权重（聚合键形态与真实一致，权重让环形图有主次）。 */
const DEMO_USAGE_MODELS: Array<{ id: string; weight: number }> = [
  { id: "loomy/deepseek-v4.1-flash", weight: 0.37 },
  { id: "catpaw/deepseek-v4.1-flash", weight: 0.22 },
  { id: "traecn/glm-5.3-flash", weight: 0.15 },
  { id: "qodercn/glm-5.3-flash", weight: 0.12 },
  { id: "raccoon/deepseek-v4.1-flash", weight: 0.09 },
  { id: "raccoon/deepseek-v4.1-flash", weight: 0.05 },
];

/**
 * 用量统计的虚构数据。
 *
 * 数值**确定性生成**（只用日期与索引推导，不取随机数）—— 演示时同一区间每次渲染
 * 都一样，数字不会自己乱跳（与 `demoLogs` 同一考虑）。形态与真实聚合完全一致。
 */
export function demoUsage(range: UsageRange): UsageStats {
  // 365d（热力图的年度视图）在演示里给 90 天的量 —— 保留期之外的格子本来就是空的
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 90;
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  const daily: UsageDaily[] = [];
  const modelTotals = new Map<string, number>();
  let totalTokens = 0;

  for (let i = 0; i < days; i += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const wave = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(i / 2.7));
    const scale = (weekend ? 0.35 : 1) * wave;
    const byModel: Record<string, number> = {};
    let dayTokens = 0;
    for (const m of DEMO_USAGE_MODELS) {
      const t = Math.round(m.weight * scale * 3.6e8);
      byModel[m.id] = t;
      modelTotals.set(m.id, (modelTotals.get(m.id) ?? 0) + t);
      dayTokens += t;
    }
    daily.push({
      date: localDate(day),
      tokens: dayTokens,
      tokensIn: Math.round(dayTokens * 0.72),
      tokensOut: Math.round(dayTokens * 0.28),
      requests: 40 + Math.round(scale * 260),
      messages: 120 + Math.round(scale * 900),
      byModel,
    });
    totalTokens += dayTokens;
  }

  const models: UsageModelRow[] = [...modelTotals.entries()]
    .map(([id, tokens]) => {
      // 聚合键 `cid/model` 拆回两列（cid 与模型名都不含 `/`）
      const slash = id.indexOf("/");
      const cid = slash < 0 ? "" : id.slice(0, slash);
      const model = slash < 0 ? id : id.slice(slash + 1);
      return {
      id,
      model,
      cid,
      tokens,
      input: Math.round(tokens * 0.72),
      output: Math.round(tokens * 0.28),
      cache: Math.round(tokens * 0.55),
      share: totalTokens > 0 ? tokens / totalTokens : 0,
      // 演示数据给一组能覆盖四种标签的样本：快 / 慢（< 100）/ 失败比例高 / 进过排队
      ok: Math.max(1, Math.round(tokens / 40_000)),
      fail: Math.max(0, Math.round(tokens / 900_000)),
      queued: tokens > 40_000_000 ? 2 : 0,
      avgTps: tokens > 60_000_000 ? 210 : 72,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const peakDay = daily.reduce((best, d) => (d.tokens > best.tokens ? d : best), daily[0]!);
  const requests = daily.reduce((sum, d) => sum + d.requests, 0);
  const messages = daily.reduce((sum, d) => sum + d.messages, 0);

  return {
    range,
    from: localDate(from),
    to: localDate(today),
    totals: {
      tokens: totalTokens,
      tokensIn: Math.round(totalTokens * 0.72),
      tokensOut: Math.round(totalTokens * 0.28),
      requests,
      messages,
      // 演示值：失败按 1%、慢按 0.2% 合成（真实口径见 docs/USAGE-STATS.md，逐条分桶）
      success: requests - Math.round(requests * 0.01),
      failure: Math.round(requests * 0.01),
      slow: Math.round(requests * 0.002),
      durationMs: requests * 8200,
      cacheHitRate: 0.74,
      cacheHit: Math.round(totalTokens * 0.55),
      cacheTotal: Math.round(totalTokens * 0.74),
      longestRequestMs: 42_000,
      // 演示值：真实口径是「成功请求的逐条速率均值」，这里取 models[].avgTps（72–210）之间的定值
      avgTps: 148,
      noUsage: Math.round(requests * 0.01),
    },
    daily,
    models,
    // 账号维度（今日）：只给演示账号里前两个，值与 models 的总量同一量级
    accounts: [
      { key: "demo000000000000d1", tokens: Math.round(totalTokens * 0.62), requests: Math.round(requests * 0.6) },
      { key: "demo000000000000a2", tokens: Math.round(totalTokens * 0.21), requests: Math.round(requests * 0.2) },
    ],
    streak: { current: Math.min(days, 12), longest: Math.min(days, 19) },
    peak: {
      date: peakDay.date,
      tokens: peakDay.tokens,
      hour: 15,
      hourTokens: Math.round(peakDay.tokens * 0.14),
    },
    favorite: models[0] === undefined ? null : { id: models[0].id, share: models[0].share },
  };
}

/** 演示仪表盘聚合视图（对应 `GET /web/api/overview`）。 */
export function demoOverview(state: DemoState): OverviewResponse {
  const logPage = demoLogs(state, { limit: 100 });
  const date = new Date().toISOString().slice(0, 10);

  // 每渠道今日成败（从 demo 日志条目聚合）
  const perChannel = new Map<string, { success: number; failure: number }>();
  for (const e of logPage.entries) {
    if (!e.cid) continue;
    const cur = perChannel.get(e.cid) ?? { success: 0, failure: 0 };
    if (e.outcome === "success") cur.success++;
    else if (e.outcome === "failure") cur.failure++;
    perChannel.set(e.cid, cur);
  }

  // 每渠道供给的对外模型数
  const modelCounts = new Map<string, number>();
  for (const { cid } of demoModels(state)) {
    modelCounts.set(cid, (modelCounts.get(cid) ?? 0) + 1);
  }

  // 渠道列表：模型数 + 账号健康 + 今日成败
  const channels = state.channels.map((ch) => {
    const list = state.accounts[ch.cid] ?? [];
    const statuses = { ok: 0, cooldown: 0, error: 0, unauthenticated: 0 };
    for (const a of list) {
      if (a.health === "ok") statuses.ok++;
      else if (a.health === "cooldown") statuses.cooldown++;
      else if (a.health === "error") statuses.error++;
      else if (a.health === "unauthorized") statuses.unauthenticated++;
    }
    const logCounts = perChannel.get(ch.cid) ?? { success: 0, failure: 0 };
    return {
      cid: ch.cid,
      models: modelCounts.get(ch.cid) ?? 0,
      statuses,
      requests: logCounts,
    };
  });

  // 模型池统计：按**去重后的模型**算（跨渠道同一模型算一个）
  const infoByName = new Map<string, { multiplier: number | null; inputModalities: string[]; effort?: { supportedLevels: string[] } | null }>();
  for (const row of demoModelRows(state)) {
    if (!infoByName.has(row.model)) infoByName.set(row.model, row.meta);
  }
  let total = 0;
  let free = 0;
  let vision = 0;
  let thinking = 0;
  for (const [, meta] of infoByName) {
    total++;
    if (meta.multiplier === 0) free++;
    if (meta.inputModalities.some((m) => m !== "text")) vision++;
    if (meta.effort !== null && meta.effort !== undefined) thinking++;
  }

  return {
    ok: true,
    date,
    gateway: { ui_state: "running", gateway_error: "" },
    usage: {
      date,
      requests: logPage.stats.requests,
      success: logPage.stats.success,
      failure: logPage.stats.failure,
      slow: logPage.stats.slow,
      avg_duration_ms: logPage.stats.avgDurationMs,
      tokens: logPage.stats.tokens,
      cache: logPage.stats.cache,
      // 扫描窗口元数据与真实接口同形（演示页不展示，只为形状一致）
      truncated: false,
      scanned: logPage.entries.length,
    },
    channels,
    model_pool: { total, free, vision, thinking },
    recent: logPage.entries.slice(0, 5).map((e) => ({
      id: e.id,
      ts: e.ts,
      cid: e.cid,
      model: e.model,
      outcome: e.outcome,
      status: e.status,
      duration_ms: e.durationMs,
      tokens: e.tokens,
    })),
  };
}
