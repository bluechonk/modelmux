import { useEffect, useState } from "react";
import { tool } from "../api";
import type { StatusData } from "../types";

const fmtNum = (n: number | null | undefined) => (n == null ? "-" : Number(n).toLocaleString("zh-CN"));
const fmtTokens = (n: number | null | undefined) =>
  n == null ? "-" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const fmtMs = (ms: number | null | undefined) => (ms == null ? "-" : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : `${ms}ms`);
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "-");

export function Overview() {
  const [data, setData] = useState<StatusData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = () => tool<StatusData>("mx_status").then(setData).catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (err && !data) return <p className="err">加载失败：{err}</p>;
  const u = data?.usage;
  const cards: Array<[string, string, string?]> = [
    ["今日请求", fmtNum(u?.requests)],
    ["成功率", u ? pct(u.success, u.requests) : "-"],
    ["token", u ? fmtTokens(u.tokens?.total) : "-"],
    ["缓存命中", u?.cache ? pct(u.cache.hit, u.cache.total) : "-"],
    ["平均耗时", u ? fmtMs(u.avg_duration_ms) : "-"],
    ["慢请求", fmtNum(u?.slow), u?.slow ? "bad" : ""],
  ];
  return (
    <div>
      {data?.gateway.error && <p className="err">网关错误：{data.gateway.error}</p>}
      <div className="cards">
        {cards.map(([k, v, cls]) => (
          <div className="card" key={k}>
            <div className="k">{k}</div>
            <div className={`v ${cls ?? ""}`}>{v}</div>
          </div>
        ))}
      </div>
      <h2>渠道健康</h2>
      <table>
        <thead>
          <tr>
            <th>渠道</th>
            <th className="num">模型</th>
            <th>状态分布</th>
            <th>登录</th>
            <th className="num">成功/失败</th>
          </tr>
        </thead>
        <tbody>
          {(data?.channels ?? []).map((c) => {
            const st = c.statuses ?? {};
            const dist = ["ok", "cooldown", "error", "unauthenticated"]
              .filter((k) => st[k])
              .map((k) => (
                <span className={`chip ${k}`} key={k}>
                  {k}={st[k]}
                </span>
              ))
              .join("") || <span className="dim">-</span>;
            const login =
              c.logged_in == null ? <span className="dim">-</span> : c.logged_in ? <span className="ok">已登录</span> : <span className="bad">未登录</span>;
            return (
              <tr key={c.cid}>
                <td>{c.display ?? c.cid}</td>
                <td className="num">{fmtNum(c.models)}</td>
                <td>{dist}</td>
                <td>{login}</td>
                <td className="num">
                  <span className="ok">{fmtNum(c.requests?.success)}</span> / <span className="bad">{fmtNum(c.requests?.failure)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
