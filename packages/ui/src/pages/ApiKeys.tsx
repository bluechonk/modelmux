/**
 * API Keys 页：新建、查看、编辑白名单与限流、删除。
 *
 * 两条硬约束（与市面通用做法一致）：
 *  - **明文只出现一次**：新建成功当场展示 + 复制，离开后无法再取（库里只有哈希）；
 *  - **列表不含哈希**：只展示 id/名称/前缀/白名单/限流/时间。
 *
 * 校验开关在设置弹窗（`api_key_required`）：改完需重启网关生效 —— 运行期热切换会让
 * 已发出去的 key 突然失效，属于该由用户明确按下「重启」的动作。
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { CopyButton } from "../components/CopyButton";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useToast } from "../components/Toast";
import { errorText, formatDateTime } from "../lib/log-format";

const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";
const CELL = "align-top px-3 py-2.5";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  allowedModels: string[];
  rpmLimit: number;
  createdAt: string;
  lastUsedAt?: string;
}

/** 新建表单：名称、白名单（逗号分隔，留空 = 全部模型）、rpm（0 = 不限）。 */
function CreateCard({ onCreated }: { onCreated: () => void }): ReactElement {
  const toast = useToast();
  const [name, setName] = useState("");
  const [models, setModels] = useState("");
  const [rpm, setRpm] = useState("0");
  const [plain, setPlain] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.commands.createApiKey(name.trim(), models.split(",").map((m) => m.trim()).filter((m) => m !== ""), Number(rpm) || 0),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? "创建失败");
        return;
      }
      setPlain(typeof res["plain"] === "string" ? res["plain"] : null);
      setName("");
      onCreated();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <section className="panel p-4">
      <h2 className="mb-3 text-xs font-medium text-ink-soft">新建 API key</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-faint">名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 ci / 笔记本" className="w-40" />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-ink-faint">模型白名单（逗号分隔，留空 = 全部）</span>
          <Input
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder="deepseek-v4.1-flash, kimi-k3.1-pro"
            className="w-72"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-faint">rpm（0 = 不限）</span>
          <Input value={rpm} onChange={(e) => setRpm(e.target.value)} className="w-24" inputMode="numeric" />
        </label>
        <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} disabled={name.trim() === "" || create.isPending} onClick={() => create.mutate()}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          {create.isPending ? "创建中…" : "创建"}
        </button>
      </div>
      {plain !== null && (
        <div className="mt-3 rounded-lg border border-line-strong bg-overlay p-3">
          <p className="mb-1.5 text-xs text-ink">
            新 key 已创建 —— <span className="font-medium">只显示这一次</span>，请立即复制保存：
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{plain}</code>
            <CopyButton value={plain} label="复制 API key" />
          </div>
          <button type="button" className={`${BTN} mt-2`} onClick={() => setPlain(null)}>
            我已保存
          </button>
        </div>
      )}
    </section>
  );
}

/** 行内编辑：名称 / 白名单 / rpm 就地改（明文与哈希不可改）。 */
function EditRow({ row, onDone }: { row: ApiKeyRow; onDone: () => void }): ReactElement {
  const toast = useToast();
  const [models, setModels] = useState(row.allowedModels.join(", "));
  const [rpm, setRpm] = useState(String(row.rpmLimit));
  const save = useMutation({
    mutationFn: () =>
      api.commands.updateApiKey(row.id, models.split(",").map((m) => m.trim()).filter((m) => m !== ""), Number(rpm) || 0),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? "保存失败");
        return;
      }
      toast.success("已保存");
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="白名单（逗号分隔，空 = 全部）" className="w-72" aria-label="模型白名单" />
      <Input value={rpm} onChange={(e) => setRpm(e.target.value)} className="w-20" inputMode="numeric" aria-label="rpm 上限" />
      <button type="button" className={BTN} disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "保存中…" : "保存"}
      </button>
    </div>
  );
}

function KeyRow({ row, onChanged }: { row: ApiKeyRow; onChanged: () => void }): ReactElement {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.commands.deleteApiKey(row.id),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? "删除失败");
        return;
      }
      toast.success(`已删除 ${row.name}`);
      onChanged();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-medium text-sm text-ink">{row.name}</span>
        <span className="font-mono text-xs text-ink-soft">{row.prefix}…</span>
        <span className="text-xs text-ink-soft">
          白名单{" "}
          <span className="font-mono text-ink">
            {row.allowedModels.length === 0 ? "全部模型" : row.allowedModels.join(", ")}
          </span>
        </span>
        <span className="text-xs text-ink-soft">
          rpm <span className="font-mono tabular-nums text-ink">{row.rpmLimit === 0 ? "不限" : row.rpmLimit}</span>
        </span>
        <span className="text-xs text-ink-faint">{formatDateTime(row.createdAt)}</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN} onClick={() => setEditing((v) => !v)}>
            {editing ? "收起" : "编辑"}
          </button>
          <button
            type="button"
            className={`${BTN} inline-flex items-center gap-1.5`}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" /> 删除
          </button>
        </div>
      </div>
      {editing && <EditRow row={row} onDone={() => { setEditing(false); onChanged(); }} />}
    </div>
  );
}

export function ApiKeys(): ReactElement {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      // CommandData 已把 ok/error 与 data 字段平铺，直接判 ok
      const res = await api.commands.apiKeys();
      if (!res.ok) throw new Error(res.error ?? "加载失败");
      return (res["keys"] as ApiKeyRow[] | undefined) ?? [];
    },
  });
  const refresh = (): void => {
    void keys.refetch();
    void qc.invalidateQueries({ queryKey: ["api-keys"] });
  };
  const rows = keys.data ?? [];
  return (
    <div className="space-y-5 pb-10">
      <PageHeader title="API Keys" description="对话请求的准入密钥：白名单限定可用模型，rpm 限制每分钟请求数" />
      <CreateCard onCreated={refresh} />
      <section className="panel p-4">
        <h2 className="mb-3 text-xs font-medium text-ink-soft">已创建的 key</h2>
        {keys.isError ? (
          <p className="text-sm text-danger">加载失败：{errorText(keys.error)}</p>
        ) : keys.isPending ? (
          <p className="text-sm text-ink-faint">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-ink-faint">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            （还没有 key；新建后需在设置里开启「要求 API key」才会校验）
          </p>
        ) : (
          <div className="divide-y divide-line">
            {rows.map((row) => (
              <KeyRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
