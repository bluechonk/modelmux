/**
 * 入站模型名解析：任意客户端模型名 → 池 id `<cid>/<模型>`（route.ts 调用）。
 *
 * 约束：解析顺序 = 剥 `[1m]` 后缀与 `modelmux/` 前缀 → 池 id 直认 → 别名 →
 * 裸名索引（多渠道命中取 cid 序第一个）→ 默认模型兜底；只读目录与注册表，
 * 不发上游请求。各形态的来源见 docs/CLIENT-INTEGRATION.md。
 */

import { parsePoolModel, canonicalModelId, buildCrossModelIndex, poolModelId } from "./pool-targets.js";
import { channels } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readRouterConfig } from "../runtime/model-router.js";

/** 一次解析的结果；`target` 为 null 时 `error` 是给人看的 400 文案。 */
export interface InboundModelResolution {
  target: string | null;
  /** 命中途径（诊断用；`pool` = 本来就是池 id，无需解析）。 */
  via: "pool" | "alias" | "bare" | "default";
  error?: string;
}

/** `modelmux/` 前缀（Codex catalog 三段写法的遗产形态）。 */
const SELF_PREFIX = /^modelmux\//i;

/**
 * 裸名 → 池 id：先查跨渠道索引，未命中再直扫渠道目录。
 *
 * 直扫兜底与 `poolCandidates` 同款理由：索引有 30s TTL，渠道刚注册/目录刚变时
 * 索引可能还没跟上 —— 裸名解析不能因此丢 30 秒。多渠道命中取 cid 序第一个
 * （确定性结果比「看心情」强；想指定渠道就用池 id 显式写）。
 */
function bareNameTarget(name: string): string | null {
  const wanted = canonicalModelId(name);
  const viaIndex = buildCrossModelIndex().get(wanted);
  if (viaIndex && viaIndex.exposed.length > 0) {
    const first = [...viaIndex.exposed].sort((a, b) => a.cid.localeCompare(b.cid))[0]!;
    return poolModelId(first.cid, first.exposedId);
  }
  const hits: Array<{ cid: string; exposedId: string }> = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        return channel.catalog.exposedIds() as string[];
      } catch {
        return [] as string[];
      }
    });
    const hit = ids.find((id) => canonicalModelId(id) === wanted);
    if (hit !== undefined) hits.push({ cid, exposedId: hit });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.cid.localeCompare(b.cid));
  return poolModelId(hits[0]!.cid, hits[0]!.exposedId);
}

export function resolveInboundModel(raw: string): InboundModelResolution {
  let name = raw.trim();
  // [1m] 后缀：Claude Code 的 1M 窗口标记（CCR 同款约定），池 id 里不存在
  name = name.replace(/\[1m\]$/i, "").trim();
  name = name.replace(SELF_PREFIX, "");
  if (!name) {
    return { target: null, via: "pool", error: "model name is empty" };
  }

  if (name.includes("/")) {
    const parsed = parsePoolModel(name);
    if (!parsed) {
      return {
        target: null,
        via: "pool",
        error: `unknown model ${raw}; 请用 <渠道>/<模型> 形态（模型清单见 GET /v1/models）`,
      };
    }
    return { target: `${parsed.cid}/${parsed.model}`, via: "pool" };
  }

  const config = readRouterConfig();

  // 别名：键在注册表读入时已统一小写
  const aliased = config.aliases?.[name.toLowerCase()];
  if (aliased) {
    const parsed = parsePoolModel(aliased);
    if (parsed) return { target: `${parsed.cid}/${parsed.model}`, via: "alias" };
    // 别名值坏了不该静默吞掉 —— 落到默认模型，让请求继续走
  }

  // 裸名：跨渠道索引按规范名精确命中（索引键即 canonicalModelId 的产物）
  const bare = bareNameTarget(name);
  if (bare) return { target: bare, via: "bare" };

  const fallback = config.default;
  if (fallback) {
    const parsed = parsePoolModel(fallback);
    if (parsed) return { target: `${parsed.cid}/${parsed.model}`, via: "default" };
  }
  return {
    target: null,
    via: "bare",
    error: `unknown model ${raw}; 可在控制台「接入路由」为它配别名，或设置默认模型兜底（模型清单见 GET /v1/models）`,
  };
}
