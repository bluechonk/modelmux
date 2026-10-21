/**
 * 演示模式的数据源（GitHub Pages 静态部署用）。
 *
 * 为什么需要它：Pages 是**纯静态托管**（没有后端、跑不了 Node），而控制台每个页面都要
 * `fetch('/web/api/*')` 读本机网关 —— 网关不发 CORS 头、`console.ts` 的 `isSameOrigin`
 * 拒绝跨源写命令、Chrome 的 Private Network Access 拦「公网页 → 127.0.0.1」。
 * 所以演示模式在 `api` 层用本模块替换 fetch：界面完整渲染，动作只改内存状态。
 *
 * 数据纪律：页面是**公开**的 —— 账号 uid / 手机号 / 域名一律用明显虚构的占位值，
 * 不读取、不复制 `~/.modelmux/` 下的任何真实数据。
 */

import type { UiSnapshot } from "./types";

/** 渠道：cid + 展示名 + 是否已登录（虚构）。 */
interface DemoChannel {
  cid: string;
  display: string;
  present: boolean;
}

/** 一个虚构账号。uid/label 全部明显是占位值，不含任何真实身份信息。 */
interface DemoAccount {
  key: string;
  uid: string;
  label: string;
  health: string;
}

const DEMO_CHANNELS: DemoChannel[] = [
  { cid: "catpaw", display: "CatPaw", present: true },
  { cid: "codearts", display: "CodeArts", present: true },
  { cid: "lobsterai", display: "LobsterAI", present: true },
  { cid: "loomy", display: "Loomy", present: true },
  { cid: "orcaterm", display: "OrcaTerm", present: false },
  { cid: "qoder", display: "Qoder", present: false },
  { cid: "qodercn", display: "Qoder 国内版", present: true },
  { cid: "raccoon", display: "Raccoon", present: true },
  { cid: "traecn", display: "TRAE", present: true },
  { cid: "workbuddy", display: "WorkBuddy", present: false },
  { cid: "workbuddyai", display: "WorkBuddyAI", present: true },
];

/** 各渠道对外暴露的模型（虚构演示集，形态与真实一致：`<cid>/<模型名>`）。 */
const DEMO_MODELS: Record<string, string[]> = {
  catpaw: ["deepseek-v4-flash", "deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "longcat-2.0"],
  codearts: ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.3-flash", "kimi-k2.6-vl"],
  lobsterai: ["deepseek-v4-flash", "doubao-seed-2.1-pro", "glm-5", "glm-5.3", "kimi-k2.6", "minimax-m3", "qwen3.8-max"],
  loomy: ["deepseek-v4-flash", "glm-5.3-flash", "kimi-k2.6", "mimo-v2.5", "minimax-m3", "qwen3.8-flash", "spark-x"],
  // 未登录渠道也留一份目录：登录后模型墙立刻多出这一组，演示「登录 → 模型可用」的因果。
  orcaterm: ["deepseek-v4-flash", "glm-5.3-flash", "kimi-k2.6"],
  qoder: ["glm-5.3-flash"],
  qodercn: ["auto", "deepseek-flash", "deepseek-v4-pro", "glm-5.3", "kimi-k3", "qwen3.8-max"],
  raccoon: ["deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "sensenova-6.8-flash"],
  traecn: ["deepseek-v4-flash", "deepseek-v4-pro", "doubao-seed-2.1-pro", "glm-5.3", "kimi-k2.6", "minimax-m3"],
  workbuddy: ["deepseek-v4.1-flash"],
  workbuddyai: ["deepseek-v4.1-flash"],
};

/** 演示账号池：key / uid / label 全是虚构占位值。 */
const DEMO_ACCOUNTS: Record<string, DemoAccount[]> = {
  catpaw: [
    { key: "demo000000000000a1", uid: "demo-uid-catpaw-1", label: "138****0001", health: "ok" },
    { key: "demo000000000000a2", uid: "demo-uid-catpaw-2", label: "138****0002", health: "ok" },
  ],
  codearts: [{ key: "demo000000000000b1", uid: "demo-uid-codearts-1", label: "demo***@example.com", health: "ok" }],
  lobsterai: [{ key: "demo000000000000c1", uid: "demo-uid-lobster-1", label: "139****0003", health: "ok" }],
  loomy: [{ key: "demo000000000000d1", uid: "demo-uid-loomy-1", label: "137****0004", health: "ok" }],
  qodercn: [{ key: "demo000000000000e1", uid: "demo-uid-qodercn-1", label: "demo-qoder-user", health: "ok" }],
  raccoon: [{ key: "demo000000000000f1", uid: "demo-uid-raccoon-1", label: "demo-raccoon-user", health: "ok" }],
  traecn: [{ key: "demo000000000000g1", uid: "demo-uid-trae-1", label: "demo-trae-user", health: "ok" }],
  workbuddyai: [{ key: "demo000000000000h1", uid: "demo-uid-wbai-1", label: "demo-wbai-user", health: "unauthorized" }],
};

/** 池账本（虚构用量）。`accounts` 是按生效账号拆分的请求计数。 */
const DEMO_LEDGER: Record<string, { used: number; unit: string; ok: number; fail: number; cooling: boolean }> = {
  catpaw: { used: 128, unit: "credits", ok: 96, fail: 2, cooling: false },
  codearts: { used: 0, unit: "", ok: 41, fail: 0, cooling: false },
  lobsterai: { used: 0, unit: "credits", ok: 17, fail: 0, cooling: false },
  loomy: { used: 42, unit: "积分", ok: 30, fail: 0, cooling: false },
  orcaterm: { used: 0, unit: "", ok: 0, fail: 0, cooling: false },
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
 * 上下文窗口 / 单次输出上限 / 输入模态）—— 少一个字段就是一处类型错误，
 * 而 UI 的类型检查此前不在 CI 链路里，这类缺口会长期潜伏。
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
  return Object.fromEntries(
    models.map((model) => {
      const name = model.slice(model.indexOf("/") + 1);
      return [
        model,
        {
          multiplier: DEMO_MULTIPLIER[name] ?? null,
          marketing: DEMO_MARKETING[name] ?? "",
          // 演示值（虚构）：窗口与输出上限取常见量级，模态一律文本
          contextWindow: 128000,
          maxOutputTokens: 8192,
          inputModalities: ["text"],
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
          added_at: "2026-10-01T00:00:00.000Z",
          last_used_at: "2026-10-18T00:00:00.000Z",
          expires_at: null,
          health: a.health,
          health_at: "2026-10-18T00:00:00.000Z",
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
