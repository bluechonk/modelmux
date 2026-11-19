/**
 * 管理面 · 价格表：模型单价（USD / 百万 token），行内可改。
 *
 * 价格是平台级数据（与具体租户无关），故独占一页而不是塞进租户详情；
 * 上游倍率变化只改这里的数据，结算代码不动（SAAS-REDESIGN §7.4）。
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { adminApi } from "../../lib/api";
import { AdminHeader, useAdminToken } from "../../components/AdminLayout";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useToast } from "../../components/Toast";
import { errorText } from "../../lib/log-format";

const BTN =
  "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";
const CELL = "align-top px-3 py-2.5";

export function AdminPrices(): ReactElement {
  const { token, onError } = useAdminToken();
  const toast = useToast();
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const prices = useQuery({ queryKey: ["admin", "prices"], queryFn: () => adminApi.prices(token) });
  if (prices.isError) onError(prices.error);
  const upsert = useMutation({
    mutationFn: () => adminApi.setPrice(token, model.trim(), input.trim(), output.trim()),
    onSuccess: () => {
      toast.success(`价格已登记：${model.trim()}`);
      setModel("");
      setInput("");
      setOutput("");
      void prices.refetch();
    },
    onError,
  });
  const rows = prices.data?.prices ?? [];
  return (
    <div>
      <AdminHeader
        title="价格表"
        description="USD / 百万 token：预扣按此估算，结算按真实 usage 计费"
      />
      <section className="panel p-4">
        <h2 className="mb-3 text-xs font-medium text-ink-soft">设置 / 更新单价</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名" className="w-48" aria-label="模型名" />
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入单价" className="w-28" aria-label="输入单价" />
          <Input value={output} onChange={(e) => setOutput(e.target.value)} placeholder="输出单价" className="w-28" aria-label="输出单价" />
          <button
            type="button"
            className={BTN}
            disabled={model.trim() === "" || input.trim() === "" || output.trim() === "" || upsert.isPending}
            onClick={() => upsert.mutate()}
          >
            {upsert.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </section>
      <section className="panel mt-4 p-4">
        <h2 className="mb-3 text-xs font-medium text-ink-soft">已登记</h2>
        {prices.isError ? (
          <p className="text-sm text-danger">加载失败：{errorText(prices.error)}</p>
        ) : prices.isPending ? (
          <p className="text-sm text-ink-faint">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-faint">（无价格记录：未定价的模型预扣按 0 计，先登记再放租户流量）</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b border-line">
                <TableHead className={CELL}>模型</TableHead>
                <TableHead className={`${CELL} text-right`}>输入</TableHead>
                <TableHead className={`${CELL} text-right`}>输出</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.model} className="border-b border-line last:border-0">
                  <TableCell className={`${CELL} font-mono text-ink`}>{p.model}</TableCell>
                  <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{p.inputUsdPerMtok}</TableCell>
                  <TableCell className={`${CELL} text-right font-mono tabular-nums text-ink`}>{p.outputUsdPerMtok}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
