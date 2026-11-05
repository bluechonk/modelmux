/**
 * Claude Code 的模型发现适配：/v1/models UA 分流与 /api/claude_cli/bootstrap。
 *
 * 约束：UA 判定用 CCR 同款宽容匹配（含 claude 即视为 anthropic 客户端）；
 * capabilities 是 CCR 同款全集合映射（纯函数，字段名与 claude code 的解析对齐）；
 * 数据源只有 catalog 快照（ensureCatalog），不发上游请求。
 *
 * 文档：docs/CLIENT-INTEGRATION.md
 */

import type { IncomingHttpHeaders } from "node:http";

import { ensureCatalog } from "../../pool/catalog-snapshot.js";
import type { CatalogEntry } from "../../runtime/model-catalog.js";

type Rec = Record<string, unknown>;

/** CCR 同款宽容判定：UA 里带 claude 即按 anthropic 客户端对待。 */
export function isClaudeUserAgent(headers: IncomingHttpHeaders): boolean {
  const ua = headers["user-agent"];
  const value = Array.isArray(ua) ? ua[0] : ua;
  return typeof value === "string" && value.toLowerCase().includes("claude");
}

/**
 * auto compact 窗口口径（CCR 同款）：`min(1M, max(100k, contextWindow))`。
 *
 * claude code 拿它决定自动压缩阈值 —— 小窗口模型也要给到 100k 下限，
 * 否则客户端按 0 算，会话刚开头就触发压缩。
 */
export function compactWindow(contextWindow: unknown): number {
  const w = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 0;
  return Math.min(1_000_000, Math.max(100_000, w));
}

/** catalog 的 effort 档位 → CCR capabilities 的 effort 块（low/medium/high/max/ultra/xhigh）。 */
function effortBlock(levels: string[] | null, defaultLevel: string | null): Rec {
  const all = ["low", "medium", "high", "max", "ultra", "xhigh"];
  const out: Rec = { supported: levels !== null && levels.length > 0 };
  for (const level of all) {
    out[level] = { supported: levels?.includes(level) ?? false };
  }
  if (defaultLevel) out["default"] = defaultLevel;
  return out;
}

/**
 * capabilities 全集合映射（CCR 同款字段）：claude code 按它做能力展示与请求约束。
 *
 * modelmux catalog 没有的能力（audio/video/pdf/structured_outputs/batch/citations/
 * code_execution）恒 false；tool_use 恒 true —— chat 上游全支持工具调用。
 */
function capabilitiesOf(entry: CatalogEntry): Rec {
  const maxInput = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 0;
  const modalities = Array.isArray(entry.input_modalities)
    ? (entry.input_modalities as unknown[]).map((m) => String(m).toLowerCase())
    : [];
  const reasoning = entry.effort !== null && Array.isArray(entry.effort.supported_levels) && entry.effort.supported_levels.length > 0;
  return {
    audio_input: { supported: false },
    audio_output: { supported: false },
    batch: { supported: false },
    citations: { supported: false },
    code_execution: { supported: false },
    context_management: {
      clear_thinking_20251015: { supported: reasoning },
      clear_tool_uses_20250919: { supported: true },
      compact_20260112: { supported: false },
      max_input_tokens: maxInput,
      supported: maxInput > 0,
    },
    context_window: {
      max_input_tokens: maxInput,
      supported: maxInput > 0,
      supports_1m_context: maxInput >= 1_000_000,
      one_million_context_variant: false,
    },
    effort: effortBlock(entry.effort?.supported_levels ?? null, entry.effort?.default_level ?? null),
    image_input: { supported: modalities.includes("image") },
    pdf_input: { supported: false },
    structured_outputs: { supported: false },
    thinking: {
      supported: reasoning,
      types: { adaptive: { supported: false }, enabled: { supported: reasoning } },
    },
    tool_use: { supported: true },
    video_input: { supported: false },
  };
}

/** 单模型的 anthropic 形条目（/v1/models 与 bootstrap 的 additional_model_options 共用）。 */
function anthropicModelEntry(entry: CatalogEntry): Rec {
  const maxInput = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 0;
  return {
    capabilities: capabilitiesOf(entry),
    created_at: "1970-01-01T00:00:00Z",
    description: `${entry.name ?? entry.id}（${maxInput > 0 ? `${Math.round(maxInput / 1000)}k 窗口` : "窗口未知"}）`,
    display_name: entry.name ?? entry.id,
    id: entry.id,
    max_input_tokens: maxInput,
    max_tokens: typeof entry.max_output_tokens === "number" ? entry.max_output_tokens : 0,
    model: entry.id,
    name: entry.name ?? entry.id,
    type: "model",
  };
}

/** catalog 快照里全部池模型（稳定排序：池 id 字典序）。 */
function catalogEntries(): CatalogEntry[] {
  return Object.values(ensureCatalog().models).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * `/v1/models` 的 anthropic 风格应答（UA 含 claude 时）。
 *
 * 形态：`{data:[{id,capabilities,created_at,display_name,max_input_tokens,max_tokens,
 * type:"model"}], first_id, has_more:false, last_id}`。
 */
export function anthropicModelsResponse(): Rec {
  const data = catalogEntries().map(anthropicModelEntry);
  return {
    data,
    first_id: data[0]?.["id"] ?? null,
    has_more: false,
    last_id: data.at(-1)?.["id"] ?? null,
  };
}

/**
 * `GET /api/claude_cli/bootstrap`：Claude Code 开启模型发现时的引导面。
 *
 * `auto_compact_windows` 决定客户端的自动压缩阈值；`additional_model_options` 是
 * /v1/models 同款条目（客户端合并进模型选择器）。
 */
export function bootstrapResponse(): Rec {
  const windows: Record<string, number> = {};
  for (const entry of catalogEntries()) {
    windows[entry.id] = compactWindow(entry.context_window);
  }
  return {
    additional_model_options: catalogEntries().map(anthropicModelEntry),
    auto_compact_windows: windows,
    client_data: { rowan_thicket: { ...windows } },
  };
}
