/**
 * Codex `model_catalog_json` 生成：把池内模型写成 Codex 的模型目录文件。
 *
 * 约束：schema 对齐 Codex 消费的 catalog 形态（camel/snake 双写键由 Codex 兼容，
 * 这里只写 snake 主键 + camel 的 defaultReasoningEffort 单点兼容）；`apply_patch_tool_type`
 * 恒 "freeform"（modelmux 的 apply_patch 桥按 freeform 形态桥接，见 http/protocol/responses.ts）；
 * 渠道没声明 effort 档位的模型省略 reasoning 字段 —— Codex 对缺失字段用默认值，不编造档位。
 *
 * 文档：docs/CLIENT-INTEGRATION.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureCatalog } from "./catalog-snapshot.js";
import type { CatalogEntry } from "../runtime/model-catalog.js";
import { rootDir } from "../runtime/paths.js";

type Rec = Record<string, unknown>;

/** 默认落点：`~/.modelmux/codex-model-catalog.json`（Codex 配置里指这个路径）。 */
export function defaultCodexCatalogPath(): string {
  return join(rootDir(), "codex-model-catalog.json");
}

/**
 * Codex reasoning 档位只认 low/medium/high；`supported_reasoning_levels` 是**每条目必填**
 * （实测缺它整个文件解析失败）—— 渠道声明了档位用真实交集，没声明的给 CCR 同款三档兜底
 * （Codex 只拿它做 UI 选项与 effort 传参，chat 上游不认识 effort 参数会忽略，无害）。
 */
const KNOWN_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * Codex 官方 base instructions（每条目必填，缺失整个 catalog 解析失败）。
 *
 * 与 Codex CLI 内置的同名提示一致（CCR 同款内嵌）：catalog 指向的模型全部走它，
 * 真正的会话级 instructions 仍由 Codex 每次请求携带（instructions 字段），这里只是
 * 满足 schema 的默认底座。Codex 升级改写这份提示时需要同步更新（无自动同步通道）。
 */
const CODEX_BASE_INSTRUCTIONS = `You are Codex, a coding agent working with the user in a shared workspace.

Keep the user informed while completing their task. Before the first tool call, send a brief user-facing message explaining what you will check or change and why. Before a new group of tool calls, briefly describe the next action. Group related calls under one explanation and avoid repetitive narration for each individual call.

Use the commentary channel for these tool preambles and progress updates when channels are available. Otherwise, send a short assistant text message before the tool call. Tool arguments, tool output, and internal reasoning do not replace a user-facing explanation. Match the user's language and keep each update concise.

During longer work, provide periodic progress updates with concrete findings and the next step, especially before edits or lengthy operations. Continue working after an update until the requested task is complete or a blocker requires user input. Respect explicit user preferences about receiving updates.

Inspect the relevant code and workspace instructions before editing. Preserve unrelated user changes, make focused fixes, and run checks appropriate to the change. Use only the tools available in the session and follow its permission and approval requirements.

Finish with a concise final answer describing the outcome, relevant validation, and any remaining limitations. Distinguish completed work from proposed steps and do not claim that checks passed unless they ran successfully.`;

function reasoningFields(entry: CatalogEntry): Rec {
  const levels = entry.effort?.supported_levels ?? [];
  const known = levels.filter((l) => KNOWN_EFFORTS.has(l));
  if (known.length === 0) known.push("low", "medium", "high");
  const capitalized = known.map((l) => l[0]!.toUpperCase() + l.slice(1));
  const out: Rec = {
    supported_reasoning_levels: known.map((l, i) => ({ description: capitalized[i], effort: l })),
  };
  const preferred = ["medium", "low", "high"].find((l) => known.includes(l));
  if (preferred) {
    out["default_reasoning_level"] = preferred;
    out["default_reasoning_effort"] = preferred;
    out["defaultReasoningEffort"] = preferred;
  }
  return out;
}

/** 单池模型 → Codex catalog 条目（字段对齐 Codex 消费的 catalog schema）。 */
function codexEntry(entry: CatalogEntry): Rec {
  const window = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128_000;
  const modalities = Array.isArray(entry.input_modalities) ? (entry.input_modalities as unknown[]).map(String) : ["text"];
  return {
    id: entry.id,
    slug: entry.id,
    model: entry.id,
    display_name: entry.name ?? entry.id,
    description: `modelmux 池模型 ${entry.id}（倍率 ${entry.multiplier ?? "-"}）`,
    base_instructions: CODEX_BASE_INSTRUCTIONS,
    // Codex 的 catalog 反序列化有一批必填字段（实测缺一个整个文件解析失败）：
    // priority / support_verbosity / service_tiers / additional_speed_tiers / upgrade /
    // availability_nux / experimental_supported_tools / web_search_tool_type /
    // supports_image_detail_original —— 按 CCR 同款默认值补齐
    priority: 0,
    support_verbosity: false,
    service_tiers: [],
    additional_speed_tiers: [],
    upgrade: null,
    availability_nux: null,
    experimental_supported_tools: [],
    web_search_tool_type: "text",
    supports_image_detail_original: false,
    context_window: window,
    max_context_window: window,
    effective_context_window_percent: 95,
    input_modalities: modalities,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 },
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    ...reasoningFields(entry),
  };
}

/** 构建整个 catalog 文档（顶层 `{models:[...]}`，按池 id 字典序稳定排序）。 */
export function buildCodexCatalog(): Rec {
  const models = Object.values(ensureCatalog().models)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(codexEntry);
  return { models };
}

/** 生成并落盘；返回写入的绝对路径。 */
export function writeCodexCatalog(outPath?: string): { path: string; count: number } {
  const target = outPath?.trim() ? outPath.trim() : defaultCodexCatalogPath();
  const doc = buildCodexCatalog();
  const count = (doc["models"] as unknown[]).length;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { path: target, count };
}
