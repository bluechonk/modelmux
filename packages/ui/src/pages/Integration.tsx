/**
 * 接入指南页：四个 CLI（Claude Code / Codex / dsh / zcode）直连网关的配置片段。
 *
 * 片段随当前网关地址与默认模型实时生成，一键复制；详细步骤与坑位
 * 见 docs/CLIENT-INTEGRATION.md。
 */

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";

/** 单个 CLI 的接入卡内容。 */
interface ClientGuide {
  id: string;
  title: string;
  protocol: string;
  /** 生成配置片段（base = 网关地址，model = 推荐模型）。 */
  snippet: (base: string, model: string) => string;
  note: string;
}

const GUIDES: ClientGuide[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    protocol: "Anthropic Messages（/v1/messages）",
    snippet: (base, model) =>
      [
        "# 写入 ~/.claude/settings.json 的 env 块（或会话环境变量）",
        `"ANTHROPIC_BASE_URL": "${base}"`,
        `"ANTHROPIC_MODEL": "${model}"`,
        "",
        "# 或命令行直接指定：",
        `ANTHROPIC_BASE_URL=${base} ANTHROPIC_MODEL=${model} claude`,
      ].join("\n"),
    note: "已有 ANTHROPIC_BASE_URL 指向别处（如 CCR）时，以会话环境变量覆盖 settings.json 的值。",
  },
  {
    id: "codex",
    title: "Codex",
    protocol: "OpenAI Responses（/v1/responses）",
    snippet: (base, model) =>
      [
        "# 追加到 ~/.codex/config.toml",
        "model_provider = \"modelmux\"",
        `model = "${model}"`,
        "",
        "[model_providers.modelmux]",
        "name = \"modelmux\"",
        `base_url = "${base}/v1"`,
        "wire_api = \"responses\"",
      ].join("\n"),
    note: "上下文窗口等元数据可用 model_catalog_json 指向生成的目录文件；未配置时 Codex 用默认值。",
  },
  {
    id: "dsh",
    title: "dsh",
    protocol: "OpenAI 兼容（/v1/chat/completions）",
    snippet: (base, model) =>
      [
        "# dsh 供应商配置（provider.overlay 或桌面端设置）",
        "provider:",
        "  api: openai-compatible",
        `  baseURL: ${base}/v1`,
        "  apiKey: modelmux",
        "  models:",
        `    - ${model}`,
      ].join("\n"),
    note: "apiKey 任意非空值即可（网关无鉴权）；模型必须写池 id 全名。",
  },
  {
    id: "zcode",
    title: "zcode",
    protocol: "OpenAI 兼容（/v1/chat/completions）",
    snippet: (base, model) =>
      [
        "# zcode 桌面端 → 供应商设置 → 新建供应商",
        `API Base URL: ${base}/v1`,
        "API Key: modelmux（任意非空）",
        `模型（personalModelIds）: ${model}`,
      ].join("\n"),
    note: "模型必须加入供应商的 personalModelIds 清单（桌面端操作，禁止脚本改 provider_config.json）。",
  },
];

/** 推荐模型：路由默认模型优先，其次池内第一个。 */
function pickModel(defaultModel: string, models: string[]): string {
  if (defaultModel) return defaultModel;
  return models[0] ?? "<渠道>/<模型>";
}

export function IntegrationPage(): ReactElement {
  const routerQuery = useQuery({ queryKey: ["router"], queryFn: () => api.router() });
  const stateQuery = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (routerQuery.isLoading || stateQuery.isLoading) {
    return (
      <div className="space-y-5" aria-hidden="true">
        <div className="h-6 w-40 animate-pulse rounded-md bg-raised" />
        <div className="h-56 animate-pulse rounded-xl border border-line bg-raised" />
      </div>
    );
  }

  const base = window.location.origin;
  const model = pickModel(routerQuery.data?.default ?? "", stateQuery.data?.models ?? []);

  const copy = async (id: string, text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1200);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="接入指南"
        description={`网关地址 ${base} · 推荐模型 ${model}（可在「接入路由」页改默认模型）`}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {GUIDES.map((guide) => {
          const snippet = guide.snippet(base, model);
          return (
            <section key={guide.id} className="rounded-xl border border-line p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm text-ink">{guide.title}</h2>
                  <p className="mt-0.5 text-xs text-ink-faint">{guide.protocol}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void copy(guide.id, snippet)}
                  className="tap shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                >
                  {copiedId === guide.id ? "已复制" : "复制配置"}
                </button>
              </div>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-raised p-3 font-mono text-[11px] leading-5 text-ink-soft">
                {snippet}
              </pre>
              <p className="mt-2 text-xs text-ink-faint">{guide.note}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
