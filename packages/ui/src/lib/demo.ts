/**
 * 演示模式的数据源（**本地预览**：界面完整渲染，动作只改内存状态）。
 *
 * 控制台页面要 `fetch('/web/api/*')` 读本机网关，而演示构建没有网关（CORS /
 * 同源写校验 / Private Network Access 三重拦截）—— 演示模式在 `api` 层用本模块
 * 替换 fetch。⚠ 由**演示构建**（`DEMO=1`）使用，发布到 GitHub Pages
 * （`.github/workflows/demo-pages.yml`；本地预览见 docs/WEB-CONSOLE.md）。
 *
 * 数据纪律：页面**公开** —— 账号 uid / 手机号 / 域名一律用明显虚构的占位值，
 * 不读取、不复制 `~/.modelmux/` 下的任何真实数据。
 */

import type {
  AccessLogEntry,
  AccessLogPage,
  AccessLogStats,
  AccessOutcome,
  LogQuery,
  OverviewResponse,
  PayloadQueryResult,
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

const DEMO_CHANNELS: DemoChannel[] = [
  { cid: "astudio", display: "AStudio", present: true, billing: false },
  { cid: "catpaw", display: "CatPaw", present: true, billing: true },
  { cid: "lobsterai", display: "LobsterAI", present: true, billing: true },
  { cid: "loomy", display: "Loomy", present: true, billing: true },
  { cid: "qoder", display: "Qoder", present: false, billing: true },
  { cid: "qodercn", display: "Qoder 国内版", present: true, billing: true },
  { cid: "raccoon", display: "Raccoon", present: true, billing: true },
  { cid: "traecn", display: "TRAE", present: true, billing: true },
  { cid: "workbuddy", display: "WorkBuddy", present: false, billing: true },
  { cid: "workbuddyai", display: "WorkBuddyAI", present: true, billing: true },
];

/** 各渠道对外暴露的模型（虚构演示集，形态与真实一致：`<cid>/<模型名>`）。 */
const DEMO_MODELS: Record<string, string[]> = {
  astudio: ["auto", "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "spark-x2.5", "spark-x2.6", "spark-x2.6-lite"],
  catpaw: ["deepseek-v4-flash", "deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "longcat-2.0"],
  lobsterai: ["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5", "glm-5.3", "kimi-k2.6", "minimax-m3", "qwen3.8-max"],
  loomy: ["deepseek-v4-flash", "glm-5.3-flash", "kimi-k2.6", "mimo-v2.5", "minimax-m3", "qwen3.8-flash", "spark-x"],
  qoder: ["glm-5.3-flash"],
  qodercn: ["auto", "deepseek-flash", "deepseek-v4-pro", "glm-5.3", "kimi-k3", "qwen3.8-max"],
  raccoon: ["deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "sensenova-6.8-flash"],
  traecn: ["deepseek-v4-flash", "deepseek-v4-pro", "doubao-seed-2.1-pro", "glm-5.3", "kimi-k2.6", "minimax-m3"],
  workbuddy: ["deepseek-v4.1-flash"],
  workbuddyai: ["deepseek-v4.1-flash"],
};

/** 演示账号池：key / uid / label / name 全是虚构占位值。 */
const DEMO_ACCOUNTS: Record<string, DemoAccount[]> = {
  // 无昵称（实测 nickname 为 null）→ 展示名回落手机号（明文，前端不做脱敏）
  astudio: [{ key: "demo000000000000b1", uid: "demo-uid-astudio-1", label: "13800138000", name: "", health: "ok", expiresInDays: 120 }],
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
  lobsterai: [{ key: "demo000000000000c1", uid: "demo-uid-lobster-1", label: "13912340003", name: "13912340003", health: "cooldown", cooldownInMinutes: 180, cooldownReason: "上游 429 用量限额，等额度窗口刷新", expiresInDays: 25 }],
  loomy: [{ key: "demo000000000000d1", uid: "demo-uid-loomy-1", label: "13712340004", name: "13712340004", health: "ok", expiresInDays: 8 }],
  qodercn: [{ key: "demo000000000000e1", uid: "demo-uid-qodercn-1", label: "demo-qoder-user", name: "demo-qoder-user", health: "ok", expiresInDays: 30 }],
  raccoon: [{ key: "demo000000000000f1", uid: "demo-uid-raccoon-1", label: "demo-raccoon-user", name: "demo-raccoon-user", health: "ok" }],
  traecn: [{ key: "demo000000000000g1", uid: "demo-uid-trae-1", label: "demo-trae-user", name: "demo-trae-user", health: "ok", expiresInDays: 3 }],
  // 凭据失效：只能重新登录（清标记也不会让它恢复可用）
  workbuddyai: [{ key: "demo000000000000h1", uid: "demo-uid-wbai-1", label: "demo-uid-wbai-1", health: "unauthorized", expiresInDays: -2 }],
};

/**
 * 演示额度（虚构）：每个有额度概念的渠道一份「总量 / 剩余 / 单位」。
 *
 * 账号卡片的额度条与百分比按它渲染 —— 不补这份数据的话，演示页上每张卡都写着
 * 「未查到」，看起来像功能坏了（订阅制渠道 `billing: false` 本就没有额度概念，不列）。
 */
const DEMO_QUOTA: Record<string, { size: number; remain: number; unit: string }> = {
  catpaw: { size: 500, remain: 486, unit: "积分" },
  lobsterai: { size: 2000, remain: 1974, unit: "credits" },
  loomy: { size: 5000, remain: 4820, unit: "积分" },
  qodercn: { size: 600, remain: 228, unit: "credits" },
  raccoon: { size: 800, remain: 610, unit: "积分" },
  traecn: { size: 2000, remain: 797, unit: "credits" },
  workbuddyai: { size: 200, remain: 66, unit: "credits" },
};

/** 池账本（虚构用量）。`accounts` 是按生效账号拆分的请求计数。 */
const DEMO_LEDGER: Record<string, { used: number; unit: string; ok: number; fail: number; cooling: boolean }> = {
  // 免费档（billing: false）→ 单位留空，额度条不渲染
  astudio: { used: 0, unit: "", ok: 0, fail: 0, cooling: false },
  catpaw: { used: 128, unit: "credits", ok: 96, fail: 2, cooling: false },
  lobsterai: { used: 0, unit: "credits", ok: 17, fail: 0, cooling: false },
  loomy: { used: 42, unit: "积分", ok: 30, fail: 0, cooling: false },
  qoder: { used: 0, unit: "", ok: 0, fail: 0, cooling: false },
  qodercn: { used: 672, unit: "credits", ok: 210, fail: 3, cooling: false },
  raccoon: { used: 0, unit: "", ok: 12, fail: 1, cooling: true },
  traecn: { used: 1450, unit: "credits", ok: 88, fail: 4, cooling: false },
  workbuddy: { used: 0, unit: "", ok: 0, fail: 0, cooling: false },
  workbuddyai: { used: 216, unit: "credits", ok: 5, fail: 9, cooling: true },
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
   * 这条状态机，否则弹窗会永远停在「正在准备登录会话…」（实测踩过）。
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

/** 全部对外模型 id（`<cid>/<模型>`），只含已登录渠道。 */
export function demoModels(state: DemoState): string[] {
  const out: string[] = [];
  for (const ch of state.channels) {
    if (!ch.present) continue;
    for (const m of DEMO_MODELS[ch.cid] ?? []) out.push(`${ch.cid}/${m}`);
  }
  return out;
}

/** 状态快照（对应 `GET /web/api/state`）。 */
export function demoSettings(state: DemoState): UiSnapshot {
  const base = demoSettingsBase(state);
  // 登录进行中：把登录态叠加到快照上（弹窗据此推进步骤）
  if (state.login) return { ...base, ...state.login.snapshot };
  return base;
}

/**
 * 演示用的模型元数据（键 = 池模型 id）。
 *
 * ⚠ 字段必须与 `UiSnapshot.model_info` 的形状**逐字段对齐**（倍率 / 营销角标 /
 * 上下文窗口 / 单次输出上限 / 输入模态 / 思考档位 / **取值来源**）——
 * 少一个字段就是一处类型错误，而 `npm run typecheck` 覆盖本包，这类缺口会被当场拦住。
 */
function demoModelInfo(models: string[]): UiSnapshot["model_info"] {
  const DEMO_MULTIPLIER: Record<string, number> = {
    "deepseek-v4-flash": 0.03,
    "deepseek-v4.1-flash": 0.06,
    "deepseek-v4-pro": 0.48,
    "glm-5.3": 0.44,
    "glm-5.3-flash": 0.06,
    "glm-5.3-flashx": 0.16,
    "kimi-k3": 0.94,
    "kimi-k2.6": 0.94,
    "longcat-2.0": 0,
    "minimax-m3": 0.22,
    "deepseek-flash": 0.03,
    "doubao-seed-2.1-pro": 0.4,
    "mimo-v2.5": 0.3,
    "qwen3.8-max": 0.6,
    "qwen3.8-flash": 0.05,
    "spark-x": 0.1,
    "glm-5": 0.35,
    "sensenova-6.8-flash": 0.12,
    "doubao-seed-2.0-code-preview-260215": 0.54,
    "doubao-seed-2.1-pro-260915": 0.68,
    "doubao-seed-2.1-turbo-260628": 0.34,
  };
  const DEMO_MARKETING: Record<string, string> = {
    "longcat-2.0": "限时免费",
    "deepseek-v4.1-flash": "新",
  };
  // 演示思考档位（虚构）：只给一部分模型声明，其余为 null（=「不支持」）——
  // 刻意与真实数据同形，避免演示页把「没声明」显示成「支持」。
  // `qwen3.8-flash` 故意按上游那种乱序写（xhigh/low/medium），用来演示界面会按强度重排。
  const DEMO_EFFORT: Record<string, { supportedLevels: string[]; defaultLevel: string }> = {
    "deepseek-v4-flash": { supportedLevels: ["high", "max"], defaultLevel: "high" },
    "deepseek-v4.1-flash": { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
    "deepseek-v4-pro": { supportedLevels: ["high", "max"], defaultLevel: "high" },
    "glm-5.3": { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
    "glm-5.3-flash": { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
    "kimi-k3": { supportedLevels: ["none", "low", "medium", "high"], defaultLevel: "high" },
    "minimax-m3": { supportedLevels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "low" },
    "qwen3.8-flash": { supportedLevels: ["xhigh", "low", "medium"], defaultLevel: "medium" },
  };
  /**
   * 演示窗口 / 输出上限（虚构，只取常见量级）。
   *
   * 给每个模型一组不同数值是**刻意的**：全填 128k / 8k 时「最大上下文」「输出上限」
   * 两列看不出在比什么，多模态那列也永远只有「文本」。
   */
  const DEMO_SIZE: Record<string, { contextWindow: number; maxOutputTokens: number; vision?: boolean }> = {
    "auto": { contextWindow: 1_000_000, maxOutputTokens: 131_072, vision: true },
    "deepseek-v4-flash": { contextWindow: 1_000_000, maxOutputTokens: 393_216 },
    "deepseek-v4.1-flash": { contextWindow: 1_048_576, maxOutputTokens: 393_216, vision: true },
    "deepseek-v4-pro": { contextWindow: 1_048_576, maxOutputTokens: 393_216, vision: true },
    "deepseek-flash": { contextWindow: 1_000_000, maxOutputTokens: 393_216, vision: true },
    "glm-5": { contextWindow: 131_072, maxOutputTokens: 131_072 },
    "glm-5.3": { contextWindow: 1_000_000, maxOutputTokens: 131_072, vision: true },
    "glm-5.3-flash": { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true },
    "glm-5.3-flashx": { contextWindow: 1_024_000, maxOutputTokens: 131_072 },
    "kimi-k2.6": { contextWindow: 262_144, maxOutputTokens: 65_536, vision: true },
    "kimi-k3": { contextWindow: 1_048_576, maxOutputTokens: 1_048_576, vision: true },
    "longcat-2.0": { contextWindow: 1_024_000, maxOutputTokens: 262_144 },
    "mimo-v2.5": { contextWindow: 262_144, maxOutputTokens: 65_536 },
    "minimax-m3": { contextWindow: 1_048_576, maxOutputTokens: 512_000, vision: true },
    "qwen3.8-flash": { contextWindow: 1_000_000, maxOutputTokens: 131_072, vision: true },
    "qwen3.8-max": { contextWindow: 1_000_000, maxOutputTokens: 131_072, vision: true },
    "sensenova-6.8-flash": { contextWindow: 256_000, maxOutputTokens: 63_999 },
    "spark-x": { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  };
  /**
   * 演示「跨渠道推断」的模型（真实口径见 POOL-ARCHITECTURE §2.7）：
   * 本渠道拿不到窗口 / 输出 / 档位时取自同 id 的兄弟渠道，界面在该值后标「推断」。
   * 不给一两个例子的话，README 截图里看不到这个标记。
   */
  const DEMO_CROSS = new Set(["minimax-m3", "sensenova-6.8-flash"]);
  return Object.fromEntries(
    models.map((model) => {
      const name = model.slice(model.indexOf("/") + 1);
      const size = DEMO_SIZE[name];
      const cross = DEMO_CROSS.has(name);
      const effort = DEMO_EFFORT[name] ?? null;
      return [
        model,
        {
          multiplier: DEMO_MULTIPLIER[name] ?? null,
          marketing: DEMO_MARKETING[name] ?? "",
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
      ];
    }),
  );
}

function demoSettingsBase(state: DemoState): UiSnapshot {
  return {
    ui_state: "running",
    message: "演示模式：数据均为虚构，未连接任何真实网关",
    auth_url: "",
    qr_url: "",
    login_input: null,
    base_url: "http://127.0.0.1:4412/v1",
    chat_url: "http://127.0.0.1:4412/v1/chat/completions",
    endpoints: ["/v1/chat/completions", "/v1/models", "/health"],
    models: demoModels(state),
    model_info: demoModelInfo(demoModels(state)),
    channel_caps: Object.fromEntries(state.channels.map((c) => [c.cid, { billing: c.billing }])),
    theme_mode: "dark",
    resolved_theme: "dark",
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
    return {
      cid: ch.cid,
      display: ch.display,
      index: {
        version: 1,
        active: state.active[ch.cid] ?? null,
        accounts: list.map((a) => ({
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
        })),
      },
    };
  });
  return { channels };
}

/** `billing` 命令的返回（每模型一条 + 候选渠道）。 */
export function demoBilling(state: DemoState): { rows: unknown[]; models: string[] } {
  const models = demoModels(state);
  const rows = models.map((model) => {
    const slash = model.indexOf("/");
    const cid = slash < 0 ? model : model.slice(0, slash);
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
      model,
      candidates: [
        {
          cid,
          display: state.channels.find((c) => c.cid === cid)?.display ?? cid,
          exposed_id: model,
          score: ledger?.used ?? 0,
          used: ledger?.used ?? 0,
          unit: ledger?.unit ?? "",
          cooling: ledger?.cooling ?? false,
          unsupported: false,
          ok: totalOk,
          fail: totalFail,
          billing_at: "2026-10-18T00:00:00.000Z",
          accounts,
        },
      ],
    };
  });
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
 * ⚠ 不在这里清空 `state.login`：`done` 要留到页面关掉弹窗为止。
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
  tokens: { prompt: number; completion: number; total: number } | null;
  error?: string;
  message?: string;
  toolCount?: number;
  messageCount?: number;
}> = [
  { cid: "loomy", model: "loomy/kimi-k2.6", stream: true, outcome: "success", status: 200, durationMs: 8420, upstreamMs: 610, ttfbMs: 1180, tokens: { prompt: 12480, completion: 1332, total: 13812 }, toolCount: 2, messageCount: 14 },
  { cid: "catpaw", model: "catpaw/glm-5.3-flash", stream: true, outcome: "success", status: 200, durationMs: 3140, upstreamMs: 380, ttfbMs: 640, tokens: { prompt: 8120, completion: 402, total: 8522 }, messageCount: 9 },
  { cid: "loomy", model: "loomy/qwen3.8-flash", stream: false, outcome: "success", status: 200, durationMs: 2210, upstreamMs: 1900, ttfbMs: 2210, tokens: { prompt: 4020, completion: 88, total: 4108 }, messageCount: 5 },
  { cid: "traecn", model: "traecn/kimi-k2.6", stream: true, outcome: "failure", status: 502, durationMs: 61040, upstreamMs: 60020, ttfbMs: 60020, tokens: null, error: "upstream_timeout", message: "upstream stream timed out: The operation was aborted due to timeout", messageCount: 22 },
  { cid: "raccoon", model: "raccoon/glm-5.3", stream: true, outcome: "failure", status: 503, durationMs: 980, upstreamMs: 940, ttfbMs: 980, tokens: null, error: "not_authenticated", message: "not logged in: credential expired", messageCount: 3 },
  { cid: "qodercn", model: "qodercn/deepseek-v4-pro", stream: true, outcome: "success", status: 200, durationMs: 33120, upstreamMs: 520, ttfbMs: 900, tokens: { prompt: 31240, completion: 6210, total: 37450 }, toolCount: 6, messageCount: 31 },
  { cid: "catpaw", model: "catpaw/glm-5.3-flash", stream: false, outcome: "failure", status: 400, durationMs: 12, upstreamMs: 0, ttfbMs: 0, tokens: null, error: "invalid_request", message: "messages must not be empty", messageCount: 0 },
  { cid: "workbuddyai", model: "workbuddyai/deepseek-v4.1-flash", stream: true, outcome: "other", status: 0, durationMs: 240, upstreamMs: 0, ttfbMs: 0, tokens: null, message: "client disconnected before response finished", messageCount: 4 },
  { cid: "loomy", model: "loomy/minimax-m3", stream: true, outcome: "success", status: 200, durationMs: 15240, upstreamMs: 700, ttfbMs: 1420, tokens: { prompt: 5600, completion: 3180, total: 8780 }, toolCount: 1, messageCount: 11 },
  { cid: "astudio", model: "astudio/spark-x2.6", stream: false, outcome: "success", status: 200, durationMs: 4400, upstreamMs: 4100, ttfbMs: 4400, tokens: { prompt: 980, completion: 640, total: 1620 }, messageCount: 2 },
  { cid: "lobsterai", model: "lobsterai/glm-5.3", stream: true, outcome: "failure", status: 429, durationMs: 1620, upstreamMs: 1580, ttfbMs: 1620, tokens: null, error: "upstream_error", message: "upstream returned HTTP 429: quota exceeded for this window", messageCount: 7 },
  { cid: "loomy", model: "loomy/kimi-k2.6", stream: true, outcome: "success", status: 200, durationMs: 1180, upstreamMs: 300, ttfbMs: 480, tokens: { prompt: 240, completion: 96, total: 336 }, messageCount: 1 },
  { cid: "qodercn", model: "qodercn/kimi-k3", stream: true, outcome: "success", status: 200, durationMs: 40210, upstreamMs: 880, ttfbMs: 2600, tokens: { prompt: 20480, completion: 9140, total: 29620 }, toolCount: 9, messageCount: 44 },
  { cid: "catpaw", model: "catpaw/longcat-2.0", stream: false, outcome: "success", status: 200, durationMs: 2620, upstreamMs: 2400, ttfbMs: 2620, tokens: { prompt: 1240, completion: 520, total: 1760 }, messageCount: 6 },
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
    slow: seed.durationMs >= 30_000,
  }));

  const stats: AccessLogStats = {
    requests: entries.length,
    success: entries.filter((e) => e.outcome === "success").length,
    failure: entries.filter((e) => e.outcome === "failure").length,
    other: entries.filter((e) => e.outcome === "other").length,
    slow: entries.filter((e) => e.slow).length,
    avgDurationMs: Math.round(
      entries.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / Math.max(1, entries.length),
    ),
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

  const needle = query.q?.toLowerCase();
  const matched = entries.filter((e) => {
    if (query.outcome !== undefined && e.outcome !== query.outcome) return false;
    if (query.cid !== undefined && e.cid !== query.cid) return false;
    if (query.stream !== undefined && e.stream !== query.stream) return false;
    if (query.slow === true && !e.slow) return false;
    if (query.model !== undefined && !(e.model ?? "").toLowerCase().includes(query.model.toLowerCase())) {
      return false;
    }
    if (needle !== undefined && needle !== "") {
      const hay = `${e.id} ${e.model ?? ""} ${e.error ?? ""} ${e.message ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
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
    slowMs: 30_000,
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

/** 演示用的模型权重（池 id 形态与真实一致，权重让环形图有主次）。 */
const DEMO_USAGE_MODELS: Array<{ id: string; weight: number }> = [
  { id: "loomy/kimi-k2.6", weight: 0.34 },
  { id: "catpaw/glm-5.3-flash", weight: 0.22 },
  { id: "traecn/kimi-k2.6", weight: 0.15 },
  { id: "qodercn/deepseek-v4-pro", weight: 0.12 },
  { id: "astudio/spark-x2.5", weight: 0.09 },
  { id: "raccoon/glm-5.3", weight: 0.05 },
  { id: "workbuddyai/deepseek-v4.1-flash", weight: 0.03 },
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
    .map(([id, tokens]) => ({
      id,
      tokens,
      input: Math.round(tokens * 0.72),
      output: Math.round(tokens * 0.28),
      cache: Math.round(tokens * 0.55),
      share: totalTokens > 0 ? tokens / totalTokens : 0,
    }))
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
      durationMs: requests * 8200,
      cacheHitRate: 0.74,
      longestRequestMs: 42_000,
    },
    daily,
    models,
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

export function demoLogPayload(id: string): PayloadQueryResult {
  const messages = [
    { role: "system", content: "你是一个演示用的助手，数据全部虚构。" },
    { role: "user", content: "帮我看看这个仓库的日志页要怎么设计。" },
  ];
  const upstreamMessages = [
    ...messages,
    { role: "assistant", content: null, tool_calls: [{ id: "call_demo", type: "function", function: { name: "read_file", arguments: '{"path":"docs/LOGGING.md"}' } }] },
    { role: "tool", tool_call_id: "call_demo", content: "…（演示用的假文档片段）…" },
  ];
  const meta = { model: "loomy/kimi-k2.6", stream: true, temperature: 0.7, tools: [] as unknown[] };
  const now = Date.now();
  return {
    ok: true,
    id,
    date: null,
    records: [
      {
        ts: new Date(now - 60_000).toISOString(),
        seq: 1,
        id,
        phase: "client",
        model: "loomy/kimi-k2.6",
        stream: true,
        bytes: JSON.stringify({ ...meta, messages }).length,
        truncated: false,
        body: JSON.stringify({ ...meta, messages }),
      },
      {
        ts: new Date(now - 59_500).toISOString(),
        seq: 2,
        id,
        phase: "upstream",
        attempt: 0,
        cid: "loomy",
        model: "kimi-k2.6",
        stream: true,
        bytes: JSON.stringify({ ...meta, model: "kimi-k2.6", messages: upstreamMessages }).length,
        truncated: false,
        body: JSON.stringify({ ...meta, model: "kimi-k2.6", messages: upstreamMessages }),
      },
    ],
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

  // 每渠道模型数（从 demoModels 按 cid 前缀计数）
  const modelCounts = new Map<string, number>();
  for (const m of demoModels(state)) {
    const cid = m.slice(0, m.indexOf("/"));
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

  const info = demoModelInfo(demoModels(state)) ?? {};
  let total = 0;
  let free = 0;
  let vision = 0;
  let thinking = 0;
  for (const [, meta] of Object.entries(info)) {
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
      other: logPage.stats.other,
      slow: logPage.stats.slow,
      avg_duration_ms: logPage.stats.avgDurationMs,
      tokens: logPage.stats.tokens,
      cache: logPage.stats.cache,
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
