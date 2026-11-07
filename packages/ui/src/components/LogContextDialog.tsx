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
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { loadCtxScroll, pruneCtxScroll, saveCtxScroll, signatureOf } from "../lib/ctx-scroll";
import { parseLenient } from "../lib/lenient-json";
import { describeBinary, estimateBytes, looksBinaryish } from "../lib/payload-binary";
import { brief, formatBytes, formatCount, formatDateTime, OUTCOME_META } from "../lib/log-format";
import {
  assembledBody,
  growHead,
  growTail,
  initialSpan,
  nextHeadRequest,
  nextTailRequest,
  PAYLOAD_SLICE,
  spanComplete,
  spanGapBytes,
  type SliceSpan,
  type SliceWindow,
  windowsTileFully,
} from "../lib/payload-slices";
import { shouldOfferTranslation, translateText } from "../lib/translate";
import type { AccessLogEntry, PayloadRecord } from "../lib/types";
import { CopyButton } from "./CopyButton";
import { ScrollJump } from "./ScrollJump";

/** role 的中文名。未知 role 原样显示，不猜。 */
const ROLE_LABEL: Record<string, string> = {
  system: "系统提示词",
  developer: "开发者提示词",
  user: "用户消息",
  assistant: "AI 消息",
  tool: "工具结果",
  function: "工具结果",
};

/** 恢复滚动位置的到达容差（px）：平滑滚动与缩放会留下零头。 */
const RESTORE_TOLERANCE = 2;

/** 恢复循环的「内容不再变高」判据（帧）：约 2.5s 没有新分片就认命，停在可达的最近位置。 */
const STALL_FRAMES = 150;

/** 恢复循环的兜底上限（ms）：正常路径由到达 / 接管 / 不再变高终止。 */
const RESTORE_MAX_MS = 30_000;

/** 滚动条槽宽（px，`index.css` 里自定义为 10px，留 2px 余量）：判断指针是否落在槽内。 */
const SCROLLBAR_GUTTER = 12;

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

/**
 * OpenAI Responses 的 `input[]`（Codex 原生形态）映射成 messages 形态复用消息卡：
 * message → 同名；reasoning → reasoning_content；function_call → tool_calls；
 * function_call_output → role:"tool"。未知 item 原样保留（JsonBlock 兜底渲染）。
 */
function normalizeResponsesInput(items: unknown[]): unknown[] {
  return items.map((item) => {
    const rec = asRecord(item);
    switch (rec["type"]) {
      case "message": {
        if (typeof rec["content"] === "string") {
          return { role: typeof rec["role"] === "string" ? rec["role"] : "user", content: rec["content"] };
        }
        const parts = Array.isArray(rec["content"]) ? rec["content"] : [];
        const texts: string[] = [];
        const nonText: unknown[] = [];
        for (const part of parts) {
          const p = asRecord(part);
          const text = p["text"];
          if (typeof text === "string") {
            texts.push(text);
            continue;
          }
          if (p["type"] === "input_image" || p["type"] === "image_url") {
            // 转成 chat 形态让现有图片占位逻辑认得
            const url = typeof p["image_url"] === "string" ? p["image_url"] : asRecord(p["image_url"])["url"];
            nonText.push({ type: "image_url", image_url: { url: typeof url === "string" ? url : "" } });
          } else {
            nonText.push(part);
          }
        }
        const role = typeof rec["role"] === "string" ? rec["role"] : "user";
        if (nonText.length > 0) {
          return {
            role,
            content: [...nonText, ...texts.map((text) => ({ type: "text", text }))],
          };
        }
        return { role, content: texts.join("\n") };
      }
      case "reasoning": {
        const summary = Array.isArray(rec["summary"]) ? rec["summary"] : [];
        const texts = summary.map((s) => asRecord(s)["text"]).filter((t): t is string => typeof t === "string");
        return {
          role: "assistant",
          reasoning_content:
            texts.length > 0 ? texts.join("\n") : "（加密思考链，上下文里只有密文占位）",
        };
      }
      case "function_call":
        return {
          role: "assistant",
          tool_calls: [
            {
              id: typeof rec["call_id"] === "string" ? rec["call_id"] : rec["id"],
              type: "function",
              function: {
                name: typeof rec["name"] === "string" ? rec["name"] : "(未命名工具)",
                arguments: typeof rec["arguments"] === "string" ? rec["arguments"] : "{}",
              },
            },
          ],
        };
      case "function_call_output":
        return {
          role: "tool",
          tool_call_id: typeof rec["call_id"] === "string" ? rec["call_id"] : undefined,
          content: rec["output"],
        };
      default:
        return item;
    }
  });
}

/** 请求体的消息序：OpenAI chat 走 `messages`，Responses 走 `input`（映射后复用）。 */
function messagesOfBody(parsed: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(parsed["messages"])) return parsed["messages"];
  if (Array.isArray(parsed["input"])) return normalizeResponsesInput(parsed["input"]);
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

/**
 * 是不是「不该按文本铺开」的内容：data URL（图片/音频/PDF…）与裸 base64 长串。
 *
 * 判据与体积计算在 `lib/payload-binary.ts`（可被单测钉死）：agent 上下文里图片是
 * `data:image/png;base64,…`，实测一条正文 23 张、单张 6 万字符 —— 直接铺出来就是
 * 占满弹窗的 base64 墙，正文一个字都看不见。
 */

/** 非文本片段/长 base64 的占位卡：只说类型与体积，不铺内容。 */
function BinaryNotice({ label, bytes }: { label: string; bytes: number }): ReactElement {
  return (
    <p className="rounded-md border border-line/50 bg-canvas/40 px-2.5 py-1.5 text-xs text-ink-faint">
      {label}（{formatBytes(bytes)}）—— 二进制内容不展开
    </p>
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
      // 空串 error 会让失败态隐身（label 回退成「翻译」），兜底一个可读文案
      setState({ loading: false, error: String(err instanceof Error ? err.message : err) || "未知翻译错误" });
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
 * Markdown 渲染（仅 assistant 正文）：GFM 表格 / 代码块可用；单换行保留为换行
 * （remark-breaks）—— CommonMark 把 softbreak 折成空格，中文回复习惯单换行分段，
 * 折了就是整段粘连。
 *
 * 不开 `rehype-raw` —— 消息里的 HTML 一律转义为文本，绝不执行；
 * system 与工具输出刻意不走这里（提示词里的 XML 标签会被渲染器吃掉，保真优先）。
 */
function MarkdownText({ text }: { text: string }): ReactElement {
  return (
    <div className="log-md text-xs leading-relaxed text-ink-soft [&_a]:text-ink [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-canvas [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-ink [&_h2]:text-ink [&_h3]:text-ink [&_hr]:border-line [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-canvas [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs [&_strong]:text-ink [&_table]:w-full [&_td]:border [&_td]:border-line/60 [&_td]:px-1.5 [&_th]:border [&_th]:border-line/60 [&_th]:px-1.5 [&_ul]:list-disc">
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</Markdown>
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
    // 裸 base64 整段铺开会把弹窗变成 base64 墙（实测 tool 结果 33945 字符）
    if (looksBinaryish(content)) {
      return <BinaryNotice label="二进制片段" bytes={estimateBytes(content)} />;
    }
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
    /**
     * 折叠阈值按「可读文本」算：图片那类二进制片段不算进去 ——
     * 否则 23 张图一进来，段就把整条消息折上，用户还得先展开才看得到正文。
     */
    const total = content.reduce((sum, part) => {
      const rec = asRecord(part);
      return sum + (typeof rec["text"] === "string" ? (rec["text"] as string).length : 0);
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
            // 图片/音频等：只报类型与体积。媒体 URL 在 `image_url.url` / `source.data` 两处
            // （OpenAI 与 Anthropic 形态），两种都认；其余非文本片段回落 `brief`。
            const dataUrl =
              typeof rec["image_url"] === "object" && rec["image_url"] !== null
                ? String((asRecord(rec["image_url"])["url"] ?? ""))
                : typeof rec["source"] === "object" && rec["source"] !== null
                  ? String((asRecord(rec["source"])["data"] ?? ""))
                  : "";
            const url = dataUrl !== "" ? dataUrl : typeof rec["url"] === "string" ? rec["url"] : "";
            if (url !== "") {
              const info = describeBinary(url);
              return <BinaryNotice key={index} label={info.label} bytes={info.bytes} />;
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
 * 单条记录：元数据 + 按需加载的正文（**两头起手 + 双向懒加载**）。
 *
 * 正文不随首屏一起到达（`record.body` 默认是空串）——整段解压后可达 MB 级，
 * 一次塞进首屏会让弹窗卡住。所以：打开时同时取**头片**（`[0, 64 KiB)`）与
 * **尾片**（末尾 64 KiB），「回到顶部 / 滚动到底部」从第一次点击起就落在真两端；
 * 中间留空隙块，两侧各一个哨兵按需补片；两头接上后拼成完整正文，走单段解析路径。
 *
 * 分片进度只认**已到达的窗口**（`SliceWindow[]`，按 offset 去重后 derive），不维护
 * 「已加载字符串 + 当前 offset」两份状态 —— 旧实现的「首片拼两遍」就是两份状态不同步来的。
 */
function PayloadBlock({
  record,
  id,
  date,
  onGrow,
}: {
  record: PayloadRecord;
  id: string;
  date: string;
  /** 内容**将要**长高之前调用（弹窗据此决定是否跟随末尾，见 `noteGrowth`）。 */
  onGrow: () => void;
}): ReactElement {
  const title = record.phase === "client" ? "客户端原始请求" : `上行 #${(record.attempt ?? 0) + 1}`;
  const [headWindows, setHeadWindows] = useState<SliceWindow[]>([]);
  const [tailWindows, setTailWindows] = useState<SliceWindow[]>([]);
  // 已请求的头/尾片起点：头片挂载即取（第 0 格），尾片等 total 认准后再取（见下面的预取 effect）
  const [headAsked, setHeadAsked] = useState<number | null>(record.body === "" ? 0 : null);
  const [tailAsked, setTailAsked] = useState<number | null>(null);
  const headSentinel = useRef<HTMLDivElement | null>(null);
  const tailSentinel = useRef<HTMLDivElement | null>(null);

  /**
   * 进度的 `total` 只认**服务端**给的那个：元数据里的 `bytes` 与服务端 `total` 不是一套口径 ——
   * 截断记录的 `bytes` 是**原始**长度（落盘更短），而明文小记录（< 4 KiB）服务端按**字符**切片、
   * `total` 是码元数（含中文时比字节小）。拿 `bytes` 当几何基准会让尾格落到正文之外：
   * 服务端返回 200 + 空 body，进度永不推进、空隙永远收不掉。
   */
  const total = headWindows[0]?.total ?? tailWindows[0]?.total ?? record.bytes;
  /** 任一窗口到达 ⇒ `total` 已是服务端口径，可以据此算尾格几何。 */
  const totalKnown = headWindows.length > 0 || tailWindows.length > 0;

  const span = useMemo<SliceSpan>(() => {
    let next = initialSpan(total);
    for (const window of headWindows) next = growHead(next, window);
    for (const window of tailWindows) next = growTail(next, window);
    return next;
  }, [total, headWindows, tailWindows]);
  const complete = record.body !== "" || spanComplete(span);
  const head = headWindows.map((window) => window.body).join("");
  const tail = tailWindows.map((window) => window.body).join("");
  const windows = useMemo(() => [...headWindows, ...tailWindows], [headWindows, tailWindows]);
  const body = assembledBody({ recordBody: record.body, span, windows });
  /** 进度说取全、窗口却没铺满：拼接会缺段，宁可报错也不显示半截正文。 */
  const assemblyBroken = complete && record.body === "" && !windowsTileFully(windows, total);

  const headRequest = complete ? null : nextHeadRequest(span);
  const tailRequest = complete ? null : nextTailRequest(span);
  // 哨兵申请的就是当前这一片时才发请求：片到达后 `headRequest.offset` 前移、等式自然断开，
  // 不会拿旧 offset 配新 limit 去打一个已经不需要的窗口。
  const headReady = headRequest !== null && headAsked === headRequest.offset;
  const tailReady = tailRequest !== null && tailAsked === tailRequest.offset;
  const headSlice = useQuery({
    queryKey: ["logPayloadBody", id, date, record.phase, "head", headRequest?.offset ?? -1, headRequest?.limit ?? 0],
    queryFn: () => api.logPayloadBody(id, date, record.phase, headRequest?.offset ?? 0, headRequest?.limit ?? 0),
    enabled: headReady,
    staleTime: 60_000,
  });
  const tailSlice = useQuery({
    queryKey: ["logPayloadBody", id, date, record.phase, "tail", tailRequest?.offset ?? -1, tailRequest?.limit ?? 0],
    queryFn: () => api.logPayloadBody(id, date, record.phase, tailRequest?.offset ?? 0, tailRequest?.limit ?? 0),
    enabled: tailReady,
    staleTime: 60_000,
  });
  // 到达即并入（按 offset 去重：重复到达不会拼两遍）。
  // 写 state 之前先让弹窗记一次「此刻贴不贴底」—— 内容长高本身不产生 scroll 事件，
  // 长高之后再问就晚了（末尾已经被推走了）。
  useEffect(() => {
    const data = headSlice.data;
    if (data === undefined || data.body === "") return;
    onGrow();
    setHeadWindows((prev) => (prev.some((w) => w.offset === data.offset) ? prev : [...prev, data]));
  }, [headSlice.data]);
  useEffect(() => {
    const data = tailSlice.data;
    if (data === undefined || data.body === "") return;
    onGrow();
    setTailWindows((prev) => (prev.some((w) => w.offset === data.offset) ? prev : [...prev, data]));
  }, [tailSlice.data]);

  const headFetching = headReady && headSlice.isFetching;
  const tailFetching = tailReady && tailSlice.isFetching;
  // 取片失败（网关抖动 / 500）必须显式成为错误态：静默下去的话正文是半截，
  // 解析会把「只加载到这里」当成「正文就这么长」。失败只降级**那一侧**的提示，
  // 已经取到的头片卡片照常渲染（整块替换成错误文案等于把已在手的内容也藏了）。
  const sliceFailed = headReady && headSlice.isError ? "head" : tailReady && tailSlice.isError ? "tail" : null;

  /** 尾片预取：`total` 认准后立刻取末格，不等哨兵 —— 「打开就能滚到真末尾」靠这一步。 */
  useEffect(() => {
    if (record.body !== "" || tailAsked !== null || tailRequest === null || !totalKnown) return;
    setTailAsked(tailRequest.offset);
  }, [record.body, tailAsked, tailRequest, totalKnown]);

  // 双向懒加载：哨兵进视口、那个方向还有剩余 → 请求下一格。
  // 依赖里带上进度，每格到达后重建观察器 —— 哨兵仍在视口时会立刻再来一格（连续补片）。
  // 不做方向门：两侧同时可见就两侧一起补（与旧实现「停在底部就一直往下取」同一取舍），
  // 方向门要靠 wheel 判方向，触摸 / 键盘 / 拖滚动条都不产生它，反而会把某一侧堵死。
  useEffect(() => {
    const el = headSentinel.current;
    if (!el || headRequest === null || headFetching) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setHeadAsked(headRequest.offset);
      },
      { rootMargin: "200px 0px" }, // 略提前于视口底部就开始取，滚动不顿挫
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [headRequest, headFetching, span.headEnd, span.tailStart]);
  useEffect(() => {
    const el = tailSentinel.current;
    if (!el || tailRequest === null || tailFetching) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setTailAsked(tailRequest.offset);
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [tailRequest, tailFetching, span.headEnd, span.tailStart]);

  // 宽松解析：完整 JSON 走严格路径；截断前缀抢救已完整的消息（信封也在此剥开）。
  // truncated 记录不再尝试解析（双端截断的正文拼不出真实消息序）；
  // 未取全时 `body` 是空串，这里解析的是**头片**（前缀）—— 与改造前同一套语义。
  const section = complete ? body : head;
  const lenient = record.truncated ? null : parseLenient(section);
  const parsed = lenient?.top ?? null;
  const partial = !complete || (lenient?.truncated ?? false);
  const messages = parsed !== null ? messagesOfBody(parsed) : null;
  const tools = parsed !== null && Array.isArray(parsed["tools"]) ? parsed["tools"] : null;
  const rest =
    parsed === null
      ? null
      : Object.fromEntries(
          Object.entries(parsed).filter(([key]) => key !== "messages" && key !== "input" && key !== "tools"),
        );
  const restKeys = rest === null ? [] : Object.keys(rest);
  /**
   * 无效字节的可见提示：正文里的替换符来自「客户端发的就不是合法 UTF-8」——
   * 常见于 Windows 上 GBK 控制台输出被原样塞进 JSON（PowerShell 报错、GBK argv）。
   * 乱码不是弹窗渲染坏了，如实说清来源比让读者对着 � 猜强。
   */
  const fffdCount = complete ? (body.match(/\uFFFD/g) ?? []).length : 0;

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
            complete={complete}
            total={total}
            title={title}
          />
        </span>
      </header>
      <div className="space-y-2 px-3.5 py-3">
        {/* 失败只降级这一侧的提示：已到达的内容照常渲染（整块换成错误文案会把手里已有的也藏掉）。
            不叫「重开弹窗」—— 页内就能重试，代价小得多 */}
        {sliceFailed !== null && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-danger">
            <span>
              {sliceFailed === "head" ? "开头片段" : "末尾片段"}读取失败（网关或网络抖动）——
              其余内容照常显示。
            </span>
            <button
              type="button"
              onClick={() => {
                void headSlice.refetch();
                void tailSlice.refetch();
              }}
              className="tap rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              重试
            </button>
          </div>
        )}
        {assemblyBroken ? (
          <p className="text-xs text-danger">
            正文拼装异常（分片没铺满）—— 不显示半截正文；重开本弹窗会重新读取。
          </p>
        ) : parsed === null ? (
          <>
            <p className="text-xs text-ink-faint">
              {record.truncated
                ? "正文超出单条上限已被截断，按原文呈现（不再尝试解析）。"
                : complete
                  ? "正文不是可解析的请求体（编码或渠道自有格式），按原文呈现。"
                  : `以下是开头 ${formatBytes(span.headEnd)} 的原文（整份还没读完，其余见下方空隙块与末尾块）。`}
            </p>
            <JsonBlock value={section} maxHeight="max-h-[50vh]" />
          </>
        ) : (
          <>
            {messages === null && (
              <p className="text-xs text-ink-faint">
                这份请求体不是消息列表形态（渠道自有字段），已按原样逐字段呈现。
              </p>
            )}
            {fffdCount > 0 && (
              <p className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                正文含 {fffdCount} 处无法解码的字节（显示为 �）—— 客户端发送时就已不是合法
                UTF-8，常见于 Windows 的 GBK 控制台输出被原样塞进请求；乱码是源头带的，不是渲染问题。
              </p>
            )}
            {messages?.map((message, index) => (
              <MessageCard key={index} message={message} index={index} />
            ))}
            {partial && (
              <p className="text-xs text-ink-faint">
                {complete
                  ? `正文较长，已显示前 ${formatCount(head.length)} 字符内的完整消息。`
                  : `已显示开头 ${formatCount(head.length)} 字符内的完整消息 —— 中间未加载的部分见下方空隙块。`}
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
          <div className="space-y-2">
            {/*
              空隙块：头片之后、尾片之前。哨兵贴在空隙的两端 —— 向下滚到头侧补头片、
              向上滚到尾侧补尾片；两头接上后本块与尾侧原文块一起消失（回到单段渲染）。
            */}
            {!complete && (
              <div className="rounded-md border border-dashed border-line px-3.5 py-2 text-xs text-ink-faint">
                <div ref={headSentinel} className="h-px w-full" />
                <div className="flex flex-wrap items-center gap-x-2 pt-1.5">
                  {headFetching || tailFetching ? (
                    <span>正在读取…</span>
                  ) : (
                    <span>
                      中间还有 {formatBytes(spanGapBytes(span))} 未加载（共 {formatBytes(total)}）·
                      已读头 {formatBytes(span.headEnd)} + 尾{" "}
                      {formatBytes(Math.max(0, total - span.tailStart))}
                    </span>
                  )}
                  <span>向下滚动补前半段、向上滚动补后半段</span>
                </div>
                <div ref={tailSentinel} className="h-px w-full" />
              </div>
            )}

            {/* 原文不设自身滚动条：否则「滚动到底部」到的是块底、末尾还藏在块的内部滚动里 */}
            {tail !== "" && (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 border-t border-line/60 pt-1.5 text-xs text-ink-faint">
                  <span>
                    正文末尾（{formatBytes(Math.max(0, total - span.tailStart))}）· 未解析原文
                  </span>
                  <span>两头接上后这里会按消息卡片重排</span>
                </div>
                <pre className="whitespace-pre-wrap break-all rounded-md border border-line/50 bg-canvas/40 p-2 font-mono text-xs text-ink-soft">
                  {tail}
                </pre>
              </div>
            )}

            {complete && (
              <div className="border-t border-line/60 pt-1.5 text-xs text-ink-faint">
                已读完整正文（{formatBytes(total)}）· 压缩存储，按需解压
              </div>
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
 * 用 Radix Dialog：仓库既有选型（见 `LoginModal` / `ConfirmDialog`），焦点陷阱是标准行为；
 * `Portal` 挂 `document.body`，回避容器变成 fixed 包含块后被裁切。
 *
 * 两条本页特有规则（docs/WEB-CONSOLE.md 的请求日志行）：
 *   1. **只有右上角 × 能关闭**：点遮罩 / 按 Esc 都不关 —— 弹窗里是几 MB 的正文，
 *      误触即丢失阅读位置与展开状态；
 *   2. **滚动位置按请求 id 记忆**：正文懒加载 + 体量大，反复打开不该每次从头滑
 *      （口径与过期策略见 `lib/ctx-scroll.ts`）。
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * 记录集签名：位置记忆的有效性判据（见 `lib/ctx-scroll.ts` 的文件头约束 1）。
   * 元数据到达前是空串 —— 空串不写记忆，避免把「还没读到记录」的状态存进去。
   */
  const signature = useMemo(() => signatureOf(records), [records]);
  /** 待恢复的目标位置；null = 不需要恢复（无缓存 / 已到达 / 用户已接管）。 */
  const restoreRef = useRef<number | null>(null);
  /**
   * 「跟随末尾」：补片都让正文变长（头片补在下方、尾片补在尾巴前面），两种都会把**末尾**推远。
   * 用户本来在末尾（点了「滚动到底部」或自己滚到底）就不该被推走。
   *
   * 判据在**内容长高之前**现算（`noteGrowth`），不靠 scroll 事件的缓存值 —— 内容变高本身不
   * 产生 scroll 事件，缓存值会一直停在「打开弹窗时那一下」（那时内容还没高度，恒判贴底：
   * 一开弹窗就把人甩到底部，还会跟滚动位置记忆的恢复互相顶）。
   */
  const pinnedRef = useRef(false);
  const noteGrowth = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    pinnedRef.current = pinnedRef.current || (max > 4 && max - el.scrollTop <= 4);
    if (!pinnedRef.current) return;
    // 下一帧贴回末尾：这一帧内容刚要长高，现在量还是旧高度
    window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node !== null) node.scrollTop = node.scrollHeight - node.clientHeight;
    });
  };
  /** 每次「读到缓存」自增，用来唤醒恢复循环（见下）。 */
  const [restoreSeq, setRestoreSeq] = useState(0);

  /**
   * 朝目标推进：内容可能**还没长到**那个位置（正文懒加载只有首片），
   * 所以到不了就等下一帧再试（不依赖 ResizeObserver 的触发时机 —— 实测它会
   * 在内容尚未完成布局时报到，或干脆晚于缓存读取，导致恢复丢失）。
   *
   * 恢复用直接赋值（不走平滑动画）——「我已经在这儿」不该播滚动动画。
   */
  const applyRestore = (): boolean => {
    const el = scrollRef.current;
    const target = restoreRef.current;
    if (!el || target === null) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= RESTORE_TOLERANCE) return true; // 还没有可滚动区域：继续等
    el.scrollTop = Math.min(target, max);
    // 到达即收工：±2px 容忍亚像素与缩放零头
    if (Math.abs(el.scrollTop - target) <= RESTORE_TOLERANCE) restoreRef.current = null;
    return restoreRef.current !== null;
  };

  // 读缓存：记录元数据到达后才有签名，读到就唤醒恢复循环
  useEffect(() => {
    if (records.length === 0) return;
    pruneCtxScroll();
    restoreRef.current = loadCtxScroll(entry.id, signature);
    if (restoreRef.current !== null) setRestoreSeq((n) => n + 1);
  }, [entry.id, signature, records.length]);

  /**
   * 恢复循环：逐帧推进直到**到达 / 用户接管 / 内容不再变高**（另加 30s 兜底）。
   *
   * 逐帧而不是单次赋值 —— 正文是边滚边加载的，目标位置要等内容长够才够得着。
   * 「内容不再变高」才收工（不是帧数）：拉片慢时帧数上限会让人留在中途，
   * 而停下就意味着「已加载的就这么高」，此刻的位置已是可达的最近点。
   */
  useEffect(() => {
    if (restoreSeq === 0 || restoreRef.current === null) return;
    let raf = 0;
    let stalled = 0;
    let lastMax = -1;
    const startedAt = Date.now();
    const tick = (): void => {
      const el = scrollRef.current;
      if (el !== null) {
        const max = el.scrollHeight - el.clientHeight;
        stalled = max > lastMax ? 0 : stalled + 1;
        lastMax = Math.max(lastMax, max);
      }
      const pending = applyRestore();
      if (!pending || stalled > STALL_FRAMES || Date.now() - startedAt > RESTORE_MAX_MS) return;
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [restoreSeq]);

  /**
   * 用户接管即放弃恢复与贴底跟随（用户意图优先，别和懒加载的自动滚动打架）。
   *
   * 只听**真实手势**：滚轮 / 触摸 / 滚动键 / 拖滚动条 —— 程序化滚动（恢复本身、
   * 跳转钮的平滑动画）不在此列，否则恢复会自我打断。
   * 滚动键单独判：容器本身不可聚焦，`keydown` 只会从内部按钮（复制 / 翻译）冒泡上来，
   * 那些按键不是滚动意图，不该取消恢复。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const abandon = (): void => {
      restoreRef.current = null;
      pinnedRef.current = false;
    };
    const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
    const onKey = (event: KeyboardEvent): void => {
      if (scrollKeys.has(event.key)) abandon();
    };
    // 拖滚动条 / 点轨道：指针落在右侧滚动条槽内才算（内容区点击可能是选文本或点按钮）
    const onPointerDown = (event: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      if (event.clientX > rect.right - SCROLLBAR_GUTTER) abandon();
    };
    el.addEventListener("wheel", abandon, { passive: true });
    el.addEventListener("touchstart", abandon, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      el.removeEventListener("wheel", abandon);
      el.removeEventListener("touchstart", abandon);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  /**
   * 滚动停止后写缓存（防抖 400ms）：逐帧写 localStorage 会把主线程拖住，
   * 而中间帧的位置也没有意义 —— 要的是「停在哪」。
   * 卸载时**冲刷**而不是丢掉：关弹窗前的最后一停往往就是用户想记住的位置。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || signature === "") return;
    // 卸载后节点已脱离文档、`scrollTop` 读回 0，只能用滚动监听记下的最后位置
    let last = el.scrollTop;
    let timer: number | undefined;
    const onScroll = (): void => {
      last = el.scrollTop;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        saveCtxScroll(entry.id, last, signature);
      }, 400);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        saveCtxScroll(entry.id, el.isConnected ? el.scrollTop : last, signature);
      }
    };
  }, [entry.id, signature]);

  /** 跳转钮点击：位置确定（0 / 底部），立刻落缓存，不等防抖。跳到底 = 从此跟随末尾。 */
  const onJump = (where: "top" | "bottom", el: HTMLElement): void => {
    restoreRef.current = null;
    const top = where === "top" ? 0 : el.scrollHeight - el.clientHeight;
    pinnedRef.current = where === "bottom";
    saveCtxScroll(entry.id, top, signature);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          // 点遮罩 / 焦点落到外部不关、Esc 也不关：关闭只剩右上角 ×（键盘用户 Tab 到 × 回车）。
          // 理由见组件头注释 1 —— 正文体量大，误触代价是丢掉阅读位置。
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(1080px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-raised"
        >
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

          {/*
            滚动区右侧留 64px（`pr-16`）给悬浮跳转钮：长正文里按钮压住字符是真损失，
            而按钮若挪到右下角又会撞上 toast（z-60）。64 而不是 56：窄屏下 `.tap-square`
            把按钮抬到 44px 宽，56px 栏位会被按钮正好占满（实测 390 视口间隙 0）。
          */}
          <div className="relative flex min-h-0 flex-1">
            {/*
              跳转钮排在滚动区**之前**：绝对定位不受 DOM 顺序影响（视觉不变），
              而 Tab 顺序会因此落在正文之前 —— 否则长正文里要按几百次 Tab 才够得到它。
            */}
            <ScrollJump target={scrollRef} content={contentRef} onJump={onJump} />
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-auto py-4 pr-16 pl-5"
            >
              <div ref={contentRef} className="space-y-3">
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
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-danger">请求上下文读取失败</p>
                    <button
                      type="button"
                      onClick={() => void payload.refetch()}
                      className="tap rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-soft hover:border-line-strong hover:text-ink"
                    >
                      重试
                    </button>
                  </div>
                ) : records.length > 0 ? (
                  records.map((record) => (
                    <PayloadBlock
                      key={`${record.phase}-${record.seq}`}
                      record={record}
                      id={entry.id}
                      date={date}
                      onGrow={noteGrowth}
                    />
                  ))
                ) : (
                  <p className="text-xs text-ink-faint">
                    该请求没有抓取记录（可能是请求未进入转发，或已过保留期清理）。
                  </p>
                )}
              </div>
            </div>
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
