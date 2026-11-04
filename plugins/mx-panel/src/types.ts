// 与 MCP server / 网关 API 对应的响应类型(server.mjs 的 tools/list 是唯一契约源)。

export interface StatusData {
  gateway: { ui_state: string; error: string };
  usage: {
    requests: number;
    success: number;
    failure: number;
    slow: number;
    avg_duration_ms: number;
    tokens: { total: number };
    cache: { hit: number; total: number };
  } | null;
  channels: Array<{
    cid: string;
    display?: string;
    models: number;
    statuses: Record<string, number>;
    logged_in: boolean | null;
    requests: { success: number; failure: number };
  }>;
  auth: { auth_url: string; qr_url: string; login_input: unknown } | null;
  /** 完整控制台地址（网关 /web/，供「控制台」页签 iframe 内嵌） */
  consoleUrl: string;
}

export interface ModelEntry {
  id: string;
  context_window: number | null;
  max_output_tokens: number | null;
  effort: string[] | null;
  input_modalities?: string[] | null;
}

export interface ModelsData {
  models: ModelEntry[];
}

export interface LogEntry {
  ts: string;
  cid: string;
  model: string;
  outcome: string;
  status: number;
  durationMs: number;
  ttfbMs: number;
  messageCount: number;
  tokens: number | null;
  slow: boolean;
}

export interface LogsData {
  total: number;
  entries: LogEntry[];
}

export interface AccountEntry {
  key: string;
  label: string;
  name: string;
  uid: string;
  health: string;
  expires_at: number | null;
  fail_streak: number;
  cooldown_until: string | null;
  cooldown_reason: string;
}

export interface ChannelPool {
  cid: string;
  display: string;
  index: { active: string | null; accounts: AccountEntry[] };
}

export interface AccountsData {
  channels: ChannelPool[];
}

export interface BillingRowAccount {
  key: string;
  ok: number;
  fail: number;
  credits: { remain: number; size: number; used: number } | null;
}

export interface BillingData {
  rows: Array<{ model: string; candidates: Array<{ cid: string; accounts: BillingRowAccount[] }> }>;
}
