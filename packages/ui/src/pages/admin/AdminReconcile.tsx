/**
 * 管理面 · 对账：`usage_events` 汇总 vs `quota_ledger` 实扣汇总，逐租户比对。
 *
 * 两表在 commit 事务里同写，理论恒等；出现差异即数据缺陷（半写 / 手工改动），
 * 所以要「主动核对并显示差异」而不是等账单对不上才发现。
 */

import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { adminApi } from "../../lib/api";
import { AdminHeader, useAdminToken } from "../../components/AdminLayout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { errorText } from "../../lib/log-format";

const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50";
const CELL = "align-top px-3 py-2.5";

export function AdminReconcile(): ReactElement {
  const { token, onError } = useAdminToken();
  const rec = useQuery({ queryKey: ["admin", "reconcile"], queryFn: () => adminApi.reconcile(token) });
  if (rec.isError) onError(rec.error);
  const diffs = rec.data?.diffs ?? [];
  return (
    <div>
      <AdminHeader
        title="对账"
        description="逐租户比较用量事件汇总与账本实扣汇总；无差异是常态，有差异即数据缺陷"
        actions={
          <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} onClick={() => void rec.refetch()}>
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> 重新核对
          </button>
        }
      />
      {rec.isError ? (
        <p className="text-sm text-danger">核对失败：{errorText(rec.error)}</p>
      ) : rec.isPending ? (
        <p className="text-sm text-ink-faint">核对中…</p>
      ) : diffs.length === 0 ? (
        <section className="panel p-4">
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-free" aria-hidden="true" />
            无差异：每个租户的 usage 汇总与账本实扣一致
          </p>
        </section>
      ) : (
        <section className="panel overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-line">
                <TableHead className={CELL}>租户</TableHead>
                <TableHead className={`${CELL} text-right`}>usage 汇总</TableHead>
                <TableHead className={`${CELL} text-right`}>账本实扣</TableHead>
                <TableHead className={`${CELL} text-right`}>差异</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diffs.map((d) => (
                <TableRow key={d.tenantId} className="border-b border-line last:border-0">
                  <TableCell className={`${CELL} font-mono text-xs text-ink`}>{d.tenantId}</TableCell>
                  <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{d.usageSum}</TableCell>
                  <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{d.ledgerSum}</TableCell>
                  <TableCell className={`${CELL} text-right font-mono tabular-nums text-danger`}>{d.diff}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}
