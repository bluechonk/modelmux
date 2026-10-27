/**
 * 请求上下文弹窗：按请求 id 读回抓取的正文，把「这次请求到底构造了什么」完整摊开。
 *
 * 关键约束：
 *  - 正文是**原样文本**：能解析就按 messages 逐条渲染，不能（截断 / 自编码体）就给原文
 *  - 上行体不一定是 OpenAI 形态（有的渠道是自有字段）→ 无 messages 时整段呈现并说明
 *  - 非文本片段（图片等）只给类型与长度，不铺 base64
 *  - 铁律：不用 hover 气泡；需要折叠的一律用可点的 `<details>`
 */

import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Terminal, X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";
import { brief, formatBytes, formatDateTime, OUTCOME_META } from "../lib/log-format";
import type { AccessLogEntry, PayloadRecord } from "../lib/types";
import { CopyButton } from "./CopyChip";

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
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-ink-soft">
        {summary}
      </summary>
      <div className="border-t border-line/40 px-2.5 py-2">{children}</div>
    </details>
  );
}

function JsonBlock({ value, maxHeight = "max-h-56" }: { value: unknown; maxHeight?: string }): ReactElement {
  return (
    <pre
      className={`${maxHeight} overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-soft`}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** 一条消息的正文：字符串直出；分片数组逐片渲染；其它按 JSON 预览。 */
function MessageContent({ content }: { content: unknown }): ReactElement | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") {
    if (content === "") return null;
    return (
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-soft">
        {content}
      </p>
    );
  }
  if (Array.isArray(content)) {
    return (
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
              className="whitespace-pre-wrap break-all font-mono text-[11px] text-ink-faint"
            >
              {brief(part)}
            </pre>
          );
        })}
      </div>
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
      <div className="flex flex-wrap items-center gap-2 border-b border-line/50 px-2.5 py-1 text-[11px]">
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
              <div className="mb-1 text-[11px] text-ink-faint">命令（bash）</div>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-surface px-2 py-1.5 font-mono text-[11px] text-ink">
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

  return (
    <div className="rounded-lg border border-line/70 bg-canvas/50">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 px-3 py-1.5 text-[11px]">
        <span className="pill bg-overlay text-ink-soft">{ROLE_LABEL[role] ?? role}</span>
        <span className="font-mono text-ink-faint">{role}</span>
        <span className="text-ink-faint">#{index + 1}</span>
        {name !== null && <span className="font-mono text-ink-faint">name={name}</span>}
        {toolCallId !== null && (
          <span className="break-all font-mono text-ink-faint">tool_call_id={toolCallId}</span>
        )}
      </div>
      <div className="space-y-2 px-3 py-2">
        {reasoning !== null && (
          <div className="rounded-md border border-line/50 bg-canvas/60 px-2 py-1.5">
            <div className="mb-1 text-[11px] text-ink-faint">
              思考（reasoning_content）—— 网关会把它随上下文一起发给上游
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-ink-soft">
              {reasoning}
            </pre>
          </div>
        )}
        <MessageContent content={rec["content"]} />
        {toolCalls?.map((call, i) => (
          <ToolCallCard key={i} call={call} index={i} />
        ))}
        {!hasBody && toolCalls === null && reasoning === null && (
          <p className="text-[11px] text-ink-faint">（本条消息没有正文）</p>
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
              <div className="flex flex-wrap items-baseline gap-2 text-[11px]">
                <span className="font-mono text-ink">{name}</span>
                {typeof rec["type"] === "string" && (
                  <span className="text-ink-faint">{rec["type"]}</span>
                )}
              </div>
              {description !== "" && (
                <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-ink-faint">
                  {brief(description, 400)}
                </p>
              )}
              {fn["parameters"] !== undefined && (
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-[11px] text-ink-faint">
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
 * 一份抓取记录。
 *
 * `phase=client` 是客户端原样体（messages 形态，逐条渲染的主战场）；
 * `phase=upstream` 是真正发出去的体 —— 有的渠道不是 OpenAI 形态（catpaw 用
 * `requestContext` / `message` 自有字段），此时整段呈现并明确说明，别让人以为丢数据。
 */
function PayloadBlock({ record }: { record: PayloadRecord }): ReactElement {
  const title = record.phase === "client" ? "客户端原始请求" : `上行 #${(record.attempt ?? 0) + 1}`;
  const parsed = record.truncated ? null : parseJsonObject(record.body);
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3.5 py-2 text-[11px]">
        <span className="text-xs font-medium text-ink">{title}</span>
        {record.cid !== undefined && <span className="font-mono text-ink-soft">{record.cid}</span>}
        {record.model !== undefined && (
          <span className="break-all font-mono text-ink-faint">{record.model}</span>
        )}
        <span className="tabular text-ink-faint">{formatBytes(record.bytes)}</span>
        <span className="text-ink-faint">{formatDateTime(record.ts)}</span>
        {record.truncated && <span className="pill bg-warn/15 text-warn">已截断</span>}
        <span className="ml-auto">
          <CopyButton value={record.body} label={`复制${title}的 JSON`} />
        </span>
      </header>
      <div className="space-y-2 px-3.5 py-3">
        {parsed === null ? (
          <>
            <p className="text-[11px] text-ink-faint">
              {record.truncated
                ? "正文超出单条上限已被截断，按原文呈现（不再尝试解析）。"
                : "正文不是 JSON 对象（自编码请求体），按原文呈现。"}
            </p>
            <JsonBlock value={record.body} maxHeight="max-h-[50vh]" />
          </>
        ) : (
          <>
            {messages === null && (
              <p className="text-[11px] text-ink-faint">
                这份请求体不是 OpenAI `messages` 形态（渠道自有字段），已按原样逐字段呈现。
              </p>
            )}
            {messages?.map((message, index) => (
              <MessageCard key={index} message={message} index={index} />
            ))}
            {tools !== null && <ToolDefinitions tools={tools} />}
            {restKeys.length > 0 && (
              <Disclosure summary={`其余参数（${restKeys.join("、")}）`}>
                <JsonBlock value={rest} maxHeight="max-h-[40vh]" />
              </Disclosure>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** 抓取开关关闭时的说明：给可执行的开启办法，而不是一句「没有数据」。 */
function CaptureOffHint(): ReactElement {
  return (
    <div className="space-y-2 text-xs text-ink-soft">
      <p>
        请求正文抓取当前<strong className="font-medium text-ink">关闭</strong>
        （默认关闭：正文含用户内容，不落盘）。
      </p>
      <p>
        开启：设环境变量{" "}
        <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink">
          MODELMUX_LOG_PAYLOAD=1
        </code>{" "}
        后<strong className="font-medium text-ink">完整重启</strong>网关（
        <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink">
          mx stop &amp;&amp; mx start
        </code>
        ），之后的新请求才会记录。
      </p>
      <p className="text-ink-faint">
        可用 <code className="font-mono">MODELMUX_LOG_PAYLOAD_CIDS</code> 限定渠道、
        <code className="font-mono">MODELMUX_LOG_PAYLOAD_MAX_BYTES</code> 改单条上限；
        正文保留期默认 3 天（<code className="font-mono">MODELMUX_LOG_PAYLOAD_DAYS</code>）。
      </p>
    </div>
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
  payloadEnabled,
  onClose,
}: {
  entry: AccessLogEntry;
  /** 日志所在日期：抓取记录按日分目录，带上能少走一轮查找。 */
  date: string;
  /** 抓取开关（列表接口下发）；仅在「查不到记录」时决定措辞（是否给开启办法）。 */
  payloadEnabled: boolean;
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
  const noRecordHint = payloadEnabled
    ? "该请求没有抓取记录（早于开启时间，或已被保留期清理）。"
    : null;

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
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
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
            {payload.isPending ? (
              <p className="text-xs text-ink-faint">正在读取…</p>
            ) : payload.isError ? (
              <p className="text-xs text-danger">请求上下文读取失败，请重试。</p>
            ) : records.length > 0 ? (
              records.map((record) => (
                <PayloadBlock key={`${record.phase}-${record.seq}`} record={record} />
              ))
            ) : (
              noRecordHint ?? <CaptureOffHint />
            )}
          </div>

          {records.length > 0 && (
            <footer className="shrink-0 border-t border-line px-5 py-2 text-[11px] text-ink-faint">
              正文按原样落盘、未做脱敏；上游响应正文本页不展示。
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
