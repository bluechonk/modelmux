/**
 * 账号池页：各渠道凭据、账号列表与额度，支持添加账号（登录弹窗）与账号切换。
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  AccountCard,
  classifyAccount,
  type AccountPool,
  type ChannelBilling,
  type AccountStatus,
} from "../components/AccountCard";
import type { QuotaPeriod } from "../lib/account-status";
import { LoginModal } from "../components/LoginModal";
import { PageHeader } from "../components/PageHeader";
import { RefreshButton } from "../components/RefreshButton";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { columnCount, distributeByColumns } from "../lib/card-columns";
import { errorText } from "../lib/log-format";
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
    /** 额度周期（渠道声明）：`size` 是窗口发放量，判断基线是否错过窗口起点用。 */
    quota?: QuotaPeriod | null;
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
  { key: "down", label: "失败", dot: "bg-danger" },
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
    staleTime: 15_000,
    // 再进页面先出上一次的数据（轮询间隔内数据没变的话，等一轮没有意义）
    placeholderData: (prev) => prev,
  });
  const logins = useQuery({
    queryKey: ["logins"],
    queryFn: async () => {
      const res = (await api.commands.status()) as { channels?: StatusRow[] };
      return res.channels ?? [];
    },
    refetchInterval: 10_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
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
    staleTime: 60_000,
    placeholderData: (prev) => prev,
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
  /**
   * 账号维度用量（今日 tokens）：`usage?range=7d` 的 `accounts[]` 只含**今天**，
   * 与账号行的「今日消耗」同口径。60 秒一轮（日志逐日聚合，历史日有缓存）。
   */
  const usageQuery = useQuery({
    queryKey: ["usage", "7d"],
    queryFn: () => api.usage("7d"),
    refetchInterval: 60_000,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const tokensByKey = useMemo(
    () => new Map((usageQuery.data?.accounts ?? []).map((row) => [row.key, row.tokens])),
    [usageQuery.data],
  );
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
    onError: (err) => toast.error(errorText(err)),
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
    onError: (err) => toast.error(errorText(err)),
    onSettled: () => setBusyKey(null),
  });
  const remove = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`remove:${key}`);
      return await api.commands.removeAccount(cid, key);
    },
    onSuccess: () => invalidateAll(),
    onError: (err) => toast.error(errorText(err)),
    onSettled: () => setBusyKey(null),
  });
  /**
   * 模型级渠道偏好。
   *
   * 存的是用户意图（`<root>/model-prefs.json`），不是运行时状态 —— 改完立刻让
   * 账号池与额度一起失效：卡片上的排序与「优先走哪家」会在下一轮反映新偏好。
   */
  const setPref = useMutation({
    mutationFn: async ({ model, cid }: { model: string; cid: string }) =>
      await api.commands.setModelChannel(model, cid),
    onSuccess: () => {
      // 必须一并失效**快照**：账号池/额度各自有独立的轮询，而快照只在登录弹窗
      // 打开时才轮询（`enabled: loginChannel !== null`）—— 不失效的话用户选完
      // 下拉，按钮还停在旧值（实测：后端已写入 traecn，界面仍显示 raccoon）。
      void qc.invalidateQueries({ queryKey: ["state"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  /**
   * 两步登录的输入（如 loomy 的短信验证码）。
   *
   * 后端把待回答的请求放在 `state.login_input` 里，弹窗只渲染一张输入卡；
   * 这里把用户填的内容交回去。
   */
  const submitInput = useMutation({
    mutationFn: async (value: string) => await api.commands.submitInput(value),
    onError: (err) => toast.error(errorText(err)),
  });
  /** 弹窗关闭：让后端别再等输入（否则渠道挂到超时）。 */
  const cancelInput = (): void => {
    // 取消本身是「别再等了」的尽力而为：失败无补救动作（弹窗已关、用户不再关心），
    // 后端也会走到自己的超时收尾 —— 有意忽略。
    void api.commands.cancelInput().catch(() => {});
  };

  // 登录成功即收尾：自动关闭弹窗并立刻刷新账号池 / 额度，不等下一轮轮询
  useEffect(() => {
    if (loginChannel === null) {
      sawProgressRef.current = false;
      handledSuccessRef.current = false;
      return;
    }
    const snapshot = state.data;
    if (!snapshot) return;
    // 登录结果读 `login_result`（`ui_state` 只表示网关状态，已不承载 done/error）。
    // 回落分支兼容还没升级的后端。
    const result =
      snapshot.login_result ?? (snapshot.ui_state === "done" ? "done" : snapshot.ui_state === "error" ? "error" : "idle");
    // 先见到中间态（不是 done/error）才算「本轮真的在跑」—— 否则那是上一次登录留下的结果
    if (result !== "done") {
      sawProgressRef.current = true;
      return;
    }
    if (!sawProgressRef.current || handledSuccessRef.current) return;
    handledSuccessRef.current = true;
    setLoginChannel(null);
    toast.success("登录成功，账号已入池。");
    invalidateAll();
  }, [loginChannel, state.data?.login_result, state.data?.ui_state]);

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
        // 窗口发放量随行带下来：额度详情要用它判断基线是否错过了窗口起点
        quota: c.quota ?? null,
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
  /** 模型级渠道偏好（下拉的选项与选中项都来自快照，后端 5 秒一轮）。 */
  const modelPrefs = snapshot?.model_prefs ?? [];

  /**
   * 卡片列数（容器实测宽 → `columnCount`）；`ResizeObserver` 跟随窗口/侧栏变化。
   * 初值 1：首帧按 1 列渲染不会溢出，下一帧量到真实宽度就切到 N 列。
   */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columnTotal, setColumnTotal] = useState(1);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = (): void => {
      // `clientWidth` 已扣掉内边距与滚动条，正是可分配给列的内容宽
      setColumnTotal(columnCount(el.clientWidth));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [list.length]);
  /** 按列分发后的卡片（列内自上而下、列间从左到右）。 */
  const columns = distributeByColumns(list, columnTotal);

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="账号池"
        description="各渠道的凭据与额度"
        actions={
          <RefreshButton
            onRefresh={async () => {
              // 四路查询一起失效：卡片 / 登录态 / 额度 / 弹窗快照本来就是同一批事实。
              // Promise.all 是刻意的：忙态要持续到四路都回完，而不是点完立刻复位
              await Promise.all([
                qc.invalidateQueries({ queryKey: ["accounts"] }),
                qc.invalidateQueries({ queryKey: ["logins"] }),
                qc.invalidateQueries({ queryKey: ["billing"] }),
                qc.invalidateQueries({ queryKey: ["state"] }),
              ]);
            }}
          />
        }
      />

      {/*
        三态分开渲染：加载中 / **查询失败** / 确实没有账号池。
        此前只有「loading 或 空串」，于是命令失败（HTTP 400，`post()` 抛错）与
        「真的没有池」渲染成同一句「先添加账号」—— 良性空态把排查入口整个盖掉了
        （同文件的 `billing` 查询专门为这个理由加了 `isError` 守卫，这里漏了）。
      */}
      {pools.isError && list.length === 0 ? (
        <div className="rounded-xl border border-line p-5 text-sm">
          <p className="text-danger">账号池查询失败：{errorText(pools.error)}</p>
          <button
            type="button"
            onClick={() => void pools.refetch()}
            className="tap mt-3 rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50"
          >
            重试
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-line p-5 text-sm text-ink-faint">
          {pools.isLoading ? <Skeleton /> : "（无渠道账号池；先添加账号）"}
        </div>
      ) : (
        <>
          {/* 总览条：一眼看清正常 / 冷却 / 失败 / 没钱了几个，不用逐张翻卡。
              每个统计都是一个 chip（中性底 + 圆角 + `whitespace-nowrap`）——
              纯文字加竖线分隔在窄屏折行后像是「错位的两行」，chip 换行时逐行对齐，
              且标签与数字永远在同一个视觉单元里。 */}
          {/* 吸顶：账号多时向下滚动仍能看到计数与筛选结果（背景铺满容器宽，内容不透出） */}
          <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-1.5 bg-canvas px-4 py-2 sm:-mx-6 sm:px-6">
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
            模型级渠道偏好：每个对外模型指定「优先走哪家」。
            被偏好的渠道在选路里**置顶**，其余仍按剩余额度顺延 —— 被偏好的渠道
            冷却 / 额度耗尽时自然落到别家，不需要额外开关（口径见
            docs/POOL-ARCHITECTURE.md §2.4）。
          */}
          {modelPrefs.length > 0 && (
            <section className="rounded-xl border border-line bg-panel p-3">
              <h2 className="mb-2 text-xs font-medium text-ink-soft">模型走哪家</h2>
              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                {modelPrefs.map((pref) => (
                  // 列宽钉死而不是 flex-1 均分：均分时每列占到卡片宽的三分之一（实测 385px），
                  // 而下拉只需要容下最长的渠道名（workbuddyai ≈ 110px）。固定 176px 后
                  // 三列靠左排、窄屏自动折行，右侧留白交给卡片。
                  <div key={pref.model} className="flex w-44 flex-col gap-1">
                    <span className="text-center font-mono text-xs text-ink">{pref.model}</span>
                    {/* 触发器固定宽度（fixedWidth）后在列内**居中**，与上方模型名对齐；
                        nowrap 防窄屏下文字折行把高度顶高 */}
                    <div className="flex w-full justify-center [&_button]:whitespace-nowrap">
                      <Select
                        value={pref.preferred ?? ""}
                        onChange={(cid) => setPref.mutate({ model: pref.model, cid })}
                        label={`模型 ${pref.model} 优先渠道`}
                        fixedWidth
                        options={[
                          { value: "", label: "自动" },
                          ...pref.channels.map((cid) => ({ value: cid, label: cid })),
                        ]}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {modelPrefs.every((pref) => pref.channels.length === 0) && (
                <p className="mt-2 text-xs text-ink-faint">
                  池里暂无可路由的模型：先添加账号，或检查渠道是否已登录。
                </p>
              )}
            </section>
          )}

          {/*
          {/*
            渠道卡按**列**分发（瀑布流），不用 CSS Grid 的自动多列。

            为什么换：网格的行轨道高度 = 行内最高那张卡，一张卡展开就在同行另两张下方
            顶出一大片空白（实测展开 loomy 后该行 275px、另两张 140px，留 135px 白带）。
            `items-start` 只阻止卡片被拉伸，治不了行高。改成「算列数 → 轮询分发」后，
            每列是独立纵向流，任何一张卡长高只把**同一列**下面的卡往下推，没有白带。

            列数按容器实测宽算（`columnCount`，单卡最小 340px）：不写死断点，
            `< 340px + 内边距` 时收敛成 1 列（360 视口不会被顶出横向滚动）。
          */}
          <div ref={gridRef} className="flex items-start gap-3">
            {columns.map((column, columnIndex) => (
              <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-3">
                {column.map(({ pool, billing: bill }) => (
                  <AccountCard
                    key={pool.cid}
                    pool={pool}
                    billing={bill}
                    billingLoading={billingLoading}
                    billingError={billingError}
                    now={now}
                    tokensOf={(key) => {
                      // 数据还没到时返回 undefined（不渲染，避免把「没取到」显示成 0）；
                      // 取到之后没有记录 = 今天确实没消耗，如实显示 0
                      if (usageQuery.data === undefined) return undefined;
                      return tokensByKey.get(key) ?? 0;
                    }}
                    onActivate={(cid, key) => activate.mutate({ cid, key })}
                    onRemove={(cid, key) => remove.mutate({ cid, key })}
                    onAdd={(cid) => setLoginChannel(cid)}
                    busyKey={busyKey}
                  />
                ))}
              </div>
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
