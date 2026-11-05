/**
 * 自定义提供商区块：把任意 OpenAI 兼容端点接进模型池（运行时渠道）。
 *
 * 与内置渠道的区别：cid / 地址 / 协议 / key / 模型清单都由用户运行时填写，
 * 因此这里没有静态渠道包，注册表是唯一事实源（`~/.modelmux/custom/providers.json`）。
 *
 * 交互要点：
 *   - **模型默认靠「获取可用模型」拉取**（`GET {base}/models`），不要求用户逐个手输；
 *     手填只作为拉取失败时的兜底
 *   - API Key 只回指纹（`ak_xxxx...xxxx`），表单留空 = 保持原值；原文永不下发
 *   - 删除走二次确认（删掉后该渠道的模型从池里消失）
 */

import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { CustomModel, CustomProvider, CustomProviderInput, ProviderKey } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";

const EMPTY_FORM: CustomProviderInput = {
  id: "",
  display: "",
  baseUrl: "",
  protocol: "openai",
  apiKeys: [{ key: "", label: "" }],
  models: [],
};

/**
 * 多行粘贴拆分：粘贴内容按行拆成多个 key（每行一个），并入现有行列表。
 *
 * 输入框是单行的（粘贴多行会被浏览器合并成一行，凭据就废了），
 * 所以在 onPaste 里 preventDefault 手动拆。
 */
function splitPastedKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function CustomProviders(): ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<CustomProviderInput | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CustomProvider | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.providers(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: (provider: CustomProviderInput) =>
      // 空行（既无原文也无指纹）保存前丢弃
      api.saveProvider({ ...provider, apiKeys: provider.apiKeys.filter((k) => k.key.trim() || k.masked) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["providers"] });
      // 账号池的 key 账号随保存同步（后端 syncKeyAccounts），刷新池页
      void qc.invalidateQueries({ queryKey: ["pool-accounts"] });
      setForm(null);
      toast.success("提供商已保存，模型与 key 账号已同步");
    },
    onError: (err) => toast.error(String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeProvider(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["providers"] });
      setPendingDelete(null);
      toast.success("提供商已删除");
    },
    onError: (err) => toast.error(String(err)),
  });

  /** 拉取远端模型：成功则并入当前表单的模型清单（按 id 去重）。 */
  const fetchModels = async (): Promise<void> => {
    if (!form) return;
    setTargetId("fetch");
    const literalKey = form.apiKeys.find((k) => k.key.trim())?.key.trim() ?? "";
    if (!literalKey && !form.id) {
      toast.error("请先填写 API Key");
      setTargetId(null);
      return;
    }
    try {
      // 已保存的 provider 用服务端手里的 key 拉（编辑时不回显原文，不必重贴）
      const models = await api.fetchProviderModels(form.baseUrl, literalKey, form.id || undefined);
      const known = new Set(form.models.map((m) => m.id));
      const added = models.filter((m) => !known.has(m.id));
      setForm({ ...form, models: [...form.models, ...added] });
      toast.success(`获取到 ${models.length} 个模型，新增 ${added.length} 个`);
    } catch (err) {
      toast.error(`获取模型失败：${String(err)}`);
    } finally {
      setTargetId(null);
    }
  };

  /** 表单 key 行编辑（增删改）。 */
  const setKeyRow = (index: number, patch: Partial<ProviderKey>): void => {
    if (!form) return;
    setForm({ ...form, apiKeys: form.apiKeys.map((k, i) => (i === index ? { ...k, ...patch } : k)) });
  };
  const addKeyRows = (keys: string[]): void => {
    if (!form) return;
    const rows: ProviderKey[] = keys.map((key) => ({ key, label: "" }));
    // 去掉尾部空行再追加，避免留一堆空行
    const cleaned = form.apiKeys.filter((k) => k.key.trim() || k.masked);
    setForm({ ...form, apiKeys: [...cleaned, ...rows] });
  };

  const providers = list.data ?? [];

  return (
    <section className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-ink">自定义提供商</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            任意 OpenAI 兼容端点：填 ID / 地址 / 协议 / Key，模型用「获取可用模型」拉取
          </p>
        </div>
        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_FORM })}
          className="tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
          添加提供商
        </button>
      </div>

      {providers.length === 0 ? (
        <p className="py-3 text-xs text-ink-faint">
          还没有自定义提供商。填好 ID（如 <span className="font-mono">longcat</span>）与 API 地址后保存，
          模型会按 <span className="font-mono">id/模型名</span> 进入模型池。
        </p>
      ) : (
        <ul className="divide-y divide-line/60">
          {providers.map((provider) => (
            <li key={provider.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-medium text-ink">{provider.id}</span>
                  <span className="text-xs text-ink-faint">{provider.display}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-ink-faint">{provider.baseUrl}</div>
              </div>
              <span className="text-xs text-ink-faint">
                {provider.models.length} 个模型 ·{" "}
                {provider.apiKeys.length === 0
                  ? "key 未填"
                  : provider.apiKeys.length <= 2
                    ? provider.apiKeys.map((k) => k.masked ?? "****").join("、")
                    : `${provider.apiKeys.slice(0, 2).map((k) => k.masked ?? "****").join("、")} 等 ${provider.apiKeys.length} 个 key`}
              </span>
              <button
                type="button"
                onClick={() =>
                  setForm({
                    id: provider.id,
                    display: provider.display,
                    baseUrl: provider.baseUrl,
                    protocol: "openai",
                    // key 原文不回显：行里只带 masked 指纹，留空 = 保持原值
                    apiKeys: provider.apiKeys.map((k) => ({ key: "", masked: k.masked ?? "", label: k.label ?? "" })),
                    models: provider.models.map((m) => ({ ...m })),
                  })
                }
                className="tap rounded-lg border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(provider)}
                className="tap rounded-lg border border-line p-1 text-ink-faint transition-colors hover:border-danger/40 hover:text-danger"
                aria-label={`删除 ${provider.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-faint">Provider ID</span>
              <input
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value.trim() })}
                placeholder="longcat"
                className="tap w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
              <span className="mt-1 block text-xs text-ink-faint">
                小写字母开头，仅小写字母 / 数字 / 连字符；模型池里显示为 <span className="font-mono">id/模型名</span>
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-faint">显示名称</span>
              <input
                value={form.display}
                onChange={(e) => setForm({ ...form, display: e.target.value })}
                placeholder="LongCat"
                className="tap w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs text-ink-faint">API 地址（OpenAI 兼容基址）</span>
              <input
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value.trim() })}
                placeholder="https://api.longcat.chat/openai"
                className="tap w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
            </label>
            <div className="block sm:col-span-2">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-faint">
                  API Keys（{form.apiKeys.length}）— 一个 key 在账号池里就是一个账号
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => addKeyRows([""])}
                  className="tap flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加 Key
                </button>
              </div>
              {form.apiKeys.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
                  还没有 key —— 点「添加 Key」，或直接粘贴多行（自动按行拆成多个 key）。
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {form.apiKeys.map((item, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-1.5">
                      <input
                        value={item.label ?? ""}
                        onChange={(e) => setKeyRow(index, { label: e.target.value })}
                        placeholder="备注（可选）"
                        className="tap w-32 shrink-0 rounded-lg border border-line bg-raised px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                      />
                      <input
                        type="password"
                        value={item.key}
                        onChange={(e) => setKeyRow(index, { key: e.target.value })}
                        onPaste={(e) => {
                          const text = e.clipboardData.getData("text");
                          if (text.includes("\n")) {
                            e.preventDefault();
                            addKeyRows(splitPastedKeys(text));
                          }
                        }}
                        placeholder={item.masked ? `已存 ${item.masked}（留空不改）` : "ak_…"}
                        className="tap min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, apiKeys: form.apiKeys.filter((_, i) => i !== index) })}
                        className="tap rounded-lg border border-line p-1 text-ink-faint transition-colors hover:border-danger/40 hover:text-danger"
                        aria-label={`删除第 ${index + 1} 个 key`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <span className="mt-1 block text-xs text-ink-faint">
                可整段粘贴多个 key（自动按行拆）；原文不下发、不落日志。保存后每个 key 进入账号池，可切换 / 失效自动换下一个。
              </span>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-faint">模型清单（{form.models.length}）</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void fetchModels()}
                disabled={targetId !== null || !form.baseUrl}
                className="tap flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${targetId === "fetch" ? "animate-spin" : ""}`} />
                获取可用模型
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, models: [...form.models, { id: "" }] })}
                className="tap flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" />
                添加模型
              </button>
            </div>
            {form.models.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
                还没有模型 —— 填好 API 地址与 Key 后点「获取可用模型」，或手动添加。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {form.models.map((model, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-1.5">
                    <input
                      value={model.id}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          models: form.models.map((m, i) => (i === index ? { ...m, id: e.target.value.trim() } : m)),
                        })
                      }
                      placeholder="模型 ID，如 LongCat-2.5"
                      className="tap min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                    />
                    <input
                      value={model.contextWindow ?? ""}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          models: form.models.map((m, i) =>
                            i === index ? { ...m, contextWindow: Number(e.target.value) || undefined } : m,
                          ),
                        })
                      }
                      placeholder="上下文"
                      inputMode="numeric"
                      className="tap w-20 rounded-lg border border-line bg-raised px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                    />
                    <input
                      value={model.maxOutputTokens ?? ""}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          models: form.models.map((m, i) =>
                            i === index ? { ...m, maxOutputTokens: Number(e.target.value) || undefined } : m,
                          ),
                        })
                      }
                      placeholder="输出上限"
                      inputMode="numeric"
                      className="tap w-20 rounded-lg border border-line bg-raised px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                    />
                    <label className="flex items-center gap-1 text-xs text-ink-faint">
                      <input
                        type="checkbox"
                        checked={(model.inputModalities ?? []).includes("image")}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            models: form.models.map((m, i) =>
                              i === index
                                ? {
                                    ...m,
                                    inputModalities: e.target.checked ? ["text", "image"] : ["text"],
                                  }
                                : m,
                            ),
                          })
                        }
                      />
                      可吃图
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({ ...form, models: form.models.filter((_, i) => i !== index) })
                      }
                      className="tap rounded p-1 text-ink-faint transition-colors hover:text-danger"
                      aria-label="移除该模型"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="tap rounded-lg border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => {
                if (!form.id.trim()) {
                  toast.error("请填写 Provider ID");
                  return;
                }
                save.mutate(form);
              }}
              className="tap rounded-lg border border-line bg-raised px-3 py-1.5 text-xs text-ink transition-colors hover:border-line-strong disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="删除自定义提供商"
          confirmLabel="删除"
          busy={remove.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => remove.mutate(pendingDelete.id)}
          body={
            <>
              将删除 <span className="font-mono text-ink">{pendingDelete.id}</span>（{pendingDelete.display}）。
              该提供商的模型会立即从模型池消失；历史日志仍在磁盘上。此操作不可撤销。
            </>
          }
        />
      )}
    </section>
  );
}
