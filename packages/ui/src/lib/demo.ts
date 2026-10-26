/**
 * 演示模式的数据源（**本地预览**用：界面完整渲染，动作只改内存状态）。
 *
 * 为什么需要它：控制台每个页面都要 `fetch('/web/api/*')` 读本机网关 ——
 * 网关不发 CORS 头、`console.ts` 的 `isSameOrigin` 拒绝跨源写命令、Chrome 的
 * Private Network Access 拦「公网页 → 127.0.0.1」。演示模式在 `api` 层用本模块
 * 替换 fetch。
 *
 * ⚠ 本模块由**演示构建**（`DEMO=1`）使用：`.github/workflows/demo-pages.yml` 会把它发布到
 * GitHub Pages（只发演示构建）；本地预览见 `docs/WEB-CONSOLE.md` 的「演示模式」。
 *
 * 数据纪律：页面是**公开**的 —— 账号 uid / 手机号 / 域名一律用明显虚构的占位值，
 * 不读取、不复制 `~/.modelmux/` 下的任何真实数据。
 */

import type { UiSnapshot } from "./types";

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
  // 无昵称（实测 nickname 为 null）→ 展示名回落手机号，演示脱敏形态
  astudio: [{ key: "demo000000000000b1", uid: "demo-uid-astudio-1", label: "138****8000", name: "", health: "ok", expiresInDays: 120 }],
  catpaw: [
    // 连败熔断：路由会跳过它，只能靠切号 / 重登 / 点「解除」
    { key: "demo000000000000a1", uid: "demo-uid-catpaw-1", label: "demo-uid-catpaw-1", health: "error", failStreak: 3, expiresInDays: 12 },
    { key: "demo000000000000a2", uid: "demo-uid-catpaw-2", label: "demo-uid-catpaw-2", health: "ok", expiresInDays: 40 },
    // 5 个账号：演示折叠（含冷却/解除的混合状态）
    { key: "demo000000000000a3", uid: "demo-uid-catpaw-3", label: "demo-uid-catpaw-3", health: "cooldown", cooldownInMinutes: 95, cooldownReason: "上游 429 用量限额，等额度窗口刷新", expiresInDays: 18 },
    { key: "demo000000000000a4", uid: "demo-uid-catpaw-4", label: "demo-uid-catpaw-4", health: "ok", expiresInDays: 60 },
    { key: "demo000000000000a5", uid: "demo-uid-catpaw-5", label: "demo-uid-catpaw-5", health: "ok" },
  ],
  // 额度冷却：会自己好，但用户也可以点「解除」提前放行
  lobsterai: [{ key: "demo000000000000c1", uid: "demo-uid-lobster-1", label: "139****0003", name: "139****0003", health: "cooldown", cooldownInMinutes: 180, cooldownReason: "上游 429 用量限额，等额度窗口刷新", expiresInDays: 25 }],
  loomy: [{ key: "demo000000000000d1", uid: "demo-uid-loomy-1", label: "137****0004", name: "137****0004", health: "ok", expiresInDays: 8 }],
  qodercn: [{ key: "demo000000000000e1", uid: "demo-uid-qodercn-1", label: "demo-qoder-user", name: "demo-qoder-user", health: "ok", expiresInDays: 30 }],
  raccoon: [{ key: "demo000000000000f1", uid: "demo-uid-raccoon-1", label: "demo-raccoon-user", name: "demo-raccoon-user", health: "ok" }],
  traecn: [{ key: "demo000000000000g1", uid: "demo-uid-trae-1", label: "demo-trae-user", name: "demo-trae-user", health: "ok", expiresInDays: 3 }],
  // 凭据失效：只能重新登录，**不给**「解除」按钮
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

/** 演示登录流程：扫码形态（渲染二维码）与授权码形态（渲染粘贴框）。 */
const DEMO_LOGIN_KIND: Record<string, "qr" | "code"> = {
  loomy: "qr",
  raccoon: "code",
};

/** 一张 1x1 的占位二维码（演示用；不指向任何真实登录会话）。 */
const DEMO_QR_PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges">` +
      `<rect width="21" height="21" fill="#fff"/>` +
      // 三个定位角 + 一组散点：视觉上像二维码，但不编码任何真实内容
      `<path fill="#111" d="M1 1h7v7H1zM2 2h5v5H2zM13 1h7v7h-7zM14 2h5v5h-5zM1 13h7v7H1zM2 14h5v5H2z"/>` +
      `<path fill="#111" d="M9 9h1v1H9zM11 9h1v1h-1zM13 9h1v1h-1zM15 9h1v1h-1zM10 10h1v1h-1zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM9 11h1v1H9zM11 11h1v1h-1zM13 11h1v1h-1zM16 11h1v1h-1zM10 12h1v1h-1zM12 12h1v1h-1zM15 12h1v1h-1zM17 12h1v1h-1zM9 13h1v1H9zM14 13h1v1h-1zM16 13h1v1h-1zM11 14h1v1h-1zM13 14h1v1h-1zM15 14h1v1h-1zM17 14h1v1h-1zM10 15h1v1h-1zM12 15h1v1h-1zM16 15h1v1h-1zM9 16h1v1H9zM11 16h1v1h-1zM14 16h1v1h-1zM17 16h1v1h-1z"/>` +
      `</svg>`,
  );

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
 * 少一个字段就是一处类型错误，而 UI 的类型检查此前不在 CI 链路里，这类缺口会长期潜伏。
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
 * 开始一轮演示登录：写入状态机，让弹窗从「正在准备」推进到授权步骤。
 *
 * 参考真实行为分两种形态（与 `LoginModal` 的渲染分支一致）：
 * - `qr`：渲染二维码（`qr_url`）—— 如 loomy 的微信扫码；
 * - `code`：渲染「打开授权页」+ 回调链接粘贴框（`auth_url`）—— 如 raccoon。
 */
export function demoStartLogin(state: DemoState, cid: string): void {
  const kind = DEMO_LOGIN_KIND[cid] ?? "code";
  const base = demoSettingsBase(state);
  state.login =
    kind === "qr"
      ? {
          cid,
          snapshot: {
            ...base,
            ui_state: "login",
            message: "演示模式：请用微信扫码（二维码为占位图，不指向真实登录会话）",
            qr_url: DEMO_QR_PLACEHOLDER,
          },
        }
      : {
          cid,
          snapshot: {
            ...base,
            ui_state: "login",
            message: "演示模式：点「打开授权页」完成授权，再把回调链接粘回来",
            auth_url: "https://example.com/oauth/authorize?demo=1&state=demo-state",
          },
        };
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
 * 提交回调链接：演示模式下视为授权完成 —— 标记渠道已登录并造一个虚构账号入池。
 *
 * 这样弹窗里的「完成登录」按钮能真的把流程走完，而不是点了没反应。
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
  demoEndLogin(state);
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
      reason: "该账号凭据已失效，需要重新登录（解除标记不会让它恢复可用）",
    };
  }
  const changed = hit.health === "error" || hit.health === "cooldown" || (hit.failStreak ?? 0) > 0;
  hit.health = "ok";
  hit.failStreak = 0;
  hit.cooldownInMinutes = undefined;
  hit.cooldownReason = undefined;
  return { cleared: changed, health: hit.health };
}
