/**
 * 接入「模型有更新」判据：标记文件记下接入时写入的模型清单，integrationUpdates
 * 与当前对外清单做集合 diff；接入 / 还原对标记与更新态的影响。
 *
 * 全程临时 HOME（USERPROFILE / HOME）+ 临时 MODELMUX_HOME：integrate 写的是
 * 客户端配置（~/.zcode 等），绝不碰真实文件。无渠道注册 → 当前对外清单 =
 * POOL_EXPOSED_IDS（确定性）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  integrateClient,
  integrationStatus,
  integrationUpdates,
  restoreClient,
} from "../dist/app/integrate.js";
import { POOL_EXPOSED_IDS } from "../dist/pool/model-family.js";

let home = "";
let root = "";
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const key of ["USERPROFILE", "HOME", "MODELMUX_HOME"]) saved[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "modelmux-integrate-upd-home-"));
  root = mkdtempSync(join(tmpdir(), "modelmux-integrate-upd-root-"));
  process.env["USERPROFILE"] = home;
  process.env["HOME"] = home;
  process.env["MODELMUX_HOME"] = root;
  // zcode 接入要求 ~/.zcode/v2/provider_config.json 已存在（没装 zcode 会如实报错），先种一个最小配置
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(join(home, ".zcode", "v2", "provider_config.json"), "{}\n", "utf8");
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const markerFile = join(root, "backups", "integrate", "zcode.state.json");

/** 直接写标记文件（绕过 writeJsonSecret，便于构造老标记 / 异常清单）。 */
function putMarker(marker: Record<string, unknown>): void {
  mkdirSync(join(markerFile, ".."), { recursive: true });
  writeFileSync(markerFile, JSON.stringify(marker), "utf8");
}

function readMarkerModels(): string[] {
  return (JSON.parse(readFileSync(markerFile, "utf8")) as { models?: string[] }).models ?? [];
}

describe("integrationUpdates（接入的「模型有更新」）", () => {
  it("接入记下当时的模型清单；写入清单 = 当前对外清单 → 无更新", () => {
    const result = integrateClient("zcode");
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(readMarkerModels(), [...POOL_EXPOSED_IDS], "标记应记下写入的清单");
    assert.equal(integrationStatus().zcode, true);
    assert.equal(integrationUpdates().zcode, null, "写入清单与当前一致 → 不亮更新");
  });

  it("接入的是子集 → added 补齐差额，removed 为空", () => {
    const result = integrateClient("zcode", ["deepseek-v4.1-flash"]);
    assert.equal(result.ok, true, result.error);
    const update = integrationUpdates().zcode;
    assert.ok(update, "子集清单应判为有更新");
    assert.deepEqual(update.added, POOL_EXPOSED_IDS.filter((m) => m !== "deepseek-v4.1-flash"));
    assert.deepEqual(update.removed, []);
  });

  it("清单里混入已下线模型 → removed 指出，added 为空，带接入时刻", () => {
    putMarker({
      integrated: true,
      models: [...POOL_EXPOSED_IDS, "ghost-model"],
      at: "2026-11-01T00:00:00.000Z",
    });
    const update = integrationUpdates().zcode;
    assert.ok(update);
    assert.deepEqual(update.added, []);
    assert.deepEqual(update.removed, ["ghost-model"]);
    assert.equal(update.at, "2026-11-01T00:00:00.000Z");
  });

  it("还原后 → 未接入，不亮更新", () => {
    const result = restoreClient("zcode");
    assert.equal(result.ok, true, result.error);
    assert.equal(integrationUpdates().zcode, null);
  });

  it("老标记（没有 models 字段）与未接入标记 → 都不误报", () => {
    putMarker({ integrated: true, at: "2026-10-01T00:00:00.000Z" });
    assert.equal(integrationUpdates().zcode, null, "判不了 → 不亮（避免误报）");
    putMarker({ integrated: false, models: ["deepseek-v4.1-flash"], at: "2026-10-01T00:00:00.000Z" });
    assert.equal(integrationUpdates().zcode, null);
  });

  it("清单顺序不同但集合一致 → 不算更新", () => {
    putMarker({
      integrated: true,
      models: [...POOL_EXPOSED_IDS].reverse(),
      at: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(integrationUpdates().zcode, null);
  });
});
