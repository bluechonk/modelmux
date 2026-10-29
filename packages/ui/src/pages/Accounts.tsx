/**
 * 账号池页：各渠道凭据、账号列表与额度，支持添加账号（登录弹窗）与账号切换。
 */

import { type ReactElement, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { api } from "../lib/api";
import {
  AccountCard,
  classifyAccount,
  type AccountPool,
  type ChannelBilling,
  type AccountStatus,
} from "../components/AccountCard";
import { LoginModal } from "../components/LoginModal";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { Skeleton } from "./Dashboard";

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

/** 总览条各状态的展示口径（与卡片 `STATUS_META` 同色，这里只做账号计数）。 */
const SUMMARY_ORDER: Array<{ key: AccountStatus; label: string; dot: string }> = [
  { key: "ok", label: "正常", dot: "bg-free" },
  { key: "cooldown", label: "冷却", dot: "bg-warn" },
  { key: "down", label: "异常", dot: "bg-danger" },
  { key: "broke", label: "没钱", dot: "bg-danger" },
];

/**
 * 账号池页（渠道管理中枢）。
 *
 * 添加账号走**模态弹窗**（步骤化引导，仅关闭键可关）；账本按「渠道 × 账号」展示；
 * 授权链接 / 登录状态只出现在弹窗里，不再泄漏到其他页面。
 */
export function Accounts(): ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);
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
      // 服务端失败时 envelope.ok=false（HTTP 400）。不抛错的话前端会把它当成
      // 「查到了 0 行」→ 卡片显示「未查到」，把「请求失败」伪装成「没有数据」。
      const res = (await api.commands.billing()) as {
        ok?: boolean;
        rows?: BillingRow[];
        error?: string;
      };
      if (res.ok === false) throw new Error(res.error ?? "账单加载失败");
      return res.rows ?? [];
    },
    refetchInterval: 60_000,
  });
  /**
   * 账单的加载 / 失败态：卡片据此渲染**骨架**而不是「未查到」。
   *
   * 为什么需要显式区分：React Query 在没有数据时 `data` 是 undefined，
   * 卡片若按「没有额度」渲染，就会把「还在等 / 请求失败」显示成「未查到」，
   * 用户看到的是稳定的「没数据」而不是「正在加载」。
   */
  const billingLoading = billing.isPending;
  const billingError = billing.isError;
  /** 全局时钟：新鲜度文案要随时间走（否则数据不变时秒数永远停在第一次渲染）。 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
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
    onError: (err) => toast.error(String(err)),
    // 立刻拉一次 state：后端的 triggerLogin 已同步清空旧状态，早拉早让弹窗
    // 看到干净的「准备中」，而不是等下一个 3 秒轮询周期。
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const activate = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`activate:${key}`);
      return await api.commands.activateAccount(cid, key);
    },
    onSuccess: () => invalidateAll(),
    onError: (err) => toast.error(String(err)),
    onSettled: () => setBusyKey(null),
  });
  const remove = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`remove:${key}`);
      return await api.commands.removeAccount(cid, key);
    },
    onSuccess: () => invalidateAll(),
    onError: (err) => toast.error(String(err)),
    onSettled: () => setBusyKey(null),
  });
  /**
   * 两步登录的输入（如 loomy 的短信验证码）。
   *
   * 后端把待回答的请求放在 `state.login_input` 里，弹窗只渲染一张输入卡；
   * 这里把用户填的内容交回去。
   */
  const submitInput = useMutation({
    mutationFn: async (value: string) => await api.commands.submitInput(value),
    onError: (err) => toast.error(String(err)),
  });
  /** 弹窗关闭：让后端别再等输入（否则渠道挂到超时）。 */
  const cancelInput = (): void => {
    void api.commands.cancelInput().catch(() => {});
  };

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
    toast.success("登录成功，账号已入池。");
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

  // 总览计数按**账号**（与账号行同一个 classifyAccount，口径不会两边漂移）；
  // cid 不做状态 —— 同一渠道池里的账号状态可能各不相同。
  const counts: Record<AccountStatus, number> = {
    ok: 0,
    cooldown: 0,
    down: 0,
    broke: 0,
  };
  let totalAccounts = 0;
  for (const { pool, billing } of list) {
    for (const raw of pool.index.accounts) {
      counts[classifyAccount(raw, billing)] += 1;
      totalAccounts += 1;
    }
  }

  const loginChannels = logins.data ?? [];
  const snapshot = state.data;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="账号池"
        description="各渠道的凭据、账号池与额度"
        actions={
          <button
            type="button"
            onClick={() => {
              // 四路查询一起失效：卡片 / 登录态 / 额度 / 弹窗快照本来就是同一批事实
              void qc.invalidateQueries({ queryKey: ["accounts"] });
              void qc.invalidateQueries({ queryKey: ["logins"] });
              void qc.invalidateQueries({ queryKey: ["billing"] });
              void qc.invalidateQueries({ queryKey: ["state"] });
            }}
            className="tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <RotateCw className="h-3.5 w-3.5" />
            刷新
          </button>
        }
      />

      {list.length === 0 ? (
        <div className="rounded-xl border border-line p-5 text-sm text-ink-faint">
          {pools.isLoading ? <Skeleton /> : "（无渠道账号池；先添加账号）"}
        </div>
      ) : (
        <>
          {/* 总览条：一眼看清正常 / 冷却 / 异常 / 没钱了几个，不用逐张翻卡。
              每个统计都是一个 chip（中性底 + 圆角 + `whitespace-nowrap`）——
              纯文字加竖线分隔在窄屏折行后像是「错位的两行」，chip 换行时逐行对齐，
              且标签与数字永远在同一个视觉单元里。 */}
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1 text-xs text-ink-soft">
              共 <span className="font-mono font-medium text-ink">{list.length}</span> 渠道 ·{" "}
              <span className="font-mono font-medium text-ink">{totalAccounts}</span> 账号
            </span>
            {SUMMARY_ORDER.map(({ key, label, dot }) => (
              <span
                key={key}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-overlay/50 px-2.5 py-1 text-xs text-ink-soft"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                {label}
                <span className="font-mono tabular-nums text-ink">{counts[key]}</span>
              </span>
            ))}
          </div>

          {/*
            渠道卡网格：**各卡按自身内容取高**（`items-start`，不再同行拉伸）。

            不等高的理由：账号数差异大时（1 个 vs 5 个），
            同行拉伸会让只有 1 个账号的卡被撑到与 5 个账号一样高，卡内出现大片空白，
            整页看起来「布局坏了」。改为自然高度后，每张卡都是紧凑的，代价是行尾参差
            —— 对「账号数本来就不齐」的列表，这个代价明显更小。

            自适应列数：卡片最小宽 340px，空间够就自然多列，不写死断点。
            `min(340px, 100%)` 是必要的收口：视口比 340px + 内边距还窄时（实测 360 视口），
            写死 340px 的轨道会把 `main` 顶出 6px 横向滚动。
          */}
          <div className="grid items-start gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(340px, 100%), 1fr))" }}>
            {list.map(({ pool, billing: bill }) => (
              <AccountCard
                key={pool.cid}
                pool={pool}
                billing={bill}
                billingLoading={billingLoading}
                billingError={billingError}
                now={now}
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
              login_input: snapshot.login_input ?? null,
            }
          }
          submitting={submitInput.isPending}
          onStartLogin={(cid) => {
            startLogin.mutate(cid);
          }}
          onSubmitInput={(value) => submitInput.mutate(value)}
          onCancelInput={cancelInput}
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
