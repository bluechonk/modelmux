/**
 * 租户管理页（服务形态管理面 UI 壳）：开通、授权（rpm/tpm）、充值、价格、对账、审计。
 *
 * 数据全部走 `/admin/*`（Bearer 令牌存 sessionStorage，关标签失效）；
 * 显示条件由 `state.tenant_mode` 决定 —— 本机形态到这一页会被弹回仪表盘。
 * 401 一律清令牌回输入态：令牌错了其他调用全是 401，逐条报错没有意义。
 */

import { useEffect, useState, type ReactElement } from "react";
import { Navigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw } from "lucide-react";
import { AdminAuthError, adminApi, api, clearAdminToken, loadAdminToken, saveAdminToken } from "../lib/api";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/PageHeader";
import { CopyButton } from "../components/CopyButton";
import { useToast, type ToastApi } from "../components/Toast";
import { errorText, formatDateTime } from "../lib/log-format";

const BTN = "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";

/**
 * 管理动作失败统一口径：401 清令牌回输入态，其余 toast 出服务端原因（不吞 error 体）。
 * 在页面根创建一次、逐卡下传 —— 每张卡自己 new 一份会让「令牌失效」只清存储不切界面。
 */
function makeAdminErrorHandler(setToken: (t: string) => void, toast: ToastApi): (err: unknown) => void {
  return (err) => {
    if (err instanceof AdminAuthError) {
      clearAdminToken();
      setToken("");
      toast.error("管理令牌无效，请重新输入");
      return;
    }
    toast.error(errorText(err));
  };
}

/** 查询态的 401 回流：mutation 走 onError，query 失败没有回调，只能观察 error 后统一处理。 */
function useAuthedQueryGuard(error: unknown, onError: (err: unknown) => void): void {
  useEffect(() => {
    if (error instanceof AdminAuthError) onError(error);
  }, [error, onError]);
}

/** 输入态：令牌只进 sessionStorage，验证通过（GET tenants 成功）才算登录。 */
function TokenGate({ onToken }: { onToken: (t: string) => void }): ReactElement {
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const toast = useToast();
  const submit = async (): Promise<void> => {
    const token = draft.trim();
    if (token === "") return;
    setChecking(true);
    try {
      await adminApi.tenants(token);
      saveAdminToken(token);
      onToken(token);
    } catch (err) {
      toast.error(err instanceof AdminAuthError ? "管理令牌无效" : errorText(err));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="panel p-5">
      <h2 className="mb-1.5 text-sm font-medium text-ink">管理令牌</h2>
      <p className="mb-3 text-xs text-ink-faint">
        租户管理走网关的 <span className="font-mono">/admin/*</span>，需要服务启动时注入的管理令牌
        （<span className="font-mono">MODELMUX_ADMIN_TOKEN</span>）。令牌只保存在本标签页会话里。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="Bearer 令牌"
          className="w-64"
          autoFocus
        />
        <button type="button" className={BTN} onClick={() => void submit()} disabled={checking || draft.trim() === ""}>
          {checking ? "验证中…" : "进入管理面"}
        </button>
      </div>
    </section>
  );
}

interface CardProps {
  token: string;
  onError: (err: unknown) => void;
}

/** 开通卡片：成功后一次性展示明文 key（库里只有 scrypt 哈希，错过只能重开租户）。 */
function CreateCard({ token, onError }: CardProps): ReactElement {
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("1.000000");
  const [created, setCreated] = useState<{ name: string; apiKey: string } | null>(null);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => adminApi.createTenant(token, name.trim(), balance.trim()),
    onSuccess: (res) => {
      setCreated({ name: res.tenant.name, apiKey: res.apiKey });
      setName("");
      void qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
      void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
    },
    onError,
  });
  return (
    <section className="panel p-3">
      <h2 className="mb-2 text-xs font-medium text-ink-soft">开通租户</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="租户名（字母数字 . _ -）" className="w-44" />
        <Input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="初始余额 USD" className="w-32" />
        <button
          type="button"
          className={BTN}
          disabled={name.trim() === "" || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "开通中…" : "开通"}
        </button>
      </div>
      {created !== null && (
        <div className="mt-3 rounded-lg border border-line-strong bg-overlay p-3">
          <p className="mb-1.5 text-xs text-ink">
            <span className="font-medium">{created.name}</span> 的 API key —— 仅此一次，离开本页后无法再次取回：
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{created.apiKey}</code>
            <CopyButton value={created.apiKey} label="复制租户 API key" />
          </div>
        </div>
      )}
    </section>
  );
}

/** 展开的详情：当前授权列表 + 授权/改限额表单 + 充值。 */
function TenantDetail({
  token,
  id,
  onChanged,
  onError,
}: CardProps & { id: string; onChanged: () => void }): ReactElement {
  const toast = useToast();
  const [model, setModel] = useState("");
  const [rpm, setRpm] = useState("60");
  const [tpm, setTpm] = useState("200000");
  const [amount, setAmount] = useState("");
  const detail = useQuery({
    queryKey: ["admin", "detail", id],
    queryFn: () => adminApi.detail(token, id),
  });
  useAuthedQueryGuard(detail.error, onError);
  const grant = useMutation({
    mutationFn: () => adminApi.grantModel(token, id, model.trim(), Number(rpm), Number(tpm)),
    onSuccess: () => {
      toast.success(`已授权 ${model.trim()}`);
      setModel("");
      void detail.refetch();
      onChanged();
    },
    onError,
  });
  const topup = useMutation({
    mutationFn: () => adminApi.addQuota(token, id, amount.trim()),
    onSuccess: (res) => {
      toast.success(`充值成功，余额 ${res.balance_usd} USD`);
      setAmount("");
      void detail.refetch();
      onChanged();
    },
    onError,
  });
  if (detail.isError) {
    return <p className="mt-2 text-xs text-danger">详情加载失败：{errorText(detail.error)}</p>;
  }
  const d = detail.data;
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
        已授权
        {d === undefined ? (
          <span>加载中…</span>
        ) : d.models.length === 0 ? (
          <span>（无模型，租户请求一律 403）</span>
        ) : (
          d.models.map((m) => (
            <span key={m.model} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1">
              <span className="font-mono text-ink">{m.model}</span>
              rpm <span className="font-mono tabular-nums text-ink">{m.rpmLimit}</span>
              tpm <span className="font-mono tabular-nums text-ink">{m.tpmLimit}</span>
            </span>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名" className="w-40" />
        <Input value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="rpm" className="w-20" inputMode="numeric" />
        <Input value={tpm} onChange={(e) => setTpm(e.target.value)} placeholder="tpm" className="w-24" inputMode="numeric" />
        <button type="button" className={BTN} disabled={model.trim() === "" || grant.isPending} onClick={() => grant.mutate()}>
          {grant.isPending ? "授权中…" : "授权 / 改限额"}
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="充值 USD" className="w-28" />
        <button type="button" className={BTN} disabled={amount.trim() === "" || topup.isPending} onClick={() => topup.mutate()}>
          {topup.isPending ? "充值中…" : "充值"}
        </button>
      </div>
    </div>
  );
}

function TenantsCard({ token, onError }: CardProps): ReactElement {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi.tenants(token) });
  useAuthedQueryGuard(list.error, onError);
  const refresh = (): void => {
    void list.refetch();
  };
  if (list.isError) {
    return (
      <section className="panel p-5">
        <p className="text-sm text-danger">租户列表加载失败：{errorText(list.error)}</p>
        <button type="button" className={`${BTN} mt-3`} onClick={refresh}>重试</button>
      </section>
    );
  }
  const tenants = list.data?.tenants ?? [];
  return (
    <section className="panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-ink-soft">租户列表</h2>
        <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} onClick={refresh}>
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>
      {tenants.length === 0 ? (
        <p className="py-3 text-xs text-ink-faint">（还没有租户，用下面的「开通租户」建一个）</p>
      ) : (
        <ul className="divide-y divide-line">
          {tenants.map((t) => (
            <li key={t.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="font-medium text-sm text-ink">{t.name}</span>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1 text-xs text-ink-soft">
                  <span className={`h-1.5 w-1.5 rounded-full ${t.status === "active" ? "bg-free" : "bg-danger"}`} />
                  {t.status === "active" ? "正常" : t.status}
                </span>
                <span className="text-xs text-ink-soft">
                  余额 <span className="font-mono tabular-nums text-ink">{t.balanceUsd}</span> USD
                </span>
                <span className="text-xs text-ink-soft">
                  key <span className="font-mono text-ink">{t.keyPrefixes[0] ?? "—"}</span>
                </span>
                <span className="text-xs text-ink-faint">{formatDateTime(t.createdAt)}</span>
                <button
                  type="button"
                  className={`${BTN} ml-auto`}
                  onClick={() => setOpenId(openId === t.id ? null : t.id)}
                >
                  {openId === t.id ? "收起" : "授权 / 充值"}
                </button>
              </div>
              {openId === t.id && <TenantDetail token={token} id={t.id} onChanged={refresh} onError={onError} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PricesCard({ token, onError }: CardProps): ReactElement {
  const toast = useToast();
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const prices = useQuery({ queryKey: ["admin", "prices"], queryFn: () => adminApi.prices(token) });
  useAuthedQueryGuard(prices.error, onError);
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
    <section className="panel p-3">
      <h2 className="mb-2 text-xs font-medium text-ink-soft">价格表（USD / 百万 token）</h2>
      {rows.length === 0 ? (
        <p className="mb-2 text-xs text-ink-faint">（无价格记录：未定价的模型预扣按 0 计，先登记再放租户流量）</p>
      ) : (
        <ul className="mb-2 divide-y divide-line">
          {rows.map((p) => (
            <li key={p.model} className="flex flex-wrap items-center gap-x-4 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{p.model}</span>
              <span className="text-ink-soft">入 <span className="font-mono tabular-nums text-ink">{p.inputUsdPerMtok}</span></span>
              <span className="text-ink-soft">出 <span className="font-mono tabular-nums text-ink">{p.outputUsdPerMtok}</span></span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名" className="w-40" />
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="入价" className="w-24" />
        <Input value={output} onChange={(e) => setOutput(e.target.value)} placeholder="出价" className="w-24" />
        <button
          type="button"
          className={BTN}
          disabled={model.trim() === "" || input.trim() === "" || output.trim() === "" || upsert.isPending}
          onClick={() => upsert.mutate()}
        >
          {upsert.isPending ? "保存中…" : "设置 / 更新"}
        </button>
      </div>
    </section>
  );
}

function ReconcileCard({ token, onError }: CardProps): ReactElement {
  const rec = useQuery({ queryKey: ["admin", "reconcile"], queryFn: () => adminApi.reconcile(token) });
  useAuthedQueryGuard(rec.error, onError);
  const diffs = rec.data?.diffs ?? [];
  return (
    <section className="panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-ink-soft">对账（usage vs 账本）</h2>
        <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} onClick={() => void rec.refetch()}>
          <RefreshCw className="h-3 w-3" /> 核对
        </button>
      </div>
      {rec.isError ? (
        <p className="text-xs text-danger">核对失败：{errorText(rec.error)}</p>
      ) : rec.isPending ? (
        <p className="text-xs text-ink-faint">核对中…</p>
      ) : diffs.length === 0 ? (
        <p className="text-xs text-ink-soft">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-free align-middle" />
          无差异：每个租户 usage_events 汇总与 quota_ledger 实扣一致
        </p>
      ) : (
        <ul className="space-y-1.5">
          {diffs.map((d) => (
            <li key={d.tenantId} className="rounded-lg border border-line bg-overlay/50 px-3 py-2 text-xs">
              <span className="font-mono text-danger">{d.tenantId.slice(0, 8)}</span>
              {" "}usage <span className="font-mono tabular-nums text-ink">{d.usageSum}</span>
              {" "}vs 账本 <span className="font-mono tabular-nums text-ink">{d.ledgerSum}</span>
              {" "}差 <span className="font-mono tabular-nums text-danger">{d.diff}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditCard({ token, onError }: CardProps): ReactElement {
  const audit = useQuery({ queryKey: ["admin", "audit"], queryFn: () => adminApi.audit(token, 30) });
  useAuthedQueryGuard(audit.error, onError);
  const entries = audit.data?.entries ?? [];
  return (
    <section className="panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-ink-soft">审计流水（最近 30 条）</h2>
        <button type="button" className={`${BTN} inline-flex items-center gap-1.5`} onClick={() => void audit.refetch()}>
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>
      {audit.isError ? (
        <p className="text-xs text-danger">审计加载失败：{errorText(audit.error)}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-ink-faint">（还没有管理动作）</p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5 text-xs">
              <span className="text-ink-faint">{formatDateTime(e.at)}</span>
              <span className="font-mono text-ink">{e.action}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">
                {JSON.stringify(e.detail)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Tenants(): ReactElement {
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const [token, setToken] = useState(() => loadAdminToken());
  const toast = useToast();
  const onError = makeAdminErrorHandler(setToken, toast);
  // 本机形态（tenant_mode=false）没有管理面：直接弹回仪表盘，不留死页面
  if (state.data !== undefined && state.data.tenant_mode !== true) {
    return <Navigate to="/" replace />;
  }
  if (token === "") {
    return (
      <div className="space-y-5 pb-10">
        <PageHeader title="租户管理" description="服务形态管理面：开通、授权、充值、价格、对账、审计" />
        <TokenGate onToken={setToken} />
      </div>
    );
  }
  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="租户管理"
        description="所有操作经 /admin/* 落库并记审计；令牌修改请重启网关（MODELMUX_ADMIN_TOKEN）"
        actions={
          <button
            type="button"
            className={`${BTN} inline-flex items-center gap-1.5`}
            onClick={() => {
              clearAdminToken();
              setToken("");
            }}
          >
            <KeyRound className="h-3 w-3" /> 退出管理面
          </button>
        }
      />
      <TenantsCard token={token} onError={onError} />
      <CreateCard token={token} onError={onError} />
      <PricesCard token={token} onError={onError} />
      <ReconcileCard token={token} onError={onError} />
      <AuditCard token={token} onError={onError} />
    </div>
  );
}
