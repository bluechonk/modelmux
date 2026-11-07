/**
 * 请求上下文里的「非文本内容」判定与描述（弹窗只报类型与体积，不铺内容）。
 *
 * 约束：① 判据必须宽进 —— 解不开的截断 base64 片段一样不该铺（铺了就是 base64 墙）；
 * ② 体积按 media type 与解码后的字节数算，不数 base64 字符数（4 字符≈3 字节）。
 */

/** data URL 的媒体类型前缀（`data:image/png;base64,`）。 */
const DATA_URL = /^data:([a-z0-9.+-]+)\/[a-z0-9.+-]+;base64,/i;

/**
 * 是不是「不该按文本铺开」的内容：data URL（图片/音频/PDF…）或裸 base64 长串。
 *
 * 实测（2026-11-06）：一条 agent 上下文里有 23 张图片、单张 6 万字符 —— 直接铺出来
 * 整屏都是 base64，正文一个字看不见；tool 结果里 33945 字符的裸 base64 同理。
 *
 * 单看噪声比会误吞自然语言：标点稀少的英文 prompt（噪声比 0.041，2026-11-07）也
 * 过得了初筛 —— 所以先看空白比（prose 15%+，连续 base64 体近乎为零），再做解码
 * 抽样定夺（真二进制解回来几乎全是控制字节）。
 */
export function looksBinaryish(text: string): boolean {
  if (text.length < 256) return false;
  if (DATA_URL.test(text.trim())) return true;
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 256) return false;
  if (text.length - compact.length >= text.length * 0.05) return false;
  const noise = compact.replace(/[A-Za-z0-9+/=]/g, "").length;
  if (noise / compact.length >= 0.05) return false;
  return printableRatioAfterDecode(compact) < 0.9;
}

/**
 * base64 解码抽样：解码后几乎全是控制字节（\0、私有区…）才是真二进制。
 * 文本内容的 base64 解回来仍是可读文本（含 UTF-8 多字节），不会被误判。
 * 截断 base64（长度非 4 倍数）用 'A'（值 0）补齐末组，只影响抽样尾部几个字节；
 * 噪声字符残留导致 atob 抛错时按「像二进制」处理（宽进约束）。
 */
function printableRatioAfterDecode(compact: string): number {
  const sample = compact.slice(0, 2048);
  const padded = sample.padEnd(Math.ceil(sample.length / 4) * 4, "A");
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return 0;
  }
  if (bin.length === 0) return 0;
  let printable = 0;
  for (let i = 0; i < bin.length; i += 1) {
    const byte = bin.charCodeAt(i);
    if ((byte >= 0x20 && byte < 0x7f) || byte >= 0x80 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
    }
  }
  return printable / bin.length;
}

/** 一段二进制内容的展示描述（`label` 给人看，`bytes` 是解码后的体积）。 */
export interface BinaryInfo {
  label: string;
  bytes: number;
}

/** `data:` URL → 媒体类型描述 + 原始字节数；非 data URL 按通用二进制片段处理。 */
export function describeBinary(url: string): BinaryInfo {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(url.trim());
  if (!match) return { label: "二进制片段", bytes: url.length };
  const media = match[1]!;
  const kind = media.startsWith("image/")
    ? "图片"
    : media.startsWith("audio/")
      ? "音频"
      : media.startsWith("video/")
        ? "视频"
        : "二进制片段";
  const payload = match[2]!.replace(/\s+/g, "").length;
  return { label: `${kind} ${media}`, bytes: Math.floor((payload * 3) / 4) };
}

/** 裸 base64 串的原始字节数估算（4 字符 ≈ 3 字节）。 */
export function estimateBytes(text: string): number {
  return Math.floor((text.replace(/\s+/g, "").length * 3) / 4);
}
