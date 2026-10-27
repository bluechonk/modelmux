/**
 * 应用图标生成：Web 控制台的 favicon（白色鲸鱼剪影）→ 桌面图标资产。
 *
 * 输入 `packages/ui/src/assets/favicon.svg`（单色白、为深色底设计），
 * 输出 `resources/icon.png`（256×256）与 `resources/icon.ico`。
 *
 * ⚠ ICO 必须是**标准多尺寸 BMP-in-ICO**（16/24/32/48/64/128/256，32 位 BGRA +
 * AND mask）：曾用单尺寸 PNG-in-ICO，NSIS 安装时写 `uninstallerIcon.ico` 报
 * 「不能打开要写入的文件」—— Windows 图标 API 与 NSIS 对 PNG 压缩的 ICO 支持
 * 不一致，BMP-in-ICO 是唯一全兼容形态。
 *
 * 为什么要在 Node 里合成深色底：白色鲸鱼直接放浅色任务栏会看不见 ——
 * 底板取控制台深色主题的 #171717 + 圆角（与 UI 视觉语言一致）。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const favicon = readFileSync(
  path.join(repoRoot, "packages", "ui", "src", "assets", "favicon.svg"),
  "utf8",
);

// 取 favicon 里的两条 path（鲸鱼体 + 尾鳍），原 viewBox 是 24×24。
const paths = [...favicon.matchAll(/<path[^>]*\/>/g)].map((m) => m[0]);
if (paths.length === 0) throw new Error("favicon.svg 里没有 <path>");

const MASTER = 256;
const inner = Math.round(MASTER * 0.62);
const offset = Math.round((MASTER - inner) / 2);

/** 指定尺寸的合成 SVG（深底圆角 + 居中鲸鱼）。 */
function composedSvg(size) {
  const scale = size / MASTER;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="#171717"/>
  <g transform="translate(${Math.round((offset * scale))} ${Math.round((offset * scale))}) scale(${inner / 24})">
    ${paths.join("\n    ")}
  </g>
</svg>`;
}

const outDir = path.join(desktopRoot, "resources");
mkdirSync(outDir, { recursive: true });

// 主 PNG（橱窗/托盘用）
writeFileSync(
  path.join(outDir, "icon.png"),
  await sharp(Buffer.from(composedSvg(MASTER))).png().toBuffer(),
);

/** 一个尺寸的 32 位 BGRA 像素（自下而上，BMP 行序）+ AND mask（全 0 = 全由 alpha 决定）。 */
async function bmpImage(size) {
  const { data } = await sharp(Buffer.from(composedSvg(size)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // sharp 原始序是 RGBA 自上而下；转 BGRA 自下而上。
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = data[s + 2]; // B
      pixels[d + 1] = data[s + 1]; // G
      pixels[d + 2] = data[s]; // R
      pixels[d + 3] = data[s + 3]; // A
    }
  }
  // AND mask：1bpp，行按 4 字节对齐，全 0（透明度交给 32 位 alpha 通道）。
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // BITMAPINFOHEADER 大小
  header.writeInt32LE(size, 4); // 宽
  header.writeInt32LE(size * 2, 8); // 高（XOR + AND 两张位图）
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(0, 16); // 无压缩
  header.writeUInt32LE(pixels.length + mask.length, 20); // 图像数据大小
  return { blob: Buffer.concat([header, pixels, mask]), size };
}

const entries = [];
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  entries.push(await bmpImage(size));
}

// ICONDIR(6) + ICONDIRENTRY(16 × n) + 各尺寸 BMP 数据
const dir = Buffer.alloc(6 + entries.length * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // type = icon
dir.writeUInt16LE(entries.length, 4);
let dataOffset = dir.length;
const blobs = [];
for (const [i, e] of entries.entries()) {
  const p = 6 + i * 16;
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, p); // 256 记 0
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
  dir.writeUInt8(0, p + 2); // 调色板
  dir.writeUInt8(0, p + 3); // reserved
  dir.writeUInt16LE(1, p + 4); // planes
  dir.writeUInt16LE(32, p + 6); // bpp
  dir.writeUInt32LE(e.blob.length, p + 8);
  dir.writeUInt32LE(dataOffset, p + 12);
  dataOffset += e.blob.length;
  blobs.push(e.blob);
}
writeFileSync(path.join(outDir, "icon.ico"), Buffer.concat([dir, ...blobs]));

console.log(
  `[desktop-icon] resources/icon.png (${MASTER}px) + icon.ico（${entries.length} 尺寸 BMP-in-ICO）就绪`,
);

