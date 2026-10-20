/**
 * 账号池页：各渠道凭据、账号列表与额度，支持添加账号（登录弹窗）与账号切换。
 */

import { type ReactElement, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { AccountCard, type AccountPool, type ChannelBilling } from "../components/AccountCard";
import { LoginModal } from "../components/LoginModal";
import { PageHeader } from "../components/PageHeader";
import { Alert, Skeleton } from "./Dashboard";

interface StatusRow {
  cid: string;
  present?: boolean;
  /** 渠道展示名（后端 status 载荷带 `display`）。 */
  display?: string;
}

interface BillingRow {
  model: string;
  candidates: Array<{
    cid: string;
    display?: string;
    used?: number;
    unit?: string;
    cooling?: boolean;
    unsupported?: boolean;
    ok?: number;
    fail?: number;
    accounts?: Array<{
      key: string;
      ok: number;
      fail: number;
      credits?: {
        remain: number;
        size: number;
        used: number;
        unit: string;
        remain_percent: number;
      } | null;
      billing_at?: string | null;
      billing_ok?: boolean;
    }>;
  }>;
}

/**
 * 账号池页（渠道管理中枢）。
 *
 * 添加账号走**模态弹窗**（步骤化引导，仅关闭键可关）；账本按「渠道 × 账号」展示；
 * 授权链接 / 登录状态只出现在弹窗里，不再泄漏到其他页面。
 */
export function Accounts(): ReactElement {
  const qc = useQueryClient();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 弹窗目标渠道；null = 关闭。 */
  const [loginChannel, setLoginChannel] = useState<string | null>(null);
  /** 本轮弹窗是否观察到过「非 done」状态：用于排除上一次登录残留的 done。 */
  const sawProgressRef = useRef(false);
  /** 本轮弹窗的成功是否已处理，避免重复刷新。 */
  const handledSuccessRef = useRef(false);

  const pools = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = (await api.commands.accounts()) as { channels?: AccountPool[] };
      return res.channels ?? [];
    },
    refetchInterval: 15_000,
  });
  const logins = useQuery({
    queryKey: ["logins"],
    queryFn: async () => {
      const res = (await api.commands.status()) as { channels?: StatusRow[] };
      return res.channels ?? [];
    },
    refetchInterval: 10_000,
  });
  const billing = useQuery({
    queryKey: ["billing"],
    queryFn: async () => {
      const res = (await api.commands.billing()) as { rows?: BillingRow[] };
      return res.rows ?? [];
    },
    refetchInterval: 60_000,
  });
  // 弹窗轮询：登录进度 / 二维码 / 授权链接都从这里来（弹窗关闭即停）
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
    enabled: loginChannel !== null,
  });

  const invalidateAll = (): void => {
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["logins"] });
    void qc.invalidateQueries({ queryKey: ["state"] });
    void qc.invalidateQueries({ queryKey: ["billing"] });
  };

  const startLogin = useMutation({
    // 添加账号 = 强制新授权（已有凭据/被标记 error 时也要拿到新的授权链接）
    mutationFn: async (cid: string) => await api.commands.login(cid, true),
    onError: (err) => setError(String(err)),
  });
  const activate = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`activate:${key}`);
      return await api.commands.activateAccount(cid, key);
    },
    onSuccess: () => {
      setError("");
      invalidateAll();
    },
    onError: (err) => setError(String(err)),
    onSettled: () => setBusyKey(null),
  });
  const remove = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`remove:${key}`);
      return await api.commands.removeAccount(cid, key);
    },
    onSuccess: () => {
      setError("");
      invalidateAll();
    },
    onError: (err) => setError(String(err)),
    onSettled: () => setBusyKey(null),
  });
  const submitCallback = useMutation({
    mutationFn: async (url: string) => await api.commands.pasteCallback(url),
    onSuccess: (res) => {
      setNotice(res.ok ? (res.message ?? "已提交回调链接") : (res.error ?? "提交失败"));
      if (res.ok) invalidateAll();
    },
    onError: (err) => setError(String(err)),
  });

  // 登录成功即收尾：自动关闭弹窗并立刻刷新账号池 / 额度，不等下一轮轮询
  useEffect(() => {
    if (loginChannel === null) {
      sawProgressRef.current = false;
      handledSuccessRef.current = false;
      return;
    }
    const uiState = state.data?.ui_state;
    if (!uiState) return;
    // done 之前必须先见到别的状态 —— 否则那是上一次登录留下的结果
    if (uiState !== "done") {
      sawProgressRef.current = true;
      return;
    }
    if (!sawProgressRef.current || handledSuccessRef.current) return;
    handledSuccessRef.current = true;
    setLoginChannel(null);
    setError("");
    setNotice("登录成功，账号已入池。");
    invalidateAll();
  }, [loginChannel, state.data?.ui_state]);

  // 合并三路数据：账号池 + 登录状态 + 渠道账本（都按 cid 对齐）
  const statusMap = new Map((logins.data ?? []).map((r) => [r.cid, Boolean(r.present)]));
  const billingMap = new Map<string, ChannelBilling>();
  for (const row of billing.data ?? []) {
    for (const c of row.candidates) {
      const prev = billingMap.get(c.cid);
      if (prev) {
        prev.models += 1;
        continue;
      }
      billingMap.set(c.cid, {
        used: c.used ?? 0,
        unit: c.unit ?? "",
        cooling: Boolean(c.cooling),
        ok: c.ok ?? 0,
        fail: c.fail ?? 0,
        models: 1,
        unsupported: Boolean(c.unsupported),
        accounts: c.accounts ?? [],
        billing_at: null,
      });
    }
  }
  const list = (pools.data ?? []).map((pool) => ({
    pool,
    present: statusMap.get(pool.cid) ?? false,
    billing: billingMap.get(pool.cid),
  }));

  const loginChannels = logins.data ?? [];
  const snapshot = state.data;

  return (
    <div className="space-y-5">
      <PageHeader title="账号池" description="各渠道的凭据、账号池与额度" />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="info">{notice}</Alert>}

      {list.length === 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-sm text-gray-500">
          {pools.isLoading ? <Skeleton /> : "（无渠道账号池；先在上面添加账号）"}
        </div>
      )}
      {/*
        渠道卡用 **多栏（masonry）** 排布，不用网格：
        网格的行高取最高那张卡，账号数少的渠道会被拉出整片空白（账号数 1 vs 3 时最明显）。
        卡片本身自包含，列序阅读可接受。
      */}
      <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
        {list.map(({ pool, present, billing: bill }) => (
          <div key={pool.cid} className="mb-3 break-inside-avoid">
            <AccountCard
              pool={pool}
              present={present}
              billing={bill}
              onActivate={(cid, key) => activate.mutate({ cid, key })}
              onRemove={(cid, key) => remove.mutate({ cid, key })}
              onAdd={(cid) => setLoginChannel(cid)}
            busyKey={busyKey}
            />
          </div>
        ))}
      </div>

      {/* 登录弹窗（仅右上角关闭键可关） */}
      {loginChannel !== null && (
        <LoginModal
          cid={loginChannel}
          display={loginChannels.find((c) => c.cid === loginChannel)?.display}
          snapshot={
            snapshot && {
              ui_state: snapshot.ui_state,
              message: snapshot.message,
              auth_url: snapshot.auth_url,
              qr_url: snapshot.qr_url,
            }
          }
          submitting={submitCallback.isPending}
          onStartLogin={(cid) => {
            setNotice("");
            startLogin.mutate(cid);
          }}
          onSubmitCallback={(url) => submitCallback.mutate(url)}
          onClose={() => {
            // 手动关闭也同步一次：用户可能在成功提示出现前就关掉弹窗
            setLoginChannel(null);
            invalidateAll();
          }}
        />
      )}
    </div>
  );
}
