/**
 * 仓库版本号：全仓唯一的版本常量（形如 `0.1.4`）。
 *
 * 由根 `package.json` 的 `version` 经 `npm run version:sync`（`scripts/version.mjs`）派生而来，
 * **不要手改** —— 改根版本后跑一次同步即可；`scripts/verify-contract.mjs` 会在漂移时让 `npm test` 变红。
 */
export const VERSION = "0.1.4";
