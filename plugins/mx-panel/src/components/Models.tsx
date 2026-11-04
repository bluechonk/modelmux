import { useEffect, useMemo, useState } from "react";
import { tool } from "../api";
import type { ModelEntry, ModelsData } from "../types";

const fmtNum = (n: number | null | undefined) => (n == null ? "-" : Number(n).toLocaleString("zh-CN"));

const MODALITY_LABEL: Record<string, string> = { text: "文本", image: "视觉", audio: "音频", video: "视频" };

function modalities(list: string[] | null | undefined): string {
  if (!list || list.length === 0) return "-";
  return list.map((m) => MODALITY_LABEL[m] ?? m).join("+");
}

export function Models() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = () => tool<ModelsData>("mx_models").then((d) => setModels(d.models)).catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  // 按 channel id 分组(池 id 的 <cid>/ 前缀),组内保持网关返回顺序
  const byCid = useMemo(() => {
    const filtered = models.filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase()));
    const map = new Map<string, ModelEntry[]>();
    for (const m of filtered) {
      const cid = m.id.split("/")[0];
      const list = map.get(cid);
      if (list) list.push(m);
      else map.set(cid, [m]);
    }
    return [...map.entries()];
  }, [models, q]);

  if (err && models.length === 0) return <p className="err">加载失败：{err}</p>;
  return (
    <div>
      <input
        className="search"
        type="search"
        placeholder="搜索模型 id…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {byCid.map(([cid, list]) => (
        <section key={cid}>
          <h3>
            {cid} <span className="dim">({list.length})</span>
          </h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>池 id</th>
                  <th className="num">上下文</th>
                  <th className="num">最大输出</th>
                  <th>思考档位</th>
                  <th>文本/视觉</th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id}>
                    <td>{m.id}</td>
                    <td className="num">{fmtNum(m.context_window)}</td>
                    <td className="num">{fmtNum(m.max_output_tokens)}</td>
                    <td className="dim">{(m.effort ?? []).join(" / ") || "-"}</td>
                    <td>
                      {modalities(m.input_modalities)}
                      {m.output_modalities && m.output_modalities.join() !== m.input_modalities?.join() ? (
                        <span className="dim"> → {modalities(m.output_modalities)}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
