import { useEffect, useState } from "react";
import { tool } from "../api";
import type { LogEntry, LogsData } from "../types";

const fmtNum = (n: number | null | undefined) => (n == null ? "-" : Number(n).toLocaleString("zh-CN"));
const fmtMs = (ms: number | null | undefined) => (ms == null ? "-" : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : `${ms}ms`);

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = () =>
      tool<LogsData>("mx_logs", { limit: 20 })
        .then((d) => {
          setEntries(d.entries);
          setTotal(d.total);
        })
        .catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (err && entries.length === 0) return <p className="err">加载失败：{err}</p>;
  return (
    <div>
      <h2>
        最近请求 <span className="dim">(共 {fmtNum(total)} 条，显示最近 {entries.length})</span>
      </h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>渠道</th>
              <th>模型</th>
              <th>结果</th>
              <th className="num">耗时</th>
              <th className="num">token</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.ts + e.model + e.durationMs}>
                <td className="dim">{e.ts ? new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false }) : "-"}</td>
                <td>{e.cid}</td>
                <td>{e.model}</td>
                <td className={e.outcome === "success" ? "ok" : "bad"}>
                  {e.outcome}
                  {e.slow ? <span className="dim"> (慢)</span> : null}
                </td>
                <td className="num">{fmtMs(e.durationMs)}</td>
                <td className="num">{fmtNum(e.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
