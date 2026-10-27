/**
 * 应用图标生成：Web 控制台的 favicon（白色鲸鱼剪影）→ 桌面图标资产。
 *
 * 输入 `packages/ui/src/assets/favicon.svg`（单色白、为深色底设计），
 * 输出 `resources/icon.png`（256×256）与 `resources/icon.ico`（PNG-in-ICO，
 * Vista+ 格式，electron-builder 的 win.icon 用）。
 *
 * 为什么要在 Node 里合成深色底：白色鲸鱼直接放浅色任务栏会看不见 ——
 * 底板取控制台深色主题的 #171717 + 圆角（与 UI 视觉语言一致）。
 *
 * ICO 容器手写（22 字节头 + 内嵌 PNG），不引额外依赖；sharp 只做 SVG 栅格化。
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

const SIZE = 256;
// 鲸鱼占画布 ~62%，居中（原 24 网格 → 目标 159px，偏移使几何中心对齐）。
const inner = Math.round(SIZE * 0.62);
const offset = Math.round((SIZE - inner) / 2);

const composed = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="${Math.round(SIZE * 0.22)}" fill="#171717"/>
  <g transform="translate(${offset} ${offset}) scale(${inner / 24})">
    ${paths.join("\n    ")}
  </g>
</svg>`;

const outDir = path.join(desktopRoot, "resources");
mkdirSync(outDir, { recursive: true });

const png = await sharp(Buffer.from(composed)).png().toBuffer();
writeFileSync(path.join(outDir, "icon.png"), png);

// PNG-in-ICO：ICONDIR(6) + ICONDIRENTRY(16) + PNG 数据。
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type = icon
ico.writeUInt16LE(1, 4); // count
ico.writeUInt8(0, 6); // width 0 = 256
ico.writeUInt8(0, 7); // height 0 = 256
ico.writeUInt8(0, 8); // 调色板
ico.writeUInt8(0, 9); // reserved
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bpp
ico.writeUInt32LE(png.length, 14); // PNG 字节数
ico.writeUInt32LE(22, 18); // 数据偏移
writeFileSync(path.join(outDir, "icon.ico"), Buffer.concat([ico, png]));

console.log(`[desktop-icon] resources/icon.png (${SIZE}px) + icon.ico 就绪`);
