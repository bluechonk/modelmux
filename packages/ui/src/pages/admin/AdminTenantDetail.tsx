/**
 * 管理面 · 租户详情：授权模型（rpm/tpm 可改）、配额充值、账户信息。
 *
 * 单租户的所有运营动作集中在这里，与列表页「扫描」职责分离：
 * 列表回答「谁怎么样」，详情回答「对这一个租户做什么」。
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ChevronLeft } from "lucide-react";

import { adminApi } from "../../lib/api";
import { AdminHeader, useAdminToken } from "../../components/AdminLayout";
import { useAdminQueryError } from "./use-admin-query-error";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useToast } from "../../components/Toast";
import { errorText } from "../../lib/log-format";

const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";
const CELL = "align-top px-3 py-2.5";

export function AdminTenantDetail(): ReactElement {
  const { id = "" } = useParams();
  const { token, onError } = useAdminToken();
  const toast = useToast();
  const [model, setModel] = useState("");
  const [rpm, setRpm] = useState("60");
  const [tpm, setTpm] = useState("200000");
  const [amount, setAmount] = useState("");

  const detail = useQuery({
    queryKey: ["admin", "detail", id],
    queryFn: () => adminApi.detail(token, id),
  });
  useAdminQueryError(detail.error, detail.isError, onError);

  const grant = useMutation({
    mutationFn: () => adminApi.grantModel(token, id, model.trim(), Number(rpm), Number(tpm)),
    onSuccess: () => {
      toast.success(`已授权 ${model.trim()}`);
      setModel("");
      void detail.refetch();
    },
    onError,
  });
  const topup = useMutation({
    mutationFn: () => adminApi.addQuota(token, id, amount.trim()),
    onSuccess: (res) => {
      toast.success(`充值成功，余额 ${res.balance_usd} USD`);
      setAmount("");
      void detail.refetch();
    },
    onError,
  });

  const d = detail.data;
  return (
    <div>
      <Link
        to="/admin"
        className="mb-3 inline-flex items-center gap-1 text-xs text-ink-soft transition-colors hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> 全部租户
      </Link>
      <AdminHeader
        title={d?.tenant.name ?? "租户详情"}
        description={d === undefined ? "加载中…" : `余额 ${d.tenant.balanceUsd} USD · ${d.tenant.status === "active" ? "正常" : d.tenant.status}`}
      />
      {detail.isError ? (
        <p className="text-sm text-danger">加载失败：{errorText(detail.error)}</p>
      ) : d === undefined ? (
        <p className="text-sm text-ink-faint">加载中…</p>
      ) : (
        <div className="space-y-4">
          <section className="panel p-4">
            <h2 className="mb-3 text-xs font-medium text-ink-soft">已授权模型</h2>
            {d.models.length === 0 ? (
              <p className="mb-3 text-xs text-ink-faint">（无模型：该租户的请求一律 403，先在下面授权）</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-line">
                    <TableHead className={CELL}>模型</TableHead>
                    <TableHead className={`${CELL} text-right`}>rpm 上限</TableHead>
                    <TableHead className={`${CELL} text-right`}>tpm 上限</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.models.map((m) => (
                    <TableRow key={m.model} className="border-b border-line last:border-0">
                      <TableCell className={`${CELL} font-mono text-ink`}>{m.model}</TableCell>
                      <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{m.rpmLimit}</TableCell>
                      <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{m.tpmLimit}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="模型名"
                className="w-44"
                aria-label="模型名"
              />
              <Input value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="rpm" className="w-20" aria-label="rpm 上限" />
              <Input value={tpm} onChange={(e) => setTpm(e.target.value)} placeholder="tpm" className="w-24" aria-label="tpm 上限" />
              <button
                type="button"
                className={BTN}
                disabled={model.trim() === "" || grant.isPending}
                onClick={() => grant.mutate()}
              >
                {grant.isPending ? "授权中…" : "授权 / 改限额"}
              </button>
            </div>
          </section>

          <section className="panel p-4">
            <h2 className="mb-3 text-xs font-medium text-ink-soft">配额</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="充值 USD"
                className="w-32"
                aria-label="充值金额 USD"
              />
              <button type="button" className={BTN} disabled={amount.trim() === "" || topup.isPending} onClick={() => topup.mutate()}>
                {topup.isPending ? "充值中…" : "充值"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
