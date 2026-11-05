/**
 * 请求上下文正文的英译中（判定 + 分块 + 调度 + 缓存）。
 *
 * 三件独立的事，各自可测：
 *   1. `shouldOfferTranslation()` —— 这段正文值不值得翻（算法见 docs/TRANSLATION.md）
 *   2. `splitCodeSegments()` + `chunkProse()` —— 保护代码块、按空行切块、超长硬切
 *   3. `translateText()` —— 查缓存 → 按服务端单批上限分批请求 → 拼回
 *
 * 译文只活在内存里（模块级 Map，刷新即失效），**绝不回写日志正文** ——
 * 正文是排查事实源，机器翻译写回去就再也分不清原文与译文。
 */

import { api } from "./api.ts";

/** 目标语言：控制台界面是中文，只做中译。 */
const TARGET = "zh-Hans";

/** 单块字符上限：服务端 4000 留余量（上游上限按整批算，见 docs/TRANSLATION.md §5.1）。 */
const CHUNK_CHARS = 3000;

/** 单条消息最多翻这么多字符：再长就不是「读一段话」而是「翻一份文档」了。 */
const MAX_TRANSLATE_CHARS = 12_000;

/** 缓存条数上限：正文动辄上万字符，不设上限会随浏览一路涨。 */
const CACHE_ENTRIES = 40;

/** 判定只看前这么多个字符：MB 级正文全量扫一遍要几十毫秒，且结论不会变。 */
const DETECT_SAMPLE = 30_000;

/**
 * 判定用的英文功能词（closed-class words）。
 *
 * 为什么用功能词而不是 `franc` / CLD3：正文里混着代码、路径与 JSON，n-gram 语言
 * 模型会把 `[]{};` 密布的片段判成法语/西语（实测见 docs/TRANSLATION.md §3）。
 * 英文散文的功能词占比天然在 12% 以上，代码与 JSON 几乎为 0 —— 这个判据对
 * 「一段话是不是英文散文」更稳，且完全可解释、可单测。
 */
const STOPWORDS = new Set(
  (
    "the of and to in is that for with as on by this are be or from at it an not you we they " +
    "he she was were has have had will would can could should do does did but if then than which " +
    "what when where who how all any each other into their your our its these those there here " +
    "about after before between under over out up down no yes so such only also more most some " +
    "very much many few both every own same just because while during without within through " +
    "against above below"
  ).split(" "),
);

/** 一段正文的英文化程度（数值只为可解释与可测试，界面不展示）。 */
export interface EnglishProbe {
  /** 拉丁字母数（去掉代码块之后）。 */
  latin: number;
  /** 汉字数。 */
  han: number;
  /** 其他字母（日文假名 / 韩文 / 西里尔等）。 */
  other: number;
  /** 英文单词数。 */
  words: number;
  /** 命中功能词的单词数。 */
  hits: number;
  /** 拉丁字母在全部字母里的占比。 */
  latinShare: number;
  /** 汉字占比。 */
  hanShare: number;
  /** 功能词命中率。 */
  stopRate: number;
}

const FENCE_RE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const OTHER_SCRIPT_RE =
  /\p{Script=Greek}|\p{Script=Cyrillic}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Arabic}|\p{Script=Devanagari}/gu;

/** 去掉代码块与行内代码：它们的「字母」不代表这段正文的语言。 */
function stripCode(text: string): string {
  return text.replace(FENCE_RE, " ").replace(INLINE_CODE_RE, " ");
}

/** 统计一段正文的英文化指标（纯函数，可单测）。 */
export function probeEnglish(raw: string): EnglishProbe {
  const text = stripCode(raw.slice(0, DETECT_SAMPLE));
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const other = (text.match(OTHER_SCRIPT_RE) ?? []).length;
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  let hits = 0;
  for (const word of words) if (STOPWORDS.has(word.toLowerCase())) hits += 1;
  const letters = latin + han + other;
  return {
    latin,
    han,
    other,
    words: words.length,
    hits,
    latinShare: letters === 0 ? 0 : latin / letters,
    hanShare: letters === 0 ? 0 : han / letters,
    stopRate: words.length === 0 ? 0 : hits / words.length,
  };
}

/**
 * 要不要给这段正文一个「翻译」按钮。
 *
 * 四个条件同时成立才算「大量英文」：
 *   - 拉丁字母 ≥ 200：太短的一段（"OK." / 一个路径）翻了没意义
 *   - 拉丁占比 ≥ 60%：中文为主的消息不该整段翻
 *   - 汉字占比 ≤ 20%：原文已经能读，翻译反而添乱
 *   - 功能词命中 ≥ 15 或命中率 ≥ 12%：把代码 / JSON / 工具名清单排除在外
 */
export function shouldOfferTranslation(text: string): boolean {
  if (text.trim() === "") return false;
  const probe = probeEnglish(text);
  return (
    probe.latin >= 200 &&
    probe.latinShare >= 0.6 &&
    probe.hanShare <= 0.2 &&
    (probe.hits >= 15 || probe.stopRate >= 0.12)
  );
}

/** 正文分段：代码块原样保留，只翻散文。 */
export interface TextSegment {
  kind: "code" | "prose";
  text: string;
}

const FENCE_LINE_RE = /^\s*(```|~~~)/;
/** 收尾围栏只允许「围栏 + 空白」：` ```js ` 是开栏（带语言标注），不是收栏。 */
const FENCE_CLOSE_RE = /^\s*(```|~~~)\s*$/;

/** 按 Markdown 围栏把正文切成「散文 / 代码」段（不丢任何内容）。 */
export function splitCodeSegments(text: string): TextSegment[] {
  const lines = text.split("\n");
  const segments: TextSegment[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let fence = "";
  const flush = (kind: "code" | "prose"): void => {
    if (buffer.length === 0) return;
    segments.push({ kind, text: buffer.join("\n") });
    buffer = [];
  };
  for (const line of lines) {
    const open = FENCE_LINE_RE.exec(line);
    if (!inCode && open) {
      flush("prose");
      inCode = true;
      fence = open[1]!;
      buffer.push(line);
      continue;
    }
    const close = FENCE_CLOSE_RE.exec(line);
    if (inCode && close && close[1] === fence) {
      buffer.push(line);
      flush("code");
      inCode = false;
      fence = "";
      continue;
    }
    buffer.push(line);
  }
  flush(inCode ? "code" : "prose");
  return segments;
}

/** 超长段落硬切：优先在句末，其次空白，最后按字符数。 */
function hardSplit(paragraph: string, limit: number): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const sentence = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    const space = window.lastIndexOf(" ");
    const cut = sentence > limit * 0.5 ? sentence + 1 : space > limit * 0.5 ? space + 1 : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim() !== "") out.push(rest);
  return out;
}

/** 散文按空行切块并累计到 `limit`；返回的块首尾无空白，拼回时用空行连接。 */
export function chunkProse(prose: string, limit = CHUNK_CHARS): string[] {
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current !== "") chunks.push(current);
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      flush();
      chunks.push(...hardSplit(paragraph, limit));
      continue;
    }
    if (current === "") current = paragraph;
    else if (current.length + 2 + paragraph.length <= limit) current = `${current}\n\n${paragraph}`;
    else {
      flush();
      current = paragraph;
    }
  }
  flush();
  return chunks;
}

/** 一次翻译的计划：要发出去的块 + 代码段位置 + 是否因过长而截断。 */
interface Plan {
  segments: TextSegment[];
  /** 散文段 → 该段切出的块（顺次消费）。 */
  proseChunks: string[][];
  truncated: boolean;
}

function planTranslation(text: string): Plan {
  const segments = splitCodeSegments(text);
  const proseChunks: string[][] = [];
  let budget = MAX_TRANSLATE_CHARS;
  let truncated = false;
  for (const segment of segments) {
    if (segment.kind === "code") {
      proseChunks.push([]);
      continue;
    }
    const chunks: string[] = [];
    for (const chunk of chunkProse(segment.text)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const clipped = chunk.length > budget ? chunk.slice(0, budget) : chunk;
      if (clipped.length < chunk.length) truncated = true;
      chunks.push(clipped);
      budget -= clipped.length;
    }
    proseChunks.push(chunks);
  }
  return { segments, proseChunks, truncated };
}

/** 译文缓存：key = 目标语言 + 原文，正文一变就不命中。 */
const cache = new Map<string, string>();

function cacheGet(text: string): string | undefined {
  return cache.get(`${TARGET}\n${text}`);
}

function cacheSet(text: string, translated: string): void {
  if (cache.size >= CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(`${TARGET}\n${text}`, translated);
}

/** 翻译结果：`text` 是拼回的完整正文（代码块原样），`truncated` = 超出预算、只翻了开头的部分。 */
export interface TranslationResult {
  text: string;
  truncated: boolean;
}

/**
 * 服务端单批条数上限：与网关 `translate-proxy.ts` 的 `MAX_TEXTS`（12）同值。
 * 块 ≤3000 字符（`chunkProse` 的上限），12 块 = 36000，天然在单批 40000 字符限内，
 * 所以按条数分批就够，不必再按字符数二次切。
 */
const MAX_BATCH_TEXTS = 12;

async function requestChunks(chunks: string[]): Promise<string[]> {
  // 分批是必须的：块按**段**切出、段间不合并，「代码块 + 一行解说」交替的正文
  // 很容易凑出 13+ 个散文段 —— 一把梭会被服务端按条数上限整批拒绝，重试也无解。
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i += MAX_BATCH_TEXTS) {
    const batch = chunks.slice(i, i + MAX_BATCH_TEXTS);
    const texts = await api.translate(batch);
    if (texts.length !== batch.length) {
      throw new Error("译文数量与原文块不一致");
    }
    out.push(...texts);
  }
  return out;
}

/**
 * 翻译一段正文（带缓存）。
 *
 * 请求按块批量发出：服务端一次转给翻译端点，避免几十次往返；
 * 块内保留代码块原样 —— 译文里贴代码是不能接受的。
 */
export async function translateText(text: string): Promise<TranslationResult> {
  const plan = planTranslation(text);
  const pending: Array<{ segment: number; chunk: number; text: string }> = [];
  plan.proseChunks.forEach((chunks, segment) => {
    chunks.forEach((chunk, index) => {
      if (cacheGet(chunk) === undefined) pending.push({ segment, chunk: index, text: chunk });
    });
  });
  if (pending.length > 0) {
    const translated = await requestChunks(pending.map((item) => item.text));
    pending.forEach((item, index) => cacheSet(item.text, translated[index]!));
  }
  const parts = plan.segments.map((segment, index) => {
    if (segment.kind === "code") return segment.text;
    const chunks = plan.proseChunks[index] ?? [];
    return chunks.map((chunk) => cacheGet(chunk) ?? chunk).join("\n\n");
  });
  return { text: parts.join("\n"), truncated: plan.truncated };
}

/** 清空译文缓存（测试用）。 */
export function clearTranslationCache(): void {
  cache.clear();
}
