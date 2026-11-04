import { useEffect, useState } from "react";
import { handshake } from "./api";
import { Accounts } from "./components/Accounts";
import { Logs } from "./components/Logs";
import { Models } from "./components/Models";
import { Overview } from "./components/Overview";

type Tab = "overview" | "accounts" | "models" | "logs";
const TABS: Array<[Tab, string]> = [
  ["overview", "概览"],
  ["accounts", "账号"],
  ["models", "模型"],
  ["logs", "日志"],
];

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [state, setState] = useState("正在与宿主握手…");
  const [cls, setCls] = useState("busy");

  useEffect(() => {
    handshake()
      .then(() => setState("已连接 · " + new Date().toLocaleTimeString("zh-CN", { hour12: false })))
      .catch((e) => {
        setState("握手失败: " + e.message);
        setCls("bad");
      });
  }, []);

  return (
    <div>
      <header>
        <h1>
          ModelMux <span>面板</span>
        </h1>
        <nav>
          {TABS.map(([k, label]) => (
            <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className={cls}>{state}</span>
        <button onClick={() => window.location.reload()}>刷新</button>
      </header>
      {tab === "overview" && <Overview />}
      {tab === "accounts" && <Accounts />}
      {tab === "models" && <Models />}
      {tab === "logs" && <Logs />}
    </div>
  );
}
