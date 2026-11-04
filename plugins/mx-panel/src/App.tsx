import { useEffect, useState } from "react";
import { handshake, tool } from "./api";
import { Accounts } from "./components/Accounts";
import { Logs } from "./components/Logs";
import { Models } from "./components/Models";
import { Overview } from "./components/Overview";
import type { StatusData } from "./types";

type Tab = "overview" | "accounts" | "models" | "logs" | "console";
const TABS: Array<[Tab, string]> = [
  ["overview", "概览"],
  ["accounts", "账号"],
  ["models", "模型"],
  ["logs", "日志"],
  ["console", "控制台"],
];

/** 完整控制台页签：iframe 内嵌网关 /web/（同源闸门对 iframe 内页面放行，实测 200） */
function ConsoleTab() {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    tool<StatusData>("mx_status")
      .then((d) => setUrl(d.consoleUrl || ""))
      .catch((e) => setErr(e.message));
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 剪贴板不可用：地址已显示在栏里，手动复制
    }
  };

  if (err) return <p className="err">取控制台地址失败：{err}</p>;
  if (!url) return <p className="busy">正在获取控制台地址…</p>;
  return (
    <div className="console-tab">
      <div className="console-bar">
        <span className="dim">{url}</span>
        <span className="spacer" />
        <button className="mini" onClick={copy}>
          复制地址
        </button>
      </div>
      <iframe title="ModelMux 控制台" src={url} />
    </div>
  );
}

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
    <div className={tab === "console" ? "app no-scroll" : "app"}>
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
      <main>
        {tab === "overview" && <Overview />}
        {tab === "accounts" && <Accounts />}
        {tab === "models" && <Models />}
        {tab === "logs" && <Logs />}
        {tab === "console" && <ConsoleTab />}
      </main>
    </div>
  );
}
