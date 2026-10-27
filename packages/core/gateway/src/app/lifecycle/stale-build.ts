/**
 * 「跑着的网关是不是旧代码」检测。
 *
 * `npm run build` 只更新 `dist/`、**不会**重启守护进程 —— 静默陈旧会让人把
 * 「改了没生效」误诊成登录/凭证问题（事故记录见 docs/CONTRACT-TS.md §8），
 * 必须由工具主动报出。判据：
 *
 *   max(dist/**\/*.js 的 mtime) > pid 文件 mtime  →  进程比代码旧 → 需要 restart
 *
 * 用 pid 文件 mtime 而非「进程启动时间」：后者要平台相关调用，pid 文件是
 * `start` 亲手写的，时刻等价且零依赖。⚠ 只读、不重启：报告事实，重启由调用方决定。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 检测结果。`stale: false` 时其余字段为 null。 */
export interface StaleBuildReport {
  /** 构建产物是否比守护进程新。 */
  stale: boolean;
  /** 最新构建产物的 mtime（毫秒）。 */
  buildMs: number | null;
  /** 守护进程启动时刻（pid 文件 mtime，毫秒）。 */
  pidMs: number | null;
}

const NOT_STALE: StaleBuildReport = { stale: false, buildMs: null, pidMs: null };

/**
 * 从 `start` 向上找**工作区根**：带 `workspaces` 清单的 `package.json`。
 *
 * 判据只认 `workspaces` 字段本身，与具体目录布局解耦 —— 布局变了也不用改这里。
 *
 * 有 `node_modules` 的祖先目录跳过，避免误认依赖包里的 `package.json`。
 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (dir.split(/[\\/]/).includes("node_modules")) {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      const raw = parsed.workspaces;
      const list: unknown = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? (raw as { packages?: unknown }).packages
          : null;
      if (Array.isArray(list) && list.some((p) => typeof p === "string")) return dir;
    } catch {
      /* 没有 package.json 或不是 JSON：继续往上 */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 本包在磁盘上的位置（`dist/` 的上一级 = 包根）。 */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * 收集「可能被网关加载」的构建产物时间戳。
 *
 * 范围：工作区内每个包/渠道的 `dist/**\/*.js` 的最新 mtime。
 * 找不到工作区根时退化为「只管本包 dist」—— 宁可少报，也不误报。
 */
function newestBuildMs(root: string | null): number | null {
  const dirs: string[] = [];
  if (root) {
    // 显式列出**全部包目录**（含嵌套的 packages/core/*）——
    // 早期用「顶层 groups 遍历一层」的写法，core 下沉后 gateway 会被漏掉，
    // 导致「跑旧代码」检测对共享层失明。
    for (const group of ["packages/cli", "packages/ui", "packages/core/gateway"]) {
      dirs.push(join(root, group, "dist"));
    }
    // 渠道包是 core/channels 下的一层（数量随渠道增减，故动态列）
    try {
      for (const name of readdirSync(join(root, "packages/core/channels"))) {
        dirs.push(join(root, "packages/core/channels", name, "dist"));
      }
    } catch {
      /* 目录不存在时忽略（如打包后的单渠道环境） */
    }
  } else {
    dirs.push(join(packageRoot(), "dist"));
  }

  let newest: number | null = null;
  const walk = (dir: string, depth = 0): void => {
    if (depth > 2) return;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      try {
        const ms = statSync(path).mtimeMs;
        if (newest === null || ms > newest) newest = ms;
      } catch {
        /* 读不到就跳过 */
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return newest;
}

/**
 * 判断「正在跑的守护进程」是否在跑旧代码。
 *
 * @param pidPath  守护进程的 pid 文件（它的 mtime = 进程启动时刻）
 * @param start    起点目录（默认为本包位置，用于向上找工作区根）
 */
export function detectStaleBuild(pidPath: string, start?: string): StaleBuildReport {
  let pidMs: number;
  try {
    pidMs = statSync(pidPath).mtimeMs;
  } catch {
    return NOT_STALE; // 没有 pid 文件 = 没有守护进程在跑，无从谈「旧」
  }
  const buildMs = newestBuildMs(findWorkspaceRoot(start ?? packageRoot()));
  if (buildMs === null) return NOT_STALE;
  // 留 1s 容差：start 与 build 可能在同一秒内完成，避免抖动误报
  return { stale: buildMs > pidMs + 1000, buildMs, pidMs };
}

/** 一行人话（供 status 直接打印）。 */
export function staleBuildHint(report: StaleBuildReport): string {
  if (!report.stale) return "";
  const at = (ms: number | null): string =>
    ms === null ? "?" : new Date(ms).toLocaleString("zh-CN", { hour12: false });
  return (
    `⚠ 网关在跑旧代码：构建产物 ${at(report.buildMs)} 比进程启动 ${at(report.pidMs)} 新。` +
    `跑 \`mx restart\` 让修复生效（否则测到的还是旧行为）。`
  );
}
