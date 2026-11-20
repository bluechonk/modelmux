/**
 * API Keys 页：列表 + 弹窗化新建 / 编辑 / 删除确认。
 *
 * 三条硬约束：
 *  - **明文只出现一次**：新建成功当场在弹窗里展示 + 复制；库里只有哈希，列表与
 *    行内复制按钮用的都是**前缀**（够认人、不够还原）；
 *  - **危险动作走确认弹窗**：删除不可逆，行内直接删会误点；
 *  - **表格与请求日志同口径**：全表居中、表头与数据同中心线（见 Logs.tsx 的对齐说明）。
 *
 * 新建与编辑共用同一个 Dialog；对话请求一律校验（无开关），客户端接入要带
 * `Authorization: Bearer <key>`。
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { PageHeader } from "../components/PageHeader";
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
  "tap inline-flex items-center justify-center rounded-lg bg-danger-strong px-4 py-1.5 text-[13px] font-medium text-on-danger transition-colors hover:brightness-95 disabled:opacity-50";

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

/**
 * 白名单选项：对外模型全集（去重裸名）+ 「全部模型」。
 *
 * 用当前池内模型而不是自由文本 —— 手打模型名拼错后网关只会回 400，用户看不出
 * 是白名单写错了还是模型下线了。
 */
function modelOptions(allModels: ReadonlyArray<string>): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "全部模型" },
    ...allModels.map((m) => ({ value: m, label: m })),
  ];
}

/** 新建 / 编辑共用的表单弹窗。 */
function KeyFormDialog({
  state,
  allModels,
  onClose,
  onCreated,
}: {
  state: EditorState;
  allModels: ReadonlyArray<string>;
  onClose: () => void;
  /** 新建成功后进入明文展示（由父组件接管）。 */
  onCreated: (plain: string) => void;
}): ReactElement {
  const toast = useToast();
  const editing = state.mode === "edit";
  const [name, setName] = useState(editing ? state.row.name : "");
  /** 选中的模型（空数组 = 全部模型）。 */
  const [picked, setPicked] = useState<string[]>(editing ? [...state.row.allowedModels] : []);
  const [rpm, setRpm] = useState(editing ? String(state.row.rpmLimit) : "0");
  const options = modelOptions(allModels);
  const nameId = editing ? `key-name-${state.row.id}` : "key-name-create";

  const toggleModel = (model: string): void => {
    setPicked((cur) => (cur.includes(model) ? cur.filter((m) => m !== model) : [...cur, model]));
  };

  const submit = useMutation({
    mutationFn: (): Promise<void> => {
      const nameTrim = name.trim();
      if (nameTrim === "") {
        toast.error("名称必填");
        return Promise.resolve();
      }
      const res = editing
        ? api.commands.updateApiKey(state.row.id, nameTrim, picked, Number(rpm) || 0)
        : api.commands.createApiKey(nameTrim, picked, Number(rpm) || 0);
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
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
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
                {editing ? "明文不可改；白名单与限速保存后立即生效。" : "创建后明文只展示一次。"}
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

          <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">名称</span>
              <Input
                id={nameId}
                value={name}
                autoFocus
                placeholder="如 ci / 笔记本"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-xs text-ink-faint">能用哪些模型</legend>
              {/*
                多选 chips：不选 = 全部模型。选项来自当前模型池 —— 池里没有的模型
                写进白名单也没有任何效果（选路根本不会命中），不如不给选。
              */}
              <div className="flex flex-wrap gap-1.5">
                {options.map((opt) => {
                  const active = opt.value === "" ? picked.length === 0 : picked.includes(opt.value);
                  return (
                    <button
                      key={opt.value || "all"}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        if (opt.value === "") setPicked([]);
                        else toggleModel(opt.value);
                      }}
                      className={`tap rounded-lg border px-2.5 py-1 font-mono text-xs transition-colors ${
                        active
                          ? "border-brand bg-brand text-on-brand"
                          : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">每分钟最多请求几次（0 = 不限）</span>
              <Input value={rpm} inputMode="numeric" onChange={(e) => setRpm(e.target.value)} />
            </label>

            <div className="flex justify-end gap-2">
              <button type="button" className={BTN} onClick={onClose}>
                取消
              </button>
              <button type="submit" className={BTN_PRIMARY} disabled={submit.isPending || name.trim() === ""}>
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
  // 对外模型全集：与账号池模型清单、日志模型筛选同源（快照 5 秒一轮）
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const allModels = [...new Set((state.data?.models ?? []).map((row) => row.model))];
  const refresh = (): void => {
    void keys.refetch();
    void qc.invalidateQueries({ queryKey: ["api-keys"] });
  };

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  /** 待删除的行：ConfirmDialog 关闭后要把焦点还给该行的删除键。 */
  const [pendingDelete, setPendingDelete] = useState<ApiKeyRow | null>(null);
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
      <PageHeader title="API Keys" description="对话请求的准入密钥" />

      <section className="panel p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-faint">共 {rows.length} 个</span>
          <button type="button" className={BTN_PRIMARY} onClick={() => setEditor({ mode: "create" })}>
            <Plus className="h-3 w-3" aria-hidden="true" />
            新建 API key
          </button>
        </div>

        {keys.isError ? (
          <p className="text-sm text-danger">加载失败：{errorText(keys.error)}</p>
        ) : keys.isPending ? (
          <p className="text-sm text-ink-faint">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">还没有 key，点右上角新建。</p>
        ) : (
          <Table className="w-full table-fixed border-collapse text-center text-sm">
            <TableHeader>
              <TableRow className="border-b border-line text-xs text-ink-faint">
                {(
                  [
                    ["name", "名称"],
                    ["prefix", "前缀"],
                    ["models", "模型白名单"],
                    ["rpm", "限速"],
                    ["createdAt", "创建时间"],
                    ["ops", "操作"],
                  ] as const
                ).map(([key, label]) => (
                  <TableHead
                    key={key}
                    className={`whitespace-nowrap px-1 py-2 text-center align-top font-normal ${
                      key === "ops" ? "px-3" : ""
                    }`}
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-b border-line last:border-b-0 hover:bg-overlay/30">
                  <TableCell className="break-words px-1 py-2 align-top text-sm font-medium text-ink">
                    {row.name}
                    {/*
                      一键接入专用 key：它服务的是客户端配置（zcode / dsh），
                      删掉会让已接入的客户端下次请求 401 —— 标注出来避免误删。
                    */}
                    {row.name === "modelmux" && (
                      <span className="ml-1.5 rounded-md bg-overlay px-1.5 py-0.5 align-middle text-[11px] font-normal text-ink-soft">
                        一键接入
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-1 py-2 align-top font-mono text-xs text-ink-soft">
                    {row.prefix}…
                    {/*
                      行内复制的是**前缀**：明文不可回读，前缀足够在客户端配置里
                      认出是哪一把；完整明文只能新建时取一次。
                    */}
                    <span className="ml-1 inline-flex align-middle">
                      <CopyButton value={row.prefix} label={`复制 ${row.name} 的前缀`} />
                    </span>
                  </TableCell>
                  <TableCell className="break-words px-1 py-2 align-top font-mono text-xs text-ink-soft">
                    {row.allowedModels.length === 0 ? "全部模型" : row.allowedModels.join(", ")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-1 py-2 align-top font-mono text-xs text-ink-soft">
                    {row.rpmLimit === 0 ? "不限" : `${row.rpmLimit} 次/分`}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-1 py-2 align-top font-mono text-xs text-ink-faint">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 align-top">
                    <div className="flex items-center justify-center gap-2">
                      <button type="button" className={BTN} onClick={() => setEditor({ mode: "edit", row })}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={`${BTN} inline-flex items-center gap-1.5 text-danger hover:border-danger/50`}
                        onPointerDown={(e) => {
                          // 记下本行删除键：取消确认时焦点要还到这里（同账号卡口径）。
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
          allModels={allModels}
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
                依赖该 key 的客户端下次请求会收到 401。
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
