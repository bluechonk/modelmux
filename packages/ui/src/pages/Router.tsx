/**
 * 接入路由页：默认模型 + 别名表的可视化编辑（落 ~/.modelmux/router.json）。
 *
 * 为什么要有这一层：Claude Code / Codex 会发厂商默认模型名（claude-sonnet-4-5 等），
 * 池里不会有；别名表把它们映射到池 id，默认模型兜住没配过的名字 ——
 * 让四个 CLI「接上就能用」。解析顺序见 docs/CLIENT-INTEGRATION.md。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { api } from "../lib/api";
import type { RouterSettings } from "../lib/types";
import { useToast } from "../components/Toast";
import { PageHeader } from "../components/PageHeader";

/** 别名行（编辑态）：键值都走受控输入。 */
interface AliasRow {
  alias: string;
  target: string;
}

/** 从注册表读出的别名表摊平成可编辑行（顺序稳定：按别名字典序）。 */
function rowsOf(config: RouterSettings): AliasRow[] {
  return Object.entries(config.aliases ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, target]) => ({ alias, target }));
}

export function RouterPage(): ReactElement {
  const toast = useToast();
  const queryClient = useQueryClient();
  const routerQuery = useQuery({ queryKey: ["router"], queryFn: () => api.router() });
  const stateQuery = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });

  const models = stateQuery.data?.models ?? [];
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [rows, setRows] = useState<AliasRow[]>([]);
  /** 当前编辑内容是否已初始化（查询到达时灌一次初值，之后归用户）。 */
  const [hydrated, setHydrated] = useState(false);

  if (routerQuery.data && !hydrated) {
    setDefaultModel(routerQuery.data.default ?? "");
    setRows(rowsOf(routerQuery.data));
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: (config: RouterSettings) => api.saveRouter(config),
    onSuccess: () => {
      toast.success("路由配置已保存。");
      void queryClient.invalidateQueries({ queryKey: ["router"] });
    },
    onError: (err: Error) => toast.error(`保存失败：${err.message}`),
  });

  const saveNow = (): void => {
    const aliases: Record<string, string> = {};
    for (const row of rows) {
      const alias = row.alias.trim();
      const target = row.target.trim();
      if (alias && target) aliases[alias.toLowerCase()] = target;
    }
    save.mutate({ default: defaultModel.trim() || undefined, aliases });
  };

  if (routerQuery.isLoading || stateQuery.isLoading) {
    return (
      <div className="space-y-5" aria-hidden="true">
        <div className="h-6 w-40 animate-pulse rounded-md bg-raised" />
        <div className="h-40 animate-pulse rounded-xl border border-line bg-raised" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="接入路由"
        description="裸模型名与别名的解析规则：别名表 → 目录裸名匹配 → 默认模型兜底"
        actions={
          <button
            type="button"
            onClick={saveNow}
            disabled={save.isPending}
            className="tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            <RotateCw className={`h-3.5 w-3.5 ${save.isPending ? "animate-spin" : ""}`} />
            保存
          </button>
        }
      />

      <section className="rounded-xl border border-line p-4">
        <h2 className="text-sm text-ink">默认模型</h2>
        <p className="mt-1 text-xs text-ink-faint">
          没配别名也没在目录里命中的模型名（如厂商默认名）会落到它；留空则这类请求直接 400。
        </p>
        <select
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          className="tap mt-2.5 w-full max-w-md rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-ink focus:border-line-strong focus:outline-none"
        >
          <option value="">（不兜底）</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </section>

      <section className="rounded-xl border border-line p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm text-ink">别名表</h2>
            <p className="mt-1 text-xs text-ink-faint">
              客户端发来的模型名按别名原样映射到池 id（大小写不敏感）。目标是 <code>渠道/模型</code> 形态。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, { alias: "", target: "" }])}
            className="tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" />
            添加别名
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line p-4 text-center text-xs text-ink-faint">
            暂无别名 —— Claude Code 发来的厂商默认名将落默认模型
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {rows.map((row, index) => (
              <li key={index} className="flex items-center gap-2">
                <input
                  value={row.alias}
                  placeholder="claude-sonnet-4-5"
                  onChange={(e) =>
                    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, alias: e.target.value } : r)))
                  }
                  className="tap w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                />
                <span aria-hidden="true" className="shrink-0 text-xs text-ink-faint">
                  →
                </span>
                <input
                  value={row.target}
                  placeholder="loomy/deepseek-v4.1-flash"
                  list="router-model-options"
                  onChange={(e) =>
                    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, target: e.target.value } : r)))
                  }
                  className="tap w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                  className="tap rounded-lg border border-line p-1 text-ink-faint transition-colors hover:border-danger/40 hover:text-danger"
                  aria-label={`删除别名 ${row.alias || index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <datalist id="router-model-options">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </section>
    </div>
  );
}
