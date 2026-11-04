import { useCallback, useEffect, useState } from "react";
import { command, tool } from "../api";
import type { AccountsData, BillingData, ChannelPool, StatusData } from "../types";

const HEALTH_LABEL: Record<string, string> = { ok: "正常", cooldown: "冷却中", error: "错误", unauthenticated: "未登录" };

export function Accounts() {
  const [pools, setPools] = useState<ChannelPool[]>([]);
  const [credits, setCredits] = useState<Map<string, { remain: number; size: number; used: number }>>(new Map());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [auth, setAuth] = useState<{ cid: string; url: string; qr: string; input: string } | null>(null);
  const [confirm, setConfirm] = useState<{ cid: string; key: string; name: string } | null>(null);
  const [inputValue, setInputValue] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await command("accounts");
      if (!r.ok) throw new Error(r.error ?? "accounts 失败");
      setPools((r.data as AccountsData).channels);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 额度按需拉取(不轮询):billing 行内带每个账号的 credits
  const loadCredits = async () => {
    setBusy("额度刷新中…");
    try {
      const map = new Map<string, { remain: number; size: number; used: number }>();
      await Promise.all(
        pools.map(async (ch) => {
          const b = await command("billing", ch.cid);
          if (!b.ok) return;
          for (const row of (b.data as BillingData).rows)
            for (const cand of row.candidates)
              for (const a of cand.accounts)
                if (a.credits && !map.has(a.key))
                  map.set(a.key, { remain: a.credits.remain, size: a.credits.size, used: a.credits.used });
        }),
      );
      setCredits(map);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  };

  const act = async (action: string, cid: string, args: Record<string, unknown> = {}) => {
    setBusy("执行中…");
    setErr("");
    try {
      const r = await command(action, cid, args);
      if (!r.ok) {
        setErr(r.error ?? `${action} 失败`);
        return;
      }
      if (action === "removeAccount") setConfirm(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  };

  // 登录:触发后轮询状态拿授权链接 / 二维码 / 两步输入(完成态在 /web/api/state,不自动打开浏览器)
  const login = async (cid: string) => {
    setBusy(`登录 ${cid} 中…`);
    setErr("");
    try {
      const r = await command("login", cid);
      if (!r.ok) throw new Error(r.error ?? "login 失败");
      for (let i = 0; i < 30; i += 1) {
        await new Promise((res) => setTimeout(res, 2000));
        const s = await tool<StatusData>("mx_status");
        const a = s.auth;
        if (a && (a.auth_url || a.qr_url || a.login_input)) {
          setAuth({
            cid,
            url: a.auth_url ?? "",
            qr: a.qr_url ?? "",
            input: a.login_input == null ? "" : typeof a.login_input === "string" ? a.login_input : JSON.stringify(a.login_input),
          });
          break;
        }
      }
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用(权限/非安全上下文):链接已渲染在页面上,手动复制
    }
  };

  return (
    <div>
      <div className="section-bar">
        <button onClick={loadCredits} disabled={!!busy}>
          {busy || "刷新额度"}
        </button>
        <button onClick={load} disabled={!!busy}>
          刷新账号
        </button>
        {err && <span className="err"> {err}</span>}
      </div>

      {auth && (
        <div className="auth-card">
          <h3>{auth.cid} 登录</h3>
          {auth.url && (
            <p>
              授权链接（复制到浏览器打开）：
              <input readOnly value={auth.url} onFocus={(e) => e.target.select()} />
              <button onClick={() => copy(auth.url)}>复制</button>
            </p>
          )}
          {auth.qr && (
            <p>
              二维码：
              <img src={auth.qr} alt="登录二维码" width={160} height={160} />
            </p>
          )}
          {auth.input && (
            <p>
              两步登录输入（{auth.input}）：
              <input value={inputValue} onChange={(e) => setInputValue(e.target.value)} placeholder="输入内容" />
              <button
                onClick={() => command("submitInput", auth.cid, { value: inputValue }).then((r) => !r.ok && setErr(r.error ?? "提交失败"))}
              >
                提交
              </button>
              <button onClick={() => command("cancelInput", auth.cid)}>取消</button>
            </p>
          )}
          <button onClick={() => setAuth(null)}>关闭</button>
        </div>
      )}

      {pools.map((ch) => (
        <section key={ch.cid}>
          <h3>
            {ch.display} <span className="dim">({ch.cid})</span>
            <button className="mini" onClick={() => login(ch.cid)} disabled={!!busy}>
              登录
            </button>
          </h3>
          {ch.index.accounts.length === 0 && <p className="dim">池内无账号</p>}
          {ch.index.accounts.map((a) => {
            const active = ch.index.active === a.key;
            const credit = credits.get(a.key);
            return (
              <div className={`acct ${active ? "active" : ""}`} key={a.key}>
                <div className="acct-head">
                  <span className="name">{a.name || a.label}</span>
                  {active && <span className="chip ok">生效</span>}
                  <span className={`chip ${a.health}`}>{HEALTH_LABEL[a.health] ?? a.health}</span>
                  {a.fail_streak > 0 && <span className="dim">连败 {a.fail_streak}</span>}
                  {a.cooldown_until && <span className="dim">冷却到 {new Date(a.cooldown_until).toLocaleString("zh-CN")}</span>}
                </div>
                <div className="acct-body">
                  <span className="dim">key {a.key.slice(0, 8)}…</span>
                  {credit && (
                    <span>
                      额度 {credit.remain}/{credit.size}（已用 {credit.used}）
                    </span>
                  )}
                  <span className="spacer" />
                  {!active && (
                    <button className="mini" onClick={() => act("activateAccount", ch.cid, { key: a.key })} disabled={!!busy}>
                      切换生效
                    </button>
                  )}
                  {a.health !== "ok" && (
                    <button className="mini" onClick={() => act("resetAccount", ch.cid, { key: a.key })} disabled={!!busy}>
                      解除
                    </button>
                  )}
                  {confirm?.key === a.key ? (
                    <span>
                      <button className="mini danger" onClick={() => act("removeAccount", ch.cid, { key: a.key })} disabled={!!busy}>
                        确认删除
                      </button>
                      <button className="mini" onClick={() => setConfirm(null)}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <button className="mini danger" onClick={() => setConfirm({ cid: ch.cid, key: a.key, name: a.name })} disabled={!!busy}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
