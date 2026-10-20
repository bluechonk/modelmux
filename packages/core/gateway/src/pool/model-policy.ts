/**
 * 池模型策略：**全模型池**（放行各渠道暴露的全部真实模型）。
 *
 * 历史的「家族白名单 + 型号闸门」恒真（两张白名单都是空数组）且生产零调用，
 * 已连同 `pool/model-family.ts` 一起删除；池的实际收集口径见 `pool-targets.ts`
 * （各渠道 `exposedIds()` 的并集）。
 *
 * ⚠ 导出名 `modelFamily` 保留：多个渠道包的 `src/index.ts` 按名从共享层转出它，
 * 删掉会打断它们的构建 —— 本模块只声明策略，不承载任何过滤逻辑。
 */

/** 当前策略：放行全部模型（全模型池）。 */
export const POOL_POLICY = "all-models" as const;
