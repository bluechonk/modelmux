/**
 * 请求上下文弹窗：按请求 id 读回抓取的正文，把「这次请求到底构造了什么」完整摊开
 * （抓取开关、字段与安全边界见 docs/LOGGING.md §9）。
 *
 * 关键约束（docs/LOGGING.md §9）：
 *   - 正文是原样文本：能解析就按 messages 逐条渲染，不能（截断 / 自编码体）就给原文
 *   - 上行体不一定是 OpenAI 形态（如 catpaw 的自有字段）→ 无 messages 时整段呈现并说明
 *   - 非文本片段（图片等）只给类型与长度，不铺 base64
 *
 * 铁律：不用 hover 气泡；需要折叠的一律用可点的 `<details>`
 */

import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Languages, Loader2, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { parseLenient } from "../lib/lenient-json";
import { brief, formatBytes, formatCount, formatDateTime, OUTCOME_META } from "../lib/log-format";
import { assembledBody, hasMore, nextOffset, PAYLOAD_SLICE } from "../lib/payload-slices";
import { shouldOfferTranslation, translateText } from "../lib/translate";
import type { AccessLogEntry, PayloadRecord } from "../lib/types";
import { CopyButton } from "./CopyButton";

/** role 的中文名。未知 role 原样显示，不猜。 */
const ROLE_LABEL: Record<string, string> = {
  system: "系统提示词",
  developer: "开发者提示词",
  user: "用户消息",
  assistant: "AI 消息",
  tool: "工具结果",
  function: "工具结果",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 解析成对象；不是 JSON 或是个数组就返回 null（调用方按原文呈现）。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 截断或自编码体：不是 JSON 属正常情况
  }
  return null;
}

/** 折叠区（其余参数 / 工具定义 / 参数结构共用），保持视觉一致。 */
function Disclosure({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <details className="rounded-md border border-line/50 bg-canvas/40">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs text-ink-soft">
        {summary}
      </summary>
      <div className="border-t border-line/40 px-2.5 py-2">{children}</div>
    </details>
  );
}

function JsonBlock({ value, maxHeight = "max-h-56" }: { value: unknown; maxHeight?: string }): ReactElement {
  return (
    <pre
      className={`${maxHeight} overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-ink-soft`}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** 折叠阈值：正文超过这个字符数先收起（按钮展开，**不截断源文本**）。 */
const COLLAPSE_CHARS = 1600;

/**
 * 「翻译 / 原文」切换按钮（受控）：译文与「正在看译文」都挂在调用方。
 *
 * 只在 `shouldOfferTranslation()` 判定为「大量英文」的正文上出现（判据见
 * docs/TRANSLATION.md §3）；译文只存在内存里，按钮再点一次回原文。
 * 失败**可见不吞**：按钮变成「翻译失败」并带上错误码，再点一次重试。
 */
function TranslateButton({
  text,
  translated,
  showing,
  onTranslated,
  onToggle,
}: {
  text: string;
  /** 已译好的正文；null = 还没翻。 */
  translated: { text: string; truncated: boolean } | null;
  /** 当前正文区展示的是译文（true）还是原文（false）。 */
  showing: boolean;
  onTranslated: (translated: { text: string; truncated: boolean }) => void;
  onToggle: (showing: boolean) => void;
}): ReactElement {
  const [state, setState] = useState<{ loading: boolean; error: string }>({
    loading: false,
    error: "",
  });

  const run = async (): Promise<void> => {
    if (translated !== null) {
      onToggle(!showing);
      return;
    }
    setState({ loading: true, error: "" });
    try {
      const result = await translateText(text);
      onTranslated(result);
      onToggle(true);
      setState({ loading: false, error: "" });
    } catch (err) {
      setState({ loading: false, error: String(err instanceof Error ? err.message : err) });
    }
  };

  const label = state.loading
    ? "翻译中…"
    : state.error !== ""
      ? "翻译失败"
      : translated === null
        ? "翻译"
        : showing
          ? "原文"
          : "译文";

  return (
    <button
      type="button"
      aria-label={state.error !== "" ? `翻译失败：${state.error}（点击重试）` : label}
      aria-pressed={translated !== null && showing}
      disabled={state.loading}
      onClick={() => void run()}
      className={`tap inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-xs transition-colors ${
        state.error !== ""
          ? "border-danger/40 text-danger hover:bg-danger/10"
          : translated !== null && showing
            ? "border-line-strong bg-overlay text-ink"
            : "border-line text-ink-soft hover:border-line-strong hover:text-ink"
      }`}
      data-translate-toggle
    >
      {state.loading ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <Languages className="h-3.5 w-3.5 shrink-0" />
      )}
      {label}
    </button>
  );
}

/**
 * 超长内容折叠：超过阈值时用 max-height 裁切 + 按钮。
 *
 * 不做源文本截断 —— 把 Markdown 拦腰截断会产生残缺语法；max-height 对渲染前后的
 * 任何内容（纯文本 / Markdown / JSON）都成立。
 */
function CollapseBox({ chars, children }: { chars: number; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  if (chars <= COLLAPSE_CHARS) return <>{children}</>;
  return (
    <div className="space-y-1">
      <div className={`break-words ${open ? "" : "max-h-72 overflow-hidden"}`}>{children}</div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-xs text-ink-faint transition-colors hover:text-ink"
      >
        {open ? "收起" : `展开全部（${formatCount(chars)} 字符）`}
      </button>
    </div>
  );
}

/**
 * Markdown 渲染（仅 assistant 正文）：GFM 表格 / 代码块可用。
 *
 * 不开 `rehype-raw` —— 消息里的 HTML 一律转义为文本，绝不执行；
 * system 与工具输出刻意不走这里（提示词里的 XML 标签会被渲染器吃掉，保真优先）。
 */
function MarkdownText({ text }: { text: string }): ReactElement {
  return (
    <div className="log-md text-xs leading-relaxed text-ink-soft [&_a]:text-ink [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-canvas [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-ink [&_h2]:text-ink [&_h3]:text-ink [&_hr]:border-line [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-canvas [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs [&_strong]:text-ink [&_table]:w-full [&_td]:border [&_td]:border-line/60 [&_td]:px-1.5 [&_th]:border [&_th]:border-line/60 [&_th]:px-1.5 [&_ul]:list-disc">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

/**
 * 一条消息的正文。
 *
 * Markdown 只给 **assistant**：它的回复普遍是 Markdown；用户与 system 内容可能带
 * `<system-reminder>` 这类原生标签，走渲染器会把标签吃掉 —— 保真优先，纯文本呈现。
 * 超长一律折叠（阈值见 `COLLAPSE_CHARS`）。
 */
function MessageBody({ role, content }: { role: string; content: unknown }): ReactElement | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") {
    if (content === "") return null;
    return (
      <CollapseBox chars={content.length}>
        {role === "assistant" ? (
          <MarkdownText text={content} />
        ) : (
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-soft">
            {content}
          </p>
        )}
      </CollapseBox>
    );
  }
  if (Array.isArray(content)) {
    const total = content.reduce((sum, part) => {
      const rec = asRecord(part);
      return sum + (typeof rec["text"] === "string" ? (rec["text"] as string).length : 20);
    }, 0);
    return (
      <CollapseBox chars={total}>
        <div className="space-y-1">
          {content.map((part, index) => {
            const rec = asRecord(part);
            if (rec["type"] === "text" && typeof rec["text"] === "string") {
              return (
                <p
                  key={index}
                  className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-soft"
                >
                  {rec["text"]}
                </p>
              );
            }
            return (
              <pre
                key={index}
                className="whitespace-pre-wrap break-all font-mono text-xs text-ink-faint"
              >
                {brief(part)}
              </pre>
            );
          })}
        </div>
      </CollapseBox>
    );
  }
  return <JsonBlock value={content} maxHeight="max-h-40" />;
}

/**
 * 一次工具调用。
 *
 * 参数里若带 `command`（Claude Code 类客户端的 Bash 工具），把它单独提出来当命令块渲染 ——
 * 那才是主人说的「bash 指令」；其余参数折叠，不淹没命令本身。
 */
function ToolCallCard({ call, index }: { call: unknown; index: number }): ReactElement {
  const rec = asRecord(call);
  const fn = asRecord(rec["function"]);
  const name = typeof fn["name"] === "string" ? fn["name"] : "(未命名工具)";
  const rawArgs = fn["arguments"];
  const argsText = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}, null, 2);
  const parsedArgs = typeof rawArgs === "string" ? parseJsonObject(rawArgs) : asRecord(rawArgs);
  const command = parsedArgs !== null && typeof parsedArgs["command"] === "string"
    ? (parsedArgs["command"] as string)
    : null;
  const otherArgs =
    parsedArgs === null
      ? null
      : Object.fromEntries(Object.entries(parsedArgs).filter(([key]) => key !== "command"));

  return (
    <div className="rounded-md border border-line/60 bg-canvas/70">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/50 px-2.5 py-1 text-xs">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="text-ink-faint">工具调用 #{index + 1}</span>
        <span className="font-mono text-ink">{name}</span>
        <span className="ml-auto">
          <CopyButton value={argsText} label={`复制 ${name} 的参数`} />
        </span>
      </div>
      <div className="space-y-2 px-2.5 py-2">
        {command === null ? (
          <JsonBlock value={argsText} />
        ) : (
          <>
            <div>
              <div className="mb-1 text-xs text-ink-faint">命令（bash）</div>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-surface px-2 py-1.5 font-mono text-xs text-ink">
                {command}
              </pre>
            </div>
            {otherArgs !== null && Object.keys(otherArgs).length > 0 && (
              <Disclosure summary={`其余参数（${Object.keys(otherArgs).join("、")}）`}>
                <JsonBlock value={otherArgs} maxHeight="max-h-40" />
              </Disclosure>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MessageCard({ message, index }: { message: unknown; index: number }): ReactElement {
  const rec = asRecord(message);
  const role = typeof rec["role"] === "string" ? rec["role"] : "unknown";
  const toolCalls = Array.isArray(rec["tool_calls"]) ? rec["tool_calls"] : null;
  const reasoning = typeof rec["reasoning_content"] === "string" ? rec["reasoning_content"] : null;
  const name = typeof rec["name"] === "string" ? rec["name"] : null;
  const toolCallId = typeof rec["tool_call_id"] === "string" ? rec["tool_call_id"] : null;
  const hasBody = rec["content"] !== null && rec["content"] !== undefined;
  /**
   * 只看字符串正文：数组形态（多模态 parts）与工具结果的结构差异太大，
   * 逐段翻译会把图文重排，收益远小于风险。
   */
  const plain = typeof rec["content"] === "string" ? rec["content"] : null;
  const translatable = plain !== null && shouldOfferTranslation(plain);
  const [translated, setTranslated] = useState<{ text: string; truncated: boolean } | null>(null);
  const [showing, setShowing] = useState(false);
  const body = translated !== null && showing ? translated.text : rec["content"];

  return (
    <div className="rounded-lg border border-line/70 bg-canvas/50">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 px-3 py-1.5 text-xs">
        <span className="pill bg-overlay text-ink-soft">{ROLE_LABEL[role] ?? role}</span>
        <span className="font-mono text-ink-faint">{role}</span>
        <span className="text-ink-faint">#{index + 1}</span>
        {name !== null && <span className="font-mono text-ink-faint">name={name}</span>}
        {toolCallId !== null && (
          <span className="break-all font-mono text-ink-faint">tool_call_id={toolCallId}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {translatable && plain !== null && (
            <TranslateButton
              text={plain}
              translated={translated}
              showing={showing}
              onTranslated={setTranslated}
              onToggle={setShowing}
            />
          )}
          <CopyButton value={JSON.stringify(rec)} label="复制本条消息" />
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        {reasoning !== null && (
          <div className="rounded-md border border-line/50 bg-canvas/60 px-2 py-1.5">
            <div className="mb-1 text-xs text-ink-faint">
              思考（reasoning_content）—— 网关会把它随上下文一起发给上游
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-soft">
              {reasoning}
            </pre>
          </div>
        )}
        <MessageBody role={role} content={body} />
        {translated !== null && showing && (
          <p className="text-xs text-ink-faint">
            机器翻译 · 点「原文」看原样正文
            {translated.truncated && " · 正文过长，只翻了开头的部分"}
          </p>
        )}
        {toolCalls?.map((call, i) => (
          <ToolCallCard key={i} call={call} index={i} />
        ))}
        {!hasBody && toolCalls === null && reasoning === null && (
          <p className="text-xs text-ink-faint">（本条消息没有正文）</p>
        )}
      </div>
    </div>
  );
}

/** 请求顶层的 `tools[]`：可用工具清单，也是上下文的一部分。 */
function ToolDefinitions({ tools }: { tools: unknown[] }): ReactElement {
  return (
    <Disclosure summary={`工具定义（${tools.length} 个）—— 本次一并发给了上游`}>
      <div className="space-y-1.5">
        {tools.map((tool, index) => {
          const rec = asRecord(tool);
          const fn = asRecord(rec["function"] ?? rec);
          const name = typeof fn["name"] === "string" ? fn["name"] : `tool#${index + 1}`;
          const description = typeof fn["description"] === "string" ? fn["description"] : "";
          return (
            <div key={index} className="rounded border border-line/40 px-2 py-1.5">
              <div className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-mono text-ink">{name}</span>
                {typeof rec["type"] === "string" && (
                  <span className="text-ink-faint">{rec["type"]}</span>
                )}
              </div>
              {description !== "" && (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-faint">
                  {brief(description, 400)}
                </p>
              )}
              {fn["parameters"] !== undefined && (
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-xs text-ink-faint">
                    参数结构
                  </summary>
                  <JsonBlock value={fn["parameters"]} maxHeight="max-h-52" />
                </details>
              )}
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}

/**
 * 复制该记录的**完整** JSON。
 *
 * 正文是懒加载的：`loaded` 只是已经滚动加载出来的前缀。直接复制它会把半截
 * JSON 塞进剪贴板（用户看不出来，拿去解析才报错）。所以完整时直接复制，
 * 还有剩余就先按 `total` 一次取全再复制 —— 复制是显式动作，多等一下可以接受。
 */
function CopyFullBody({
  id,
  date,
  phase,
  loaded,
  complete,
  total,
  title,
}: {
  id: string;
  date: string;
  phase: string;
  loaded: string;
  complete: boolean;
  total: number;
  title: string;
}): ReactElement {
  const [state, setState] = useState<{ busy: boolean; copied: boolean; error: string }>({
    busy: false,
    copied: false,
    error: "",
  });
  // 失败态留一会儿自动收回：剪贴板被拒时图标会一直红着，看起来像坏了
  useEffect(() => {
    if (state.error === "") return;
    const timer = setTimeout(() => setState((cur) => ({ ...cur, error: "" })), 6000);
    return () => clearTimeout(timer);
  }, [state.error]);

  const run = async (): Promise<void> => {
    if (state.busy) return;
    let text = loaded;
    if (!complete) {
      setState({ busy: true, copied: false, error: "" });
      try {
        const slice = await api.logPayloadBody(id, date, phase, 0, Math.max(total, 1));
        text = slice.body;
      } catch (err) {
        setState({ busy: false, copied: false, error: String(err) });
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setState({ busy: false, copied: true, error: "" });
      setTimeout(() => setState((cur) => ({ ...cur, copied: false })), 1200);
    } catch (err) {
      // 剪贴板不可用（非安全上下文）与取正文失败分开报：两者处置不同
      setState({ busy: false, copied: false, error: String(err) });
    }
  };

  const label =
    state.error !== ""
      ? `复制失败：${state.error}`
      : complete
        ? `复制${title}的完整 JSON`
        : `复制${title}的完整 JSON（需先读取全文）`;

  return (
    <button
      type="button"
      aria-label={label}
      disabled={state.busy}
      onClick={() => void run()}
      className="tap-square grid h-7 w-7 place-items-center rounded-md text-ink-faint/70 transition-colors hover:bg-overlay hover:text-ink disabled:opacity-50"
      data-copy-payload
    >
      {state.busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state.copied ? (
        <Check className="h-3.5 w-3.5 text-free" />
      ) : state.error !== "" ? (
        <Copy className="h-3.5 w-3.5 text-danger" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/**
 * 单条记录：元数据 + 按需加载的正文（**滚动懒加载**）。
 *
 * 正文不随首屏一起到达（`record.body` 默认是空串）——整段解压后可达 MB 级，
 * 一次塞进首屏会让弹窗卡住。首屏只取一片；用户把弹窗滚到这条记录的底部时
 * **自动**续取下一片（`IntersectionObserver` 观察哨兵元素），不再要人点按钮。
 * 每片到达都重跑 `parseLenient`，已完整闭合的新消息随之追加成卡片。
 */
function PayloadBlock({
  record,
  id,
  date,
}: {
  record: PayloadRecord;
  id: string;
  date: string;
}): ReactElement {
  const title = record.phase === "client" ? "客户端原始请求" : `上行 #${(record.attempt ?? 0) + 1}`;
  // `offset` 恒等于已加载字符数：首片 64 KiB，其后每片 +64 KiB。
  // 单一事实源，杜绝「loaded 与 offset 不同步」的拼接错位（旧实现点击路径会把首片拼两遍）。
  const [loaded, setLoaded] = useState("");
  const [offset, setOffset] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const slice = useQuery({
    queryKey: ["logPayloadBody", id, date, record.phase, offset],
    queryFn: () => api.logPayloadBody(id, date, record.phase, offset, PAYLOAD_SLICE),
    enabled: record.body === "" && offset > 0,
    staleTime: 60_000,
  });
  // 首片（offset=0）独立取：不受「滚动到底才触发」约束 —— 首屏就要拆出前 64K 的消息。
  const firstSliceQuery = useQuery({
    queryKey: ["logPayloadBody", id, date, record.phase, 0],
    queryFn: () => api.logPayloadBody(id, date, record.phase, 0, PAYLOAD_SLICE),
    enabled: record.body === "",
    staleTime: 60_000,
  });
  const body = assembledBody({
    recordBody: record.body,
    loaded,
    offset,
    firstSlice: firstSliceQuery.data,
    nextSlice: slice.data,
  });
  const total = (offset === 0 ? firstSliceQuery.data?.total : slice.data?.total) ?? record.bytes;
  const fetching =
    record.body === "" && (offset === 0 ? firstSliceQuery.isPending : slice.isPending);
  // 取片失败（网关抖动 / 500）必须显式成为错误态：静默下去的话 `body` 是空串，
  // `parseLenient("")` 返回 null → 渲染成「正文不是可解析的请求体（编码或渠道自有格式）」
  // 这个**错误结论**，而哨兵还会把 offset 推到 64K，首片内容再也不会被取回。
  const sliceFailed = record.body === "" && (offset === 0 ? firstSliceQuery.isError : slice.isError);
  const more = !sliceFailed && hasMore({ recordBody: record.body, offset, total });
  // 滚动懒加载：哨兵进入视口且还有剩余 → 取下一片。`fetching` 期间不重复触发。
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || fetching) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLoaded(body);
          setOffset(nextOffset(offset, total));
        }
      },
      { rootMargin: "200px 0px" }, // 略提前于视口底部就开始取，滚动不顿挫
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, fetching, offset, total, body]);
  // 宽松解析：完整 JSON 走严格路径；截断前缀抢救已完整的消息（信封也在此剥开）。
  // truncated 记录不再尝试解析（双端截断的正文拼不出真实消息序）。
  const lenient = record.truncated ? null : parseLenient(body);
  const parsed = lenient?.top ?? null;
  const partial = lenient?.truncated ?? false;
  const messages = parsed !== null && Array.isArray(parsed["messages"]) ? parsed["messages"] : null;
  const tools = parsed !== null && Array.isArray(parsed["tools"]) ? parsed["tools"] : null;
  const rest =
    parsed === null
      ? null
      : Object.fromEntries(
          Object.entries(parsed).filter(([key]) => key !== "messages" && key !== "tools"),
        );
  const restKeys = rest === null ? [] : Object.keys(rest);

  return (
    <section className="rounded-xl border border-line/70 bg-raised/40">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3.5 py-2 text-xs">
        <span className="text-xs font-medium text-ink">{title}</span>
        {record.cid !== undefined && <span className="font-mono text-ink-soft">{record.cid}</span>}
        {record.model !== undefined && (
          <span className="break-all font-mono text-ink-faint">{record.model}</span>
        )}
        <span className="tabular text-ink-faint">{formatBytes(record.bytes)}</span>
        <span className="text-ink-faint">{formatDateTime(record.ts)}</span>
        {record.truncated && <span className="pill bg-warn/15 text-warn">已截断</span>}
        <span className="ml-auto">
          <CopyFullBody
            id={id}
            date={date}
            phase={record.phase}
            loaded={body}
            complete={!more}
            total={total}
            title={title}
          />
        </span>
      </header>
      <div className="space-y-2 px-3.5 py-3">
        {sliceFailed ? (
          <p className="text-xs text-danger">
            正文读取失败（网关或网络抖动）—— 这不是格式问题；重开本弹窗会重新尝试读取。
          </p>
        ) : parsed === null ? (
          <>
            <p className="text-xs text-ink-faint">
              {record.truncated
                ? "正文超出单条上限已被截断，按原文呈现（不再尝试解析）。"
                : "正文不是可解析的请求体（编码或渠道自有格式），按原文呈现。"}
            </p>
            <JsonBlock value={body} maxHeight="max-h-[50vh]" />
          </>
        ) : (
          <>
            {messages === null && (
              <p className="text-xs text-ink-faint">
                这份请求体不是 OpenAI `messages` 形态（渠道自有字段），已按原样逐字段呈现。
              </p>
            )}
            {messages?.map((message, index) => (
              <MessageCard key={index} message={message} index={index} />
            ))}
            {partial && (
              <p className="text-xs text-ink-faint">
                正文较长，已显示前 {formatCount(body.length)} 字符内的完整消息 ——
                继续向下滚动会自动加载后续内容。
              </p>
            )}
            {tools !== null && <ToolDefinitions tools={tools} />}
            {restKeys.length > 0 && (
              <Disclosure summary={`其余参数（${restKeys.join("、")}）`}>
                <JsonBlock value={rest} maxHeight="max-h-[40vh]" />
              </Disclosure>
            )}
          </>
        )}
        {record.body === "" && (
          <div className="border-t border-line/60 px-3.5 py-2 text-xs text-ink-faint">
            {more ? (
              <div ref={sentinel} className="flex items-center gap-2 py-1">
                {fetching ? (
                  <span>正在读取下一片…</span>
                ) : (
                  <span>继续向下滚动加载（已读 {formatCount(body.length)} / {formatCount(total)} 字符）</span>
                )}
              </div>
            ) : (
              <span>
                已读完整正文（{formatCount(total)} 字符）· 压缩存储，按需解压
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 请求上下文弹窗（模态）。
 *
 * 用 Radix Dialog：仓库既有选型（见 `LoginModal` / `ConfirmDialog`），焦点陷阱与 ESC 关闭
 * 是标准行为；`Portal` 挂 `document.body`，回避容器变成 fixed 包含块后被裁切。
 */
export function LogContextDialog({
  entry,
  date,
  onClose,
}: {
  entry: AccessLogEntry;
  /** 日志所在日期：抓取记录按日分目录，带上能少走一轮查找。 */
  date: string;
  onClose: () => void;
}): ReactElement {
  const payload = useQuery({
    queryKey: ["logPayload", entry.id, date],
    queryFn: () => api.logPayload(entry.id, date === "" ? undefined : date),
    // 读回**不受开关门控**：关掉抓取只停止新增，已落盘的记录在保留期内照样能核对。
    staleTime: 60_000,
  });
  const meta = OUTCOME_META[entry.outcome];
  const records = payload.data?.records ?? [];

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(1080px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-raised">
          <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-medium text-ink">请求上下文</Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                  <span className="break-all font-mono text-ink-soft">{entry.id}</span>
                  <span className="tabular">{formatDateTime(entry.ts)}</span>
                  <span className="break-all font-mono">{entry.model ?? entry.path ?? "-"}</span>
                  <span className={meta.text}>
                    {meta.label}
                    {entry.status !== undefined ? ` ${entry.status}` : ""}
                  </span>
                  {entry.stream !== undefined && <span>{entry.stream ? "流式" : "单次"}</span>}
                </div>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
            {!payload.isPending && records.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink">
                  全部内容（{records.length} 条记录）
                </span>
                {/*
                  弹窗顶部不做全局复制按钮：正文懒加载，`records[].body` 在元数据查询里
                  恒是空串，聚合按钮拼不出全文；逐条「复制完整 JSON」（按需取全文）才可靠。
                */}
              </div>
            )}
            {payload.isPending ? (
              <p className="text-xs text-ink-faint">正在读取…</p>
            ) : payload.isError ? (
              <p className="text-xs text-danger">请求上下文读取失败，请重试。</p>
            ) : records.length > 0 ? (
              records.map((record) => (
                <PayloadBlock
                  key={`${record.phase}-${record.seq}`}
                  record={record}
                  id={entry.id}
                  date={date}
                />
              ))
            ) : (
              <p className="text-xs text-ink-faint">
                该请求没有抓取记录（可能是请求未进入转发，或已过保留期清理）。
              </p>
            )}
          </div>

          {records.length > 0 && (
            <footer className="shrink-0 border-t border-line px-5 py-2 text-xs text-ink-faint">
              正文按原样落盘、未做脱敏；上游响应正文本页不展示。
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
