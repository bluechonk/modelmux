/**
 * API Keys 页：列表 + 弹窗化新建 / 编辑 / 删除确认。
 *
 * 三条硬约束：**明文可回读**（行内复制给完整 `secret`，列里只显示前缀；早期只有哈希
 * 的记录走「重建密钥」）；**危险动作走确认弹窗**；**表格与请求日志同口径**（固定列宽 +
 * 单元格居中，长名称截断）。新建与编辑共用同一个 Dialog；对话请求一律校验。
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Trash2 } from "lucide-react";

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
import { useNarrow } from "../lib/use-narrow";

/** 名称长度上限：与后端 `API_KEY_NAME_MAX` 同值，创建时就拦住。 */
const NAME_MAX = 24;

/** 次操作钮：描边 + overlay 底（本仓既有 BTN 口径）。 */
const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-2.5 py-1 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";
/** 主操作钮：卡片同色 + 描边（不用纯黑纯白，深浅主题下都不突兀）。 */
const BTN_PRIMARY =
  "tap rounded-lg border border-line-strong bg-brand px-3 py-1.5 text-xs font-medium text-on-brand transition-colors hover:bg-brand-deep disabled:opacity-50";
/** 危险操作钮：红底白字（AlertDialogAction 口径）。 */
const BTN_DANGER =
  "tap inline-flex items-center justify-center rounded-lg bg-danger-strong px-4 py-1.5 text-[13px] font-medium text-on-danger transition-colors hover:brightness-95 disabled:opacity-50";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  /** 完整明文：行内复制与一键接入都要它（管理面仅本机直连，故可外发）。 */
  secret?: string | null;
  allowedModels: string[];
  rpmLimit: number;
  createdAt: string;
  lastUsedAt?: string;
}

/** 弹窗模式：新建（无初值）/ 编辑（带 row）。 */
type EditorState = { mode: "create" } | { mode: "edit"; row: ApiKeyRow };

/** 白名单选项：对外模型全集（去重裸名）+ 「全部模型」。 */
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
  /** 新建 / 重建成功后进入明文展示（由父组件接管）；`rebuilt` 区分两者。 */
  onCreated: (plain: string, rebuilt: boolean) => void;
}): ReactElement {
  const toast = useToast();
  const editing = state.mode === "edit";
  const [name, setName] = useState(editing ? state.row.name : "");
  /** 选中的模型（空数组 = 全部模型）。 */
  const [picked, setPicked] = useState<string[]>(editing ? [...state.row.allowedModels] : []);
  const [rpm, setRpm] = useState(editing ? String(state.row.rpmLimit) : "0");
  const options = modelOptions(allModels);
  const nameId = editing ? `key-name-${state.row.id}` : "key-name-create";

  const submit = useMutation({
    mutationFn: (): Promise<void> => {
      const nameTrim = name.trim();
      if (nameTrim === "") {
        toast.error("名称必填");
        return Promise.resolve();
      }
      if (nameTrim.length > NAME_MAX) {
        toast.error(`名称最长 ${NAME_MAX} 字`);
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
          onCreated(plain, false);
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

  /**
   * 重建明文：早期记录只有哈希，取不到完整值（列表只能复制前缀）。
   * 重建会作废旧 key —— 必须在弹窗里明说，不能当普通保存。
   */
  const rebuild = useMutation({
    mutationFn: (): Promise<void> =>
      api.commands.regenerateApiKey(state.mode === "edit" ? state.row.id : "").then((r) => {
        if (!r.ok) {
          toast.error(r.error ?? "重建失败");
          return;
        }
        const plain = typeof r["plain"] === "string" ? r["plain"] : "";
        onCreated(plain, true);
      }),
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/75" />
        <DialogContent
          showCloseButton={false}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="text-sm font-medium text-ink">
              {editing ? "编辑 API key" : "新增 API key"}
            </DialogTitle>
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

          {/*
            间距口径：标题↔表单 16px、字段之间 16px、label↔控件 6px（`gap-1.5`）。
            `gap-1`（4px）在 12px 小标签与 42px 输入框之间读不出层级；而 `<legend>`
            在 flex 容器里**不吃 gap**（实测 legend 底与 chips 顶重合 0px），故改用
            `role="group"` 的普通块，语义由 `aria-label` 保留。
          */}
          <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">名称（{NAME_MAX} 字以内）</span>
              <Input
                id={nameId}
                value={name}
                maxLength={NAME_MAX}
                autoFocus
                placeholder="如 ci / 笔记本"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div role="group" aria-label="能用哪些模型" className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">能用哪些模型</span>
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
                        else setPicked((cur) => (cur.includes(opt.value) ? cur.filter((m) => m !== opt.value) : [...cur, opt.value]));
                      }}
                      className={`tap rounded-lg border px-2.5 py-1 font-mono text-xs transition-colors ${
                        active
                          ? "border-line-strong bg-sel text-sel-ink"
                          : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">每分钟最多请求几次（0 = 不限）</span>
              <Input value={rpm} inputMode="numeric" className="w-28" onChange={(e) => setRpm(e.target.value)} />
            </label>

            {/*
              重建入口只在**编辑一把取不到明文的旧 key**时出现：列表复制只能给前缀，
              用户要完整值就必须换一把。放在左下角与右侧保存区分开，避免误点。
            */}
            <div className="flex items-center justify-between gap-2">
              {editing && !state.row.secret ? (
                <button
                  type="button"
                  className={`${BTN} text-danger hover:border-danger/50`}
                  disabled={rebuild.isPending}
                  onClick={() => rebuild.mutate()}
                >
                  {rebuild.isPending ? "重建中…" : "重建密钥"}
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button type="button" className={BTN} onClick={onClose}>
                  取消
                </button>
                <button type="submit" className={BTN_PRIMARY} disabled={submit.isPending || name.trim() === ""}>
                  {submit.isPending ? "提交中…" : editing ? "保存" : "创建"}
                </button>
              </div>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * 明文展示：新建 / 重建后弹一次，给出可复制的完整 key。
 *
 * 明文可回读（列表里也能复制），这里的弹窗只是「刚生成、先看一眼」的确认，
 * 不是唯一获取途径 —— 因此文案不再写「只展示一次」。
 */
function PlainDialog({
  plain,
  rebuilt,
  onClose,
}: {
  plain: string;
  rebuilt: boolean;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/75" />
        <DialogContent
          showCloseButton={false}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="text-sm font-medium text-ink">
              {rebuilt ? "API key 已重建" : "API key 已创建"}
            </DialogTitle>
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

          <div className="mt-4 flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-[10px] border border-dashed border-line-strong bg-surface p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{plain}</code>
              <CopyButton value={plain} label="复制 API key" />
            </div>
            <p className="rounded-[10px] bg-overlay/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
              {rebuilt
                ? "旧 key 已作废，请把客户端配置里的密钥换成这一把。"
                : "列表里随时可以再复制；一键接入会自动使用这把 key。"}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className={BTN} onClick={() => void navigator.clipboard?.writeText(plain).catch(() => {})}>
                复制
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={onClose} autoFocus>
                完成
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
  /** 明文弹窗：`rebuilt` 区分「刚创建」与「重建」，文案不同。 */
  const [plain, setPlain] = useState<{ value: string; rebuilt: boolean } | null>(null);
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
  /**
   * 列定义：`wide` 标记的列在窄屏**整列不渲染**（同请求日志口径）。
   *
   * 为什么必须少渲染而不是 `hidden md:table-cell`：`display: none` 的 `<td>` 与
   * `<col>` 在 `table-layout: fixed` 下仍占列槽位，390 视口下六列被压到
   * 87/62/62/29/42/42px，密钥列内容 126px 直接右溢 72px、表头互相重叠（实测）。
   * 少渲染后列数与内容恒等，才谈得上对齐。
   */
  const ALL_COLS = [
    { key: "name", label: "名称" },
    { key: "prefix", label: "密钥" },
    { key: "models", label: "模型" },
    { key: "rpm", label: "限速", wide: true },
    { key: "createdAt", label: "创建时间", wide: true },
    { key: "ops", label: "操作" },
  ] as const;

  /** 宽屏列宽：按内容实宽 + 对称内边距的比例（见上方说明）。 */
  const WIDE_WIDTHS: Record<string, string> = {
    name: "27%",
    prefix: "19%",
    models: "19%",
    rpm: "9%",
    createdAt: "13%",
    ops: "13%",
  };

  /** 窄屏列宽：只留四列，同样按比例（`table-fixed` 下 nowrap 内容超宽会右溢）。 */
  const NARROW_WIDTHS: Record<string, string> = {
    name: "26%",
    prefix: "27%",
    models: "27%",
    ops: "20%",
  };

  const narrow = useNarrow(735);
  const cols = narrow ? ALL_COLS.filter((c) => !("wide" in c && c.wide)) : ALL_COLS;
  const widths = narrow ? NARROW_WIDTHS : WIDE_WIDTHS;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="API Keys"
        description="对话请求的准入密钥"
        actions={
          <button type="button" className={BTN_PRIMARY} onClick={() => setEditor({ mode: "create" })}>
            新增
          </button>
        }
      />

      <section className="panel p-4">
        {keys.isError ? (
          <p className="text-sm text-danger">加载失败：{errorText(keys.error)}</p>
        ) : keys.isPending ? (
          <p className="text-sm text-ink-faint">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-faint">
            还没有 key，点右上角「新增」。
          </p>
        ) : (
          // 窄屏给容器 `min-w-[560px]` + `overflow-x-auto`：四列内容下限合计约 560px，
          // 低于它就横向滚动，而不是把密钥列压到 87px 让内容右溢 46px、与相邻列重叠
          // （与请求日志页 `md:min-w-[720px]` 同一口径）。
          <Table
            className={`w-full table-fixed border-collapse text-center text-sm ${narrow ? "min-w-[560px]" : ""}`}
            containerClassName={narrow ? "overflow-x-auto" : undefined}
          >
            <colgroup>
              {cols.map((col) => (
                <col key={col.key} style={{ width: widths[col.key] }} />
              ))}
            </colgroup>
            <TableHeader>
              <TableRow className="border-b border-line text-xs text-ink-faint">
                {cols.map((col) => (
                  <TableHead key={col.key} className="whitespace-nowrap px-2 py-2 text-center align-middle font-normal">
                    {col.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-b border-line last:border-b-0 hover:bg-overlay/30">
                  {/*
                    按 `cols` 逐列渲染：窄屏少渲染的列这里也**少一个 `<td>`**，
                    单元格数与列数恒等（`display:none` 的占位 td 会让表头表体错位）。
                    名称单行截断但**必须 inline 收缩**：`block truncate` 占满列宽、
                    块内文字靠左，表头居中、内容靠左，看着就是没对齐。
                  */}
                  {cols.some((c) => c.key === "name") && (
                    <TableCell className="px-2 py-2 align-middle">
                      <span className="inline-flex max-w-full items-center justify-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink">{row.name}</span>
                        {row.name === "modelmux" && (
                          <span className="flex-none rounded-md bg-overlay px-1.5 py-0.5 text-[11px] font-normal text-ink-soft">
                            一键接入
                          </span>
                        )}
                      </span>
                    </TableCell>
                  )}
                  {cols.some((c) => c.key === "prefix") && (
                    <TableCell className="px-2 py-2 align-middle">
                      <span className="inline-flex items-center justify-center gap-1 font-mono text-xs text-ink-soft">
                        {row.prefix}…
                        {/*
                          复制给**完整明文**（`secret`）：列表里显示前缀只是为了不把长串
                          铺满一列，用户拿到的必须能直接粘进客户端配置。早期只有哈希的
                          记录没有 secret，此时退回复制前缀（并靠「重建」换一把新的）。
                        */}
                        <CopyButton
                          value={row.secret ?? row.prefix}
                          label={
                            row.secret
                              ? `复制 ${row.name} 的完整密钥`
                              : `复制 ${row.name} 的密钥前缀（该 key 需重建才能取完整值）`
                          }
                        />
                      </span>
                    </TableCell>
                  )}
                  {cols.some((c) => c.key === "models") && (
                    <TableCell className="px-2 py-2 align-middle">
                      <span className="inline-flex max-w-full items-center justify-center">
                        <span className="truncate font-mono text-xs text-ink-soft">
                          {row.allowedModels.length === 0 ? "全部模型" : row.allowedModels.join(", ")}
                        </span>
                      </span>
                    </TableCell>
                  )}
                  {cols.some((c) => c.key === "rpm") && (
                    <TableCell className="whitespace-nowrap px-2 py-2 align-middle font-mono text-xs text-ink-soft">
                      {row.rpmLimit === 0 ? "不限" : `${row.rpmLimit} 次/分`}
                    </TableCell>
                  )}
                  {cols.some((c) => c.key === "createdAt") && (
                    <TableCell className="whitespace-nowrap px-2 py-2 align-middle font-mono text-xs text-ink-faint">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                  )}
                  {cols.some((c) => c.key === "ops") && (
                    <TableCell className="whitespace-nowrap px-2 py-2 align-middle">
                      <div className="flex items-center justify-center gap-1.5">
                        <button type="button" className={BTN} onClick={() => setEditor({ mode: "edit", row })}>
                          编辑
                        </button>
                        <button
                          type="button"
                          className={`${BTN} inline-flex items-center gap-1 text-danger hover:border-danger/50`}
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
                  )}
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
          onCreated={(value, rebuilt) => {
            setEditor(null);
            setPlain({ value, rebuilt });
            refresh();
          }}
        />
      )}

      {plain !== null && (
        <PlainDialog plain={plain.value} rebuilt={plain.rebuilt} onClose={() => setPlain(null)} />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="删除 API key"
          body={
            <p className="flex gap-2.5 rounded-[10px] border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
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
