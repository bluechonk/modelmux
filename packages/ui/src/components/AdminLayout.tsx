/**
 * 管理面外壳（`/web/admin/*`）：独立于用户 console 的布局与身份。
 *
 * 为什么不共用 `LayoutSingle`：`/web` 全部是「我自己用这个网关」（我的用量/我的凭据/
 * 我的日志、本机即信任），管理面是「别人在用我的网关」（平台运营、Bearer 令牌）。
 * 两类主体塞进同一导航会语义断裂，且令牌态（进入/退出/401 回流）无处安放。
 *
 * 令牌只存 sessionStorage；未持令牌时只渲染输入卡，管理命题/子路由不出内容。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement } from "react";
import { NavLink, Navigate, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";

import { AdminAuthError, adminApi, api, clearAdminToken, loadAdminToken, saveAdminToken } from "../lib/api";
import { Input } from "./ui/input";
import { useToast } from "./Toast";
import { errorText } from "../lib/log-format";

const BTN = "tap rounded-lg border border-line-strong bg-overlay px-3 py-1.5 text-xs text-ink transition-colors hover:border-brand/50 disabled:opacity-50";

const ADMIN_NAV = [
  { to: "/admin", label: "租户", end: true },
  { to: "/admin/prices", label: "价格", end: false },
  { to: "/admin/reconcile", label: "对账", end: false },
  { to: "/admin/audit", label: "审计", end: false },
];

interface AdminTokenApi {
  token: string;
  /** 统一 401 处理：清令牌回输入态（子页面 mutation 的 onError 直接传它）。 */
  onError: (err: unknown) => void;
}

const TokenContext = createContext<AdminTokenApi | null>(null);

/** 子页面取令牌与统一错误处理；只能在 AdminLayout 内使用。 */
export function useAdminToken(): AdminTokenApi {
  const ctx = useContext(TokenContext);
  if (ctx === null) throw new Error("useAdminToken 必须在 AdminLayout 内使用");
  return ctx;
}

/** 令牌输入卡：验证失败常驻红字（不是一次性动作，不能靠 toast 闪一下）。 */
function TokenGate({ onToken }: { onToken: (t: string) => void }): ReactElement {
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const submit = async (): Promise<void> => {
    const token = draft.trim();
    if (token === "") return;
    setChecking(true);
    setError("");
    try {
      await adminApi.tenants(token);
      saveAdminToken(token);
      onToken(token);
    } catch (err) {
      setError(err instanceof AdminAuthError ? "管理令牌无效" : errorText(err));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="mx-auto flex h-full max-w-md flex-col justify-center px-4 pb-16">
      <section className="panel p-6">
        <div className="mb-1.5 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-ink-soft" aria-hidden="true" />
          <h1 className="text-sm font-medium text-ink">管理面</h1>
        </div>
        <p className="mb-4 text-xs text-ink-faint">
          需要服务启动时注入的管理令牌（<span className="font-mono">MODELMUX_ADMIN_TOKEN</span>）。
          令牌只保存在本标签页会话里。
        </p>
        <Input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="管理令牌"
          className="w-full"
          autoFocus
        />
        {error !== "" && <p className="mt-2 text-xs text-danger">{error}</p>}
        <button
          type="button"
          className={`${BTN} mt-3 w-full`}
          onClick={() => void submit()}
          disabled={checking || draft.trim() === ""}
        >
          {checking ? "验证中…" : "进入管理面"}
        </button>
      </section>
    </div>
  );
}

export function AdminLayout(): ReactElement {
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const [token, setToken] = useState(() => loadAdminToken());
  const toast = useToast();

  /**
   * 统一错误回流。**必须是稳定引用**：子页面以它作 effect 依赖
   * （useAdminQueryError），每次 render 新建会让 effect 反复触发 → 循环清令牌。
   * 401 分支幂等：令牌已清空时直接返回，避免重复 setToken 与重复 toast。
   */
  const onError = useCallback(
    (err: unknown): void => {
      if (err instanceof AdminAuthError) {
        clearAdminToken();
        setToken((prev) => {
          if (prev === "") return prev; // 已登出：不重复 toast
          toast.error("管理令牌已失效，请重新输入");
          return "";
        });
        return;
      }
      toast.error(errorText(err));
    },
    [toast],
  );

  useEffect(() => {
    document.title = "modelmux 管理面";
  }, []);

  const tokenValue = useMemo<AdminTokenApi>(() => ({ token, onError }), [token, onError]);

  // 本机形态没有管理面：直接回用户 console（不留死页面）
  if (state.data !== undefined && state.data.tenant_mode !== true) {
    return <Navigate to="/" replace />;
  }
  if (token === "") {
    return <TokenGate onToken={setToken} />;
  }

  return (
    <TokenContext.Provider value={tokenValue}>
      <div className="flex h-full flex-col bg-canvas">
        <header className="drag-region flex h-14 flex-none items-center gap-2 border-b border-line bg-surface px-4">
          <span
            className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-overlay text-ink-soft"
            aria-hidden="true"
          >
            <ShieldCheck className="h-4 w-4" />
          </span>
          <span className="hidden text-[15px] font-medium tracking-tight text-ink min-[420px]:inline">管理面</span>
          <nav className="no-drag ml-2 flex flex-none items-center gap-1 overflow-x-auto" aria-label="管理面导航">
            {ADMIN_NAV.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `no-drag nav-item tap-square flex flex-none items-center whitespace-nowrap px-3 text-[13px] ${
                    isActive ? "bg-sel text-sel-ink" : "text-ink-soft hover:bg-overlay/60 hover:text-ink"
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <NavLink
              to="/"
              aria-label="返回控制台"
              className="no-drag tap inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:bg-overlay hover:text-ink"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">返回控制台</span>
            </NavLink>
            <button
              type="button"
              aria-label="退出管理面"
              className={`${BTN} no-drag inline-flex items-center gap-1.5`}
              onClick={() => {
                clearAdminToken();
                setToken("");
              }}
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">退出管理面</span>
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6">
            <Outlet />
          </div>
        </main>
      </div>
    </TokenContext.Provider>
  );
}

/** 管理面页头（标题 + 说明 + 右侧动作），与用户 console 的 PageHeader 同构但独立主题。 */
export function AdminHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactElement | null;
}): ReactElement {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-normal tracking-tight text-ink">{title}</h1>
        {description !== undefined && <p className="mt-1 text-[13px] text-ink-faint">{description}</p>}
      </div>
      {actions !== undefined && actions !== null && (
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">{actions}</div>
      )}
    </header>
  );
}
