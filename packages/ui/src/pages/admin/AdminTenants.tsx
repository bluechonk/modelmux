/**
 * 管理面 · 租户列表：表格（名称/状态/余额/模型数/key 前缀/创建时间）+ 开通弹窗。
 *
 * 为什么是表格而不是卡片列表：运营面首要回答「谁快欠费、谁没授权、谁刚建的」，
 * 这些要**按列纵向扫描**；卡片适合十来条以内的浏览型内容，几十个租户时行高参差、
 * 展开会抖。行点击进详情页（授权/充值/用量都在那里）。
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Plus, RefreshCw } from "lucide-react";

import { adminApi } from "../../lib/api";
import { AdminHeader, useAdminToken } from "../../components/AdminLayout";
import { CopyButton } from "../../components/CopyButton";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useToast } from "../../components/Toast";
import { errorText, formatDateTime } from "../../lib/log-format";

const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";

/** 表格单元格统一：等宽数位（金额/计数）+ 顶部对齐（与日志表同口径）。 */
const CELL = "align-top px-3 py-2.5";

/** 开通租户弹窗：成功后一次性展示明文 key（库里只有 scrypt 哈希，错过只能重开）。 */
function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const { token, onError } = useAdminToken();
  const toast = useToast();
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("1.000000");
  const [created, setCreated] = useState<{ name: string; apiKey: string } | null>(null);
  const create = useMutation({
    mutationFn: () => adminApi.createTenant(token, name.trim(), balance.trim()),
    onSuccess: (res) => {
      setCreated({ name: res.tenant.name, apiKey: res.apiKey });
      setName("");
      onCreated();
      toast.success(`租户 ${res.tenant.name} 已开通`);
    },
    onError,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="开通租户">
      <section className="w-full max-w-lg rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]">
        <h2 className="mb-1 text-sm font-medium text-ink">开通租户</h2>
        <p className="mb-4 text-xs text-ink-faint">API key 只在开通后展示一次；余额后续可在详情页充值。</p>
        {created === null ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="租户名（字母数字 . _ -）"
                className="w-48"
                autoFocus
              />
              <Input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="初始余额 USD" className="w-32" />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={BTN} onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className={BTN}
                disabled={name.trim() === "" || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "开通中…" : "开通"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-ink">
              <span className="font-medium">{created.name}</span> 的 API key：
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-line-strong bg-overlay p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{created.apiKey}</code>
              <CopyButton value={created.apiKey} label="复制租户 API key" />
            </div>
            <p className="mt-2 text-xs text-warn">离开本弹窗后无法再次取回，请立即保存。</p>
            <div className="mt-4 flex justify-end">
              <button type="button" className={BTN} onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export function AdminTenants(): ReactElement {
  const { token, onError } = useAdminToken();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi.tenants(token) });
  if (list.isError) {
    onError(list.error);
  }
  const refresh = (): void => {
    void list.refetch();
    void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
  };
  const tenants = list.data?.tenants ?? [];
  return (
    <div>
      <AdminHeader
        title="租户"
        description="开通、授权与配额：行点击进详情；状态与余额为实时值"
        actions={
          <>
            <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} onClick={refresh}>
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> 刷新
            </button>
            <button
              type="button"
              className={`${BTN} inline-flex items-center gap-1.5`}
              onClick={() => setCreating(true)}
            >
              <Plus className="h-3 w-3" aria-hidden="true" /> 开通租户
            </button>
          </>
        }
      />
      {list.isError ? (
        <p className="text-sm text-danger">租户列表加载失败：{errorText(list.error)}</p>
      ) : list.isPending ? (
        <p className="text-sm text-ink-faint">加载中…</p>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-ink-faint">（还没有租户，用右上「开通租户」建一个）</p>
      ) : (
        <section className="panel overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-line">
                <TableHead className={CELL}>名称</TableHead>
                <TableHead className={CELL}>状态</TableHead>
                <TableHead className={`${CELL} text-right`}>余额 USD</TableHead>
                <TableHead className={CELL}>key 前缀</TableHead>
                <TableHead className={CELL}>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((t) => (
                <TableRow key={t.id} className="border-b border-line last:border-0 hover:bg-overlay/40">
                  <TableCell className={CELL}>
                    <Link
                      to={`/admin/tenants/${t.id}`}
                      className="font-medium text-ink underline-offset-2 hover:underline"
                    >
                      {t.name}
                    </Link>
                  </TableCell>
                  <TableCell className={CELL}>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-soft">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${t.status === "active" ? "bg-free" : "bg-danger"}`}
                        aria-hidden="true"
                      />
                      {t.status === "active" ? "正常" : t.status}
                    </span>
                  </TableCell>
                  <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{t.balanceUsd}</TableCell>
                  <TableCell className={`${CELL} font-mono text-xs text-ink-soft`}>{t.keyPrefixes[0] ?? "—"}</TableCell>
                  <TableCell className={`${CELL} whitespace-nowrap text-xs text-ink-faint`}>
                    {formatDateTime(t.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={refresh} />}
    </div>
  );
}
