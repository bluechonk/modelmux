/**
 * API Keys 页：列表 + 弹窗化新建 / 编辑 / 删除确认。
 *
 * 三条硬约束：
 *  - **明文只出现一次**：新建成功当场在弹窗里展示 + 复制，离开后无法再取（库里只有哈希）；
 *  - **列表不含哈希**：只展示名称 / 前缀 / 白名单 / 限流 / 时间；
 *  - **危险动作走确认弹窗**：删除不可逆，行内直接删会误点。
 *
 * 新建与编辑共用同一个 Dialog（编辑只是多一行名称、提交走 update）；校验开关在设置弹窗
 * （`api_key_required`），改完需重启网关生效 —— 运行期热切换会让已发出去的 key 突然失效。
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useToast } from "../components/Toast";
import { errorText, formatDateTime } from "../lib/log-format";

/** 次操作钮：描边 + overlay 底（本仓既有 BTN 口径）。 */
const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";
/** 主操作钮：brand 反色（与登录弹窗主钮同款，白底黑字）。 */
const BTN_PRIMARY =
  "tap rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-on-brand transition-colors hover:bg-brand-deep disabled:opacity-50";
/** 危险操作钮：红底白字（AlertDialogAction 口径）。 */
const BTN_DANGER =
  "tap inline-flex items-center justify-center rounded-lg bg-danger px-4 py-1.5 text-[13px] font-medium text-on-danger transition-colors hover:brightness-95 disabled:opacity-50";

const CELL = "px-3 py-2.5 align-middle";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  allowedModels: string[];
  rpmLimit: number;
  createdAt: string;
  lastUsedAt?: string;
}

/** 弹窗模式：新建（无初值）/ 编辑（带 row）。 */
type EditorState = { mode: "create" } | { mode: "edit"; row: ApiKeyRow };

/** 表单初值：新建空名称，编辑沿用当前记录。 */
function initialForm(state: EditorState): { name: string; models: string; rpm: string } {
  if (state.mode === "create") return { name: "", models: "", rpm: "0" };
  return {
    name: state.row.name,
    models: state.row.allowedModels.join(", "),
    rpm: String(state.row.rpmLimit),
  };
}

/** 把逗号串切成干净数组（空串 = 全部模型，由后端按空数组处理）。 */
function splitModels(raw: string): string[] {
  return raw.split(",").map((m) => m.trim()).filter((m) => m !== "");
}

/**
 * 新建 / 编辑共用的表单弹窗。
 *
 * 关掉即放弃：不做「未保存提醒」—— 字段只有三个、且都可在列表里再改，
 * 弹窗的价值是隔离「正在改」的状态，不是拦住误关。
 */
function KeyFormDialog({
  state,
  onClose,
  onCreated,
}: {
  state: EditorState;
  onClose: () => void;
  /** 新建成功后进入明文展示（由父组件接管）。 */
  onCreated: (plain: string) => void;
}): ReactElement {
  const toast = useToast();
  const [form, setForm] = useState(() => initialForm(state));
  const editing = state.mode === "edit";
  const nameId = editing ? `key-name-${state.row.id}` : "key-name-create";

  const submit = useMutation({
    mutationFn: (): Promise<void> => {
      const allowedModels = splitModels(form.models);
      const rpmLimit = Number(form.rpm) || 0;
      const name = form.name.trim();
      if (name === "") {
        // 名称必填由后端把守，这里先给个不落地的提示，避免空请求往返
        toast.error("名称必填");
        return Promise.resolve();
      }
      const res = editing
        ? api.commands.updateApiKey(state.row.id, name, allowedModels, rpmLimit)
        : api.commands.createApiKey(name, allowedModels, rpmLimit);
      return res.then((r) => {
        if (!r.ok) {
          toast.error(r.error ?? "保存失败");
          return;
        }
        if (!editing) {
          const plain = typeof r["plain"] === "string" ? r["plain"] : "";
          onCreated(plain);
          return;
        }
        toast.success("已保存");
        onClose();
      });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/70" />
        <DialogContent
          showCloseButton={false}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
          aria-describedby={undefined}
        >
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-overlay text-ink-soft" aria-hidden="true">
              {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium text-ink">
                {editing ? "编辑 API key" : "新建 API key"}
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                {editing ? "明文与哈希不可改；白名单与 rpm 保存后立即生效。" : "创建后明文只展示一次，请当场复制保存。"}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="关闭"
                className="tap-square grid h-8 w-8 flex-none place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
              >
                ✕
              </button>
            </DialogClose>
          </div>

          <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">名称</span>
              <Input
                id={nameId}
                value={form.name}
                autoFocus
                placeholder="如 ci / 笔记本"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">模型白名单（逗号分隔，留空 = 全部模型）</span>
              <Input
                value={form.models}
                placeholder="deepseek-v4.1-flash, kimi-k3.1-pro"
                onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">rpm（0 = 不限）</span>
              <Input
                value={form.rpm}
                inputMode="numeric"
                onChange={(e) => setForm((f) => ({ ...f, rpm: e.target.value }))}
              />
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" className={BTN} onClick={onClose}>
                取消
              </button>
              <button type="submit" className={BTN_PRIMARY} disabled={submit.isPending || form.name.trim() === ""}>
                {submit.isPending ? "提交中…" : editing ? "保存" : "创建"}
              </button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * 明文一次性展示。
 *
 * 关闭即失效：明文只存在于这次响应里，父组件随即清空，刷新页面也拿不回。
 */
function PlainDialog({ plain, onClose }: { plain: string; onClose: () => void }): ReactElement {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/70" />
        <DialogContent
          showCloseButton={false}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
          aria-describedby={undefined}
        >
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-overlay text-free" aria-hidden="true">
              ✓
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium text-ink">API key 已创建</DialogTitle>
              <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                现在复制并保存；关闭后无法再次查看明文。
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="关闭"
                className="tap-square grid h-8 w-8 flex-none place-items-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
              >
                ✕
              </button>
            </DialogClose>
          </div>

          <div className="mt-4 flex flex-col gap-3.5">
            <div className="rounded-[10px] border border-dashed border-line-strong bg-surface p-3.5">
              <p className="mb-1.5 text-[11.5px] text-ink-faint">明文密钥</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{plain}</code>
                <CopyButton value={plain} label="复制 API key" />
              </div>
            </div>
            <p className="rounded-[10px] border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-danger">
              <span className="font-medium">只展示一次。</span>
              <span className="text-ink-soft">库里只保存哈希，忘记只能删除重建。</span>
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className={BTN} onClick={() => void navigator.clipboard?.writeText(plain).catch(() => {})}>
                复制
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={onClose} autoFocus>
                我已保存
              </button>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

export function ApiKeys(): ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
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

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  /** 待删除的行与「该行的删除键」：ConfirmDialog 关闭后要把焦点还给它。 */
  const [pendingDelete, setPendingDelete] = useState<ApiKeyRow | null>(null);
  /** 被点的那个删除键 —— 取消确认后焦点要还给它（见 `ConfirmDialog.returnFocusTo`）。 */
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  // ConfirmDialog 卸载时 Radix FocusScope 把焦点还给 BODY，且归还在 commit 后的异步帧
  // （rAF 压不住，effect 同步 focus 同样被覆盖）；150ms 是所有 portal 归还链落定后的窗口。
  const hadPendingDelete = useRef(false);
  useEffect(() => {
    if (pendingDelete !== null) {
      hadPendingDelete.current = true;
      return;
    }
    if (hadPendingDelete.current) {
      hadPendingDelete.current = false;
      setTimeout(() => deleteTriggerRef.current?.focus?.(), 150);
    }
  }, [pendingDelete]);

  const remove = useMutation({
    mutationFn: () => api.commands.deleteApiKey(pendingDelete?.id ?? ""),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.error ?? "删除失败");
        setPendingDelete(null);
        return;
      }
      toast.success(`已删除 ${pendingDelete?.name ?? ""}`);
      setPendingDelete(null);
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const rows = keys.data ?? [];

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="API Keys"
        description="对话请求的准入密钥：白名单限定可用模型，rpm 限制每分钟请求数"
        actions={
          <button type="button" className={BTN_PRIMARY} onClick={() => setEditor({ mode: "create" })}>
            <Plus className="h-3 w-3" aria-hidden="true" />
            新建 API key
          </button>
        }
      />

      <p className="text-xs text-ink-faint">共 {rows.length} 个密钥 · 明文只在创建时展示一次，列表不含哈希</p>

      <section className="panel p-4">
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
          <Table containerClassName="overflow-x-auto">
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>前缀</TableHead>
                <TableHead>模型白名单</TableHead>
                <TableHead>rpm</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className={`${CELL} text-sm font-medium text-ink`}>{row.name}</TableCell>
                  <TableCell className={`${CELL} font-mono text-xs text-ink-soft`}>{row.prefix}…</TableCell>
                  <TableCell className={CELL}>
                    {row.allowedModels.length === 0 ? (
                      <Badge variant="outline" className="font-normal text-ink-soft">全部模型</Badge>
                    ) : (
                      <span className="font-mono text-xs text-ink-soft">{row.allowedModels.join(", ")}</span>
                    )}
                  </TableCell>
                  <TableCell className={`${CELL} font-mono text-xs text-ink`}>
                    {row.rpmLimit === 0 ? "不限" : row.rpmLimit}
                  </TableCell>
                  <TableCell className={`${CELL} font-mono text-xs text-ink-faint`}>{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell className={`${CELL} text-right`}>
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" className={BTN} onClick={() => setEditor({ mode: "edit", row })}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={`${BTN} inline-flex items-center gap-1.5 text-danger hover:border-danger/50`}
                        onPointerDown={(e) => {
                          // 记下本行删除键：取消确认时焦点要还到这里。用 pointerdown 而非
                          // click，与账号卡同口径（点击后立刻卸载会让归还目标消失）。
                          deleteTriggerRef.current = e.currentTarget;
                        }}
                        onClick={() => setPendingDelete(row)}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                        删除
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {editor !== null && (
        <KeyFormDialog
          state={editor}
          onClose={() => setEditor(null)}
          onCreated={(value) => {
            setEditor(null);
            setPlain(value);
            refresh();
          }}
        />
      )}

      {plain !== null && <PlainDialog plain={plain} onClose={() => setPlain(null)} />}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="删除 API key"
          body={
            <p className="flex gap-2.5 rounded-[10px] border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-danger" aria-hidden="true" />
              <span>
                <span className="font-medium text-danger">立即生效：</span>
                依赖该 key 的客户端下次请求会收到 401，需要换用其他 key 或关闭「要求 API key」。
              </span>
            </p>
          }
          confirmLabel="删除"
          busy={remove.isPending}
          returnFocusTo={deleteTriggerRef.current}
          onConfirm={() => remove.mutate()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
