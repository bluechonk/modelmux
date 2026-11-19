/**
 * 管理面 · 审计流水：管理动作留痕（开通 / 授权 / 充值 / 定价），倒序。
 *
 * 只读展示，不做筛选：当前管理动作量级很小（单主体运营），先保证「有据可查」，
 * 等真的需要按动作/时间检索时再加筛选（与日志页那套筛选不同源，不要抄）。
 */

import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { adminApi } from "../../lib/api";
import { AdminHeader, useAdminToken } from "../../components/AdminLayout";
import { errorText, formatDateTime } from "../../lib/log-format";

const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50";

export function AdminAudit(): ReactElement {
  const { token, onError } = useAdminToken();
  const audit = useQuery({ queryKey: ["admin", "audit"], queryFn: () => adminApi.audit(token, 100) });
  if (audit.isError) onError(audit.error);
  const entries = audit.data?.entries ?? [];
  return (
    <div>
      <AdminHeader
        title="审计"
        description="管理动作留痕（actor 恒为 admin）；只读，倒序"
        actions={
          <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} onClick={() => void audit.refetch()}>
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> 刷新
          </button>
        }
      />
      <section className="panel p-4">
        {audit.isError ? (
          <p className="text-sm text-danger">加载失败：{errorText(audit.error)}</p>
        ) : audit.isPending ? (
          <p className="text-sm text-ink-faint">加载中…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-ink-faint">（还没有管理动作）</p>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
                <span className="flex-none text-ink-faint">{formatDateTime(e.at)}</span>
                <span className="flex-none font-mono text-ink">{e.action}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-ink-soft">{JSON.stringify(e.detail)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
