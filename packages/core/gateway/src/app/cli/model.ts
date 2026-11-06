/**
 * `model` 命令组：池视图（list / usage）、本地目录、可登录渠道列表。
 *
 * 从 `command-groups.ts` 拆出。本文件同时承载**命令层共享的上下文与目录工具**
 * （`CommandContext` / `ensureCatalog` / `originNote`）—— 渠道动词组也依赖它们，
 * 依赖方向为单向：`channel-verbs.ts` → 本文件。
 */

import { channelCapabilities, channels, type Channel } from "../../runtime/channel.js";
import { runInChannel } from "../../runtime/channel-context.js";
import { catalogCacheFetchedAt } from "../../runtime/catalog-cache.js";
import { canonicalModelId, getChannelModelMeta, getPoolModelMeta, poolCandidates, poolModels } from "../../pool/pool-targets.js";
import { DEEPSEEK_MODEL_IDS, canonicalOf, isDeepseekModel } from "../../pool/model-family.js";
import { ledgerSnapshot, refreshBilling, totalRemainOf } from "../../pool/pool-usage.js";
import { poolUsagePath } from "../../runtime/paths.js";
import { readModelSpecs } from "../../runtime/model-specs.js";
import {
  catalogSourceStats,
  refreshCatalog as refreshPoolCatalog,
} from "../../pool/catalog-snapshot.js";
import * as daemon from "../lifecycle/daemon.js";
import * as headless from "../lifecycle/headless.js";
import * as report from "./report.js";

export interface CommandContext {
  json: boolean;
  quiet: boolean;
  addr: string;
  uiPort: number;
  realm: string;
  force: boolean;
  /** `model <cid>` / `model usage` 的 `--refresh`：强制重拉上游目录。 */
  refresh: boolean;
  /** `login --wechat`：微信扫码登录（渠道声明 loginWechat 才支持）。 */
  wechat: boolean;
  lines: number;
  /** `paths`：统计工作区内全部渠道。 */
  all: boolean;
  /** `bill --accounts`：强制逐账号列额度（池内单账号时也列）。 */
  accounts: boolean;
  /** `logs`：持续输出新增日志。 */
  follow: boolean;
  /** `logs --kind`：access / error / system / lifecycle / worker / channel。 */
  logKind?: string;
  /** `logs --outcome`：success / failure（仅 access；历史 `other` 已并入 failure）。 */
  logOutcome?: "success" | "failure";
  /** `logs --date YYYY-MM-DD`。 */
  logDate?: string;
  /** `logs --list`：列出日志文件。 */
  logList: boolean;
  /** `logs --compact`：就地压缩已封存的抓取正文（存量明文 → 压缩）。 */
  logCompact: boolean;
  workspace?: string;
}

/** 渠道动词（供帮助文本与未知动词提示）。语法一律 `mx <动词> [<cid>] [参数]`。 */

type CatalogOrigin =
  /** 命中 `cache/models.json`（上次真实拉取的结果）—— 常态，零网络。 */
  | { kind: "cache"; fetchedAt: string | null }
  /** 本地没有缓存，刚刚拉了一次并落盘。 */
  | { kind: "fetched" }
  /** 该渠道没有远端目录层（目录就是内置表）。 */
  | { kind: "builtin" }
  /** 想拉但没成功（未登录 / 网络 / 上游拒绝）—— 回落内置表。 */
  | { kind: "failed"; reason: string };

/**
 * 确保目录可用：**缓存优先，只有本地没有缓存时才拉一次**。
 *
 * 这是「第一次 `model list` 把真实目录记到本地，之后一直用那个文件」的实现点：
 * - 有 `cache/models.json` → 直接用它，**不打网络**（所以离线/未登录也能列出真实目录）；
 * - 没有缓存 → 拉一次并落盘（渠道的 `refresh()` 内部负责写缓存）；
 * - 拉失败 → 回落渠道内置表，并把原因回报给调用方（**不抛错**，列表本身仍要能打）。
 *
 * `force = true`（CLI 的 `--refresh`）跳过「缓存优先」直接重拉，且**失败即抛错** ——
 * 用户显式要求刷新时，看到一张旧表却以为刷成功了是最坏的结果。
 */

async function ensureCatalog(
  channel: Channel,
  force: boolean,
): Promise<{ origin: CatalogOrigin; error?: Error }> {
  const cid = channel.config.cid;
  const refresh = channel.catalog.refresh;

  if (force) {
    if (!refresh) return { origin: { kind: "builtin" } };
    try {
      await runInChannel(cid, () => refresh());
      return { origin: { kind: "fetched" } };
    } catch (err) {
      return { origin: { kind: "failed", reason: String(err) }, error: err as Error };
    }
  }

  const fetchedAt = catalogCacheFetchedAt(cid);
  if (fetchedAt) return { origin: { kind: "cache", fetchedAt } };
  if (!refresh) return { origin: { kind: "builtin" } };
  try {
    await runInChannel(cid, () => refresh());
    return { origin: { kind: "fetched" } };
  } catch (err) {
    return { origin: { kind: "failed", reason: String(err) } };
  }
}

/** 目录来源的一句话说明（`--json` 之外的输出用；缓存命中时附拉取时刻）。 */

function originNote(origin: CatalogOrigin): string {
  switch (origin.kind) {
    case "cache":
      return origin.fetchedAt ? `本地缓存（拉取于 ${origin.fetchedAt}）` : "本地缓存";
    case "fetched":
      return "刚从上游拉取并已记录到本地";
    case "builtin":
      return "该渠道的模型表是内置的，没有远端可刷新";
    case "failed":
      return `未能从上游拉取（${origin.reason}），下面是内置表；加 --refresh 可重试`;
  }
}

/**
 * `model <cid>`：该渠道能供给哪些**对外模型**（deepseek 家族，裸模型名）。
 *
 * 渠道目录里不属于家族、或不能对外暴露的条目只报数量（可能几十条，全列是噪音）。
 */

export async function listLocalModels(
  channel: Channel,
  json: boolean,
  force: boolean,
): Promise<number> {
  const cid = channel.config.cid;
  const { origin, error } = await ensureCatalog(channel, force);
  // 显式刷新失败要如实报错，不能让用户以为刷新成功了
  if (force && error) {
    console.error(`${cid}: 刷新模型目录失败：${error.message}`);
    return 1;
  }
  // 匹配用目录里的**原始写法**（见 pool-targets.ts 的说明）；展示与去重分开处理
  let catalogBroken = false;
  const catalogIds = runInChannel(cid, () => {
    try {
      return channel.catalog.exposedIds();
    } catch (err) {
      // 目录读失败 ≠ 渠道没有模型：静默回落空数组会把「读错误」伪装成
      // 「该渠道没有可对外暴露的模型」的事实陈述。留痕并标注。
      console.error(`[model] 目录读取失败（${cid}）：${String(err)}`);
      catalogBroken = true;
      return [] as string[];
    }
  });
  // 只列 deepseek 家族：网关对外只提供这几个，渠道目录里的其余条目不属于对外模型池
  const family = catalogIds.filter((id) => isDeepseekModel(id));
  // 渠道内先按规范名去重：同一渠道的不同原始写法收敛为同一个对外模型名
  const contributed = [...new Map(family.map((id) => [canonicalModelId(id), id])).values()];

  // 倍率取**本渠道**的值（同一模型在不同渠道倍率可能不同），无倍率时为 "-"
  const rows = contributed.map((exposedId) => {
    const rate = getChannelModelMeta(cid, exposedId).multiplier;
    return { model: canonicalModelId(exposedId), exposed_id: exposedId, rate: rate === null ? "-" : String(rate) };
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          cid,
          display: channel.upstream.DISPLAY_NAME,
          source: origin.kind,
          ...(origin.kind === "cache" && origin.fetchedAt
            ? { fetched_at: origin.fetchedAt }
            : {}),
          ...(origin.kind === "failed" ? { reason: origin.reason } : {}),
          ...(catalogBroken ? { catalog_error: "exposedIds() threw; see stderr" } : {}),
          pool_models: rows,
          out_of_pool_count: 0,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  // 数据走 stdout（便于管道），**来源说明走 stderr**：缓存命中是常态，不必打扰；
  // 其余情形（刚拉取 / 拉取失败 / 内置表）用户需要知道自己在看哪份数据。
  if (origin.kind !== "cache") console.error(`${cid}: ${originNote(origin)}`);
  if (rows.length === 0) {
    console.log(catalogBroken ? `${cid}: 目录读取失败，模型列表不可用（见上方错误）` : `${cid}: 该渠道没有可对外的 deepseek 模型`);
  } else {
    console.log(`${cid} 的 deepseek 模型（客户端用裸模型名请求，网关按额度挑渠道）：`);
    for (const row of rows) {
      console.log(`  ${row.model.padEnd(22)} ×${row.rate.padStart(5)} ← ${row.exposed_id}`);
    }
  }
  return 0;
}

/**
 * `model list`：**公共模型池视图** —— 每个对外模型（deepseek 裸名）与能供给它的渠道。
 *
 * 渠道由网关按账号池剩余额度自动挑（`poolCandidates` 已排好序），这里按模型分组，
 * 逐渠道列出剩余额度 / 账本状态，回答「这个模型现在能从哪几家出、谁还有货」。
 */

export async function listPoolModels(json: boolean): Promise<number> {
  if (channels().length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const now = Date.now();
  const ledger = ledgerSnapshot();
  const rows = poolModels().map((model) => ({
    model,
    candidates: poolCandidates(model).map((candidate) => {
      const entry = ledger.channels[candidate.cid];
      return {
        cid: candidate.cid,
        display: candidate.channel.upstream.DISPLAY_NAME,
        exposed_id: candidate.exposedId,
        remain: totalRemainOf(candidate.cid),
        used: entry?.used ?? 0,
        unit: entry?.unit ?? "",
        cooling: (entry?.cooldown_until ?? 0) > now,
        ok: entry?.ok ?? 0,
        fail: entry?.fail ?? 0,
        billing_at: entry?.billing_at ?? null,
      };
    }),
  }));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  console.log(
    `公共模型池  ${rows.length} 个模型（客户端用裸模型名请求，网关按账号池剩余额度挑渠道）\n`,
  );
  for (const row of rows) {
    console.log(`${row.model}  ${row.candidates.length} 个渠道`);
    for (const candidate of row.candidates) {
      const remain = candidate.remain === null ? "-" : `${candidate.remain}${candidate.unit ? ` ${candidate.unit}` : ""}`;
      const marks = [
        candidate.cooling ? "冷却中" : "",
        candidate.ok > 0 ? `ok=${candidate.ok}` : "",
        candidate.fail > 0 ? `fail=${candidate.fail}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      console.log(
        `  ${candidate.cid.padEnd(12)} remain=${remain.padEnd(16)} ← ${candidate.exposed_id}${marks ? `  ${marks}` : ""}`,
      );
    }
    console.log();
  }
  console.log(`账本: ${poolUsagePath()}（账单额度每 8 小时自动刷一次；--refresh 立刻重查）`);
  return 0;
}

/**
 * `login list`：列出**可以登录哪些渠道**与各自的登录状态（只读，不需要网关）。
 *
 * - 口径与 `status` 的逐渠道凭证探测一致：`cred.load()` 成功 = 已登录
 *   （渠道知识零新增 —— 这里只调渠道自己的 `cred.load()`，不解释凭证内容）。
 * - 输出里只带 `uid` 这类不透明的身份标识，不回显手机号/昵称等个人信息。
 */

export async function listLogins(json: boolean): Promise<number> {
  const list = channels();
  if (list.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const identityOf = (cred: unknown): string => {
    if (!cred || typeof cred !== "object") return "";
    const record = cred as Record<string, unknown>;
    for (const key of ["uid", "userid", "userId"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const rows = list.map((channel) => {
    const cid = channel.config.cid;
    let loggedIn = false;
    let uid = "";
    try {
      uid = identityOf(runInChannel(cid, () => channel.cred.load()));
      loggedIn = true;
    } catch {
      loggedIn = false;
    }
    return { cid, display: channel.upstream.DISPLAY_NAME, logged_in: loggedIn, uid };
  });

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const logged = rows.filter((r) => r.logged_in).length;
  console.log(`${list.length} 个渠道可登录（已登录 ${logged} 个，未登录 ${list.length - logged} 个）：`);
  for (const row of rows) {
    const status = row.logged_in ? `已登录${row.uid ? `  uid=${row.uid}` : ""}` : "未登录";
    console.log(`  ${row.cid.padEnd(12)} ${row.display.padEnd(18)} ${status}`);
  }
  console.log("登录某个渠道：`mx login <cid>`（重新授权用 `mx relogin <cid>`）。");
  return 0;
}

/** `model <list|usage|spec> [--refresh]`。 */

export async function runModelGroup(args: string[], ctx: CommandContext): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
      return listPoolModels(ctx.json);
    case "usage":
      return showPoolUsage(ctx.json, ctx.refresh);
    case "spec":
      return showModelSpec(args[1] ?? "", ctx.json);
    case "refresh":
      return refreshModelCatalog(ctx.json);
    default:
      console.error(`未知的 model 子命令: ${sub}（可用: list / usage / spec / refresh）`);
      return 2;
  }
}

/**
 * `model refresh`：用当前渠道目录与 `model-specs.json` 重建统一快照。
 *
 * 快照落点 `<root>/model-catalog.json`，`/v1/models` 直接读它（见 docs/MODEL-CATALOG.md）。
 */

async function refreshModelCatalog(json: boolean): Promise<number> {
  const catalog = refreshPoolCatalog();
  const count = Object.keys(catalog.models).length;
  const stats = catalogSourceStats(catalog);
  if (json) {
    console.log(JSON.stringify({ generated_at: catalog.generated_at, models: count, sources: stats }, null, 2));
    return 0;
  }
  console.log(`模型目录已刷新：${count} 个模型（${catalog.generated_at}）`);
  for (const [source, n] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(12)} ${n}`);
  }
  return 0;
}

/**
 * `model spec <model>`：查看某 deepseek 模型的规格（窗口/输出/档位/倍率/输入模态）。
 *
 * `<model>` 是裸模型名（如 `deepseek-v4-flash`）。同时给出**聚合值**（跨渠道合并，
 * 供客户端声明能力）与**逐渠道值**（各渠道上游目录的真值，倍率可能不同）。
 */

async function showModelSpec(model: string, json: boolean): Promise<number> {
  if (!model) {
    console.error("model spec 需要指定模型名");
    return 2;
  }
  const canonical = canonicalOf(model);
  if (!canonical) {
    console.error(`未知模型：${model}（可用：${DEEPSEEK_MODEL_IDS.join(" / ")}）`);
    return 2;
  }

  const globalSpecs = readModelSpecs();
  const globalEntry = globalSpecs.models[canonical];
  const meta = getPoolModelMeta(canonical);
  const candidates = poolCandidates(canonical).map((candidate) => {
    const channelMeta = getChannelModelMeta(candidate.cid, candidate.exposedId);
    return {
      cid: candidate.cid,
      exposed_id: candidate.exposedId,
      contextWindow: channelMeta.contextWindow,
      maxOutputTokens: channelMeta.maxOutputTokens,
      inputModalities: channelMeta.inputModalities,
      outputModalities: channelMeta.outputModalities,
      effort: channelMeta.effort,
      multiplier: channelMeta.multiplier,
      sources: channelMeta.sources,
    };
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          model: canonical,
          aggregate: {
            contextWindow: meta.contextWindow,
            maxOutputTokens: meta.maxOutputTokens,
            inputModalities: meta.inputModalities,
            outputModalities: meta.outputModalities,
            effort: meta.effort,
            multiplier: meta.multiplier,
            sources: meta.sources,
          },
          channels: candidates,
          global_spec: globalEntry ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`模型: ${canonical}`);
  console.log(`\n聚合规格（跨渠道合并；窗口/输出取最小，档位取交集）：`);
  console.log(`  最大上下文  ${meta.contextWindow.toLocaleString()}`);
  console.log(`  输出上限    ${meta.maxOutputTokens.toLocaleString()}`);
  console.log(`  输入模态    ${meta.inputModalities.join(", ")}`);
  console.log(`  思考模式    ${meta.effort ? `${meta.effort.supportedLevels.join(", ")}（默认 ${meta.effort.defaultLevel}）` : "未声明"}`);
  console.log(`  来源        ctx=${meta.sources.contextWindow} out=${meta.sources.maxOutputTokens} effort=${meta.sources.effort}`);

  if (globalEntry) {
    console.log(`\n全局规格（model-specs.json）：`);
    if (globalEntry.contextWindow !== undefined) console.log(`  最大上下文  ${globalEntry.contextWindow.toLocaleString()}`);
    if (globalEntry.maxOutputTokens !== undefined) console.log(`  输出上限    ${globalEntry.maxOutputTokens.toLocaleString()}`);
    if (globalEntry.inputModalities) console.log(`  输入模态    ${globalEntry.inputModalities.join(", ")}`);
    if (globalEntry.effort) console.log(`  思考模式    ${globalEntry.effort.supportedLevels.join(", ")}（默认 ${globalEntry.effort.defaultLevel}）`);
    if (globalEntry.multiplier !== undefined) console.log(`  倍率        ${globalEntry.multiplier}`);
    if (globalEntry._source) console.log(`  来源        ${globalEntry._source}`);
    if (globalEntry._updated) console.log(`  更新于      ${globalEntry._updated}`);
  }

  if (candidates.length === 0) {
    console.log(`\n渠道：当前没有渠道供给这个模型（未登录 / 目录未就绪，见 mx model list）`);
  } else {
    console.log(`\n渠道（按账号池剩余额度降序）：`);
    for (const candidate of candidates) {
      console.log(
        `  ${candidate.cid.padEnd(12)} ×${candidate.multiplier ?? "-"}  ← ${candidate.exposed_id}` +
          `  ctx=${candidate.contextWindow.toLocaleString()} out=${candidate.maxOutputTokens.toLocaleString()}`,
      );
    }
  }
  return 0;
}

/**
 * `model usage [--refresh]`：看**池账本**；`--refresh` 立刻重查一遍各渠道账单。
 *
 * 与 `model list` 的分工：
 * - `model list` = **哪些模型可用**（逐个模型列出，196 行）；
 * - `model usage` = **各渠道用得怎么样**（逐个渠道一行，十几行）。
 *
 * 账本不再决定路由（渠道由池 id 前缀指定），所以这里只回答「哪个渠道在被用、
 * 哪个在冷却」——不再重复列出 196 个模型。
 */

export async function showPoolUsage(json: boolean, force = false): Promise<number> {
  if (force) {
    const result = await refreshBilling((m) => {
      if (!json) console.error(m);
    });
    if (!json) {
      const failed = result.failed.map((f) => f.cid).join("、");
      console.error(
        `账单已刷新：成功 ${result.refreshed.length} 个渠道` +
          (result.failed.length > 0 ? `，失败 ${result.failed.length} 个（${failed}）` : ""),
      );
    }
  }

  const now = Date.now();
  const ledger = ledgerSnapshot();
  const list = channels();
  if (json) {
    console.log(
      JSON.stringify(
        list.map((channel) => {
          const entry = ledger.channels[channel.config.cid];
          return {
            cid: channel.config.cid,
            display: channel.upstream.DISPLAY_NAME,
            used: entry?.used ?? 0,
            unit: entry?.unit ?? "",
            ok: entry?.ok ?? 0,
            fail: entry?.fail ?? 0,
            cooling: (entry?.cooldown_until ?? 0) > now,
            billing_at: entry?.billing_at ?? null,
            unsupported: !channelCapabilities(channel.config).billing,
          };
        }),
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`池账本  ${list.length} 个渠道（账单额度每 8 小时自动刷一次）\n`);
  for (const channel of list) {
    const cid = channel.config.cid;
    const entry = ledger.channels[cid];
    const unsupported = !channelCapabilities(channel.config).billing;
    const used = unsupported ? "-" : `${entry?.used ?? 0}${entry?.unit ? ` ${entry.unit}` : ""}`;
    const marks = [
      (entry?.cooldown_until ?? 0) > now ? "冷却中" : "",
      entry && entry.ok > 0 ? `ok=${entry.ok}` : "",
      entry && entry.fail > 0 ? `fail=${entry.fail}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`${cid.padEnd(12)} used=${used.padEnd(18)} ${marks}`);
  }
  console.log(`\n账本: ${poolUsagePath()}`);
  return 0;
}

/** 渠道动词名集合（`mx <动词> [<cid>]` 的第一参数）。 */
