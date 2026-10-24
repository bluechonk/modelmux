/**
 * 账号池页：各渠道凭据、账号列表与额度，支持添加账号（登录弹窗）与账号切换。
 */

import { type ReactElement, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  AccountCard,
  classifyChannel,
  type AccountPool,
  type ChannelBilling,
  type ChannelStatus,
} from "../components/AccountCard";
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
      /** 额度基线（当前窗口内第一次账单的 remain），百分比分母。 */
      baseline?: { window?: string; date: string; remain: number; at?: string } | null;
    }>;
  }>;
}

/** 总览条各状态的展示口径（与卡片 `STATUS_META` 同色，这里只做计数）。 */
const SUMMARY_ORDER: Array<{ key: ChannelStatus; label: string; dot: string }> = [
  { key: "ok", label: "正常", dot: "bg-free" },
  { key: "cooldown", label: "冷却", dot: "bg-warn" },
  { key: "down", label: "异常", dot: "bg-danger" },
  { key: "offline", label: "未登录", dot: "bg-ink-faint" },
  { key: "empty", label: "空池", dot: "bg-ink-faint" },
];

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

  // 总览计数：与卡片用同一个 classifyChannel，口径不会两边漂移
  const counts: Record<ChannelStatus, number> = {
    ok: 0,
    cooldown: 0,
    down: 0,
    offline: 0,
    empty: 0,
  };
  let totalAccounts = 0;
  for (const { pool, present } of list) {
    counts[classifyChannel(pool, present)] += 1;
    totalAccounts += pool.index.accounts.length;
  }

  const loginChannels = logins.data ?? [];
  const snapshot = state.data;

  return (
    <div className="space-y-5">
      <PageHeader title="账号池" description="各渠道的凭据、账号池与额度" />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="info">{notice}</Alert>}

      {list.length === 0 ? (
        <div className="rounded-xl border border-line p-5 text-sm text-ink-faint">
          {pools.isLoading ? <Skeleton /> : "（无渠道账号池；先添加账号）"}
        </div>
      ) : (
        <>
          {/* 总览条：一眼看清正常 / 冷却 / 异常 / 未登录各几个，不用逐张翻卡 */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1">
            <span className="text-xs text-ink-faint">
              共 <span className="font-mono font-medium text-ink">{list.length}</span> 渠道 ·{" "}
              <span className="font-mono font-medium text-ink">{totalAccounts}</span> 账号
            </span>
            <span className="h-3 w-px bg-line" aria-hidden />
            {SUMMARY_ORDER.map(({ key, label, dot }) => (
              <span key={key} className="flex items-center gap-1.5 text-xs text-ink-soft">
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                {label}
                <span className="font-mono tabular-nums text-ink">{counts[key]}</span>
              </span>
            ))}
          </div>

          {/*
            渠道卡用**对齐网格**（items-start）：卡顶成行对齐，短卡不在单元格内被拉伸，
            不再出现 masonry 那种列底大片参差留白。

            最多两列：三列时单卡仅 ~380px，中文账号名与额度条会互相挤压
            （实测「塞西莉亚4412」被截断）。
          */}
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {list.map(({ pool, present, billing: bill }) => (
              <AccountCard
                key={pool.cid}
                pool={pool}
                present={present}
                billing={bill}
                onActivate={(cid, key) => activate.mutate({ cid, key })}
                onRemove={(cid, key) => remove.mutate({ cid, key })}
                onAdd={(cid) => setLoginChannel(cid)}
                busyKey={busyKey}
              />
            ))}
          </div>
        </>
      )}

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
