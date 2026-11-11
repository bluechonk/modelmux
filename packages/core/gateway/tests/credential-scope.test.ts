/**
 * 凭据落点上下文：对某个账号操作时，渠道的凭据读写落在这个账号自己的文件上。
 *
 * 用**合成渠道**（cred.load / save 都走共享层 `paths.credentialsPath`，与真实渠道同式）
 * + 临时存储根，真验文件落点与 live 文件不被顶掉。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  captureActive,
  listAccounts,
  runForAccountCredential,
} from "../dist/runtime/account-pool.js";
import { clearChannels, getChannel, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { runInChannel } from "../dist/runtime/channel-context.js";
import { accountCredentialsPath, channelDir, credentialsPath } from "../dist/runtime/paths.js";
import { registerChannelSupply } from "./registry-seed.ts";

const CID = "scope";

/** 合成渠道：与 accounts.test.ts 同形，load/save 走共享层路径（不自己拼）。 */
function makeChannel(cid: string): Channel {
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);

  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const load = (): Record<string, unknown> => {
    const raw = readFileSync(credentialsPath(cid), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  };
  const save = async (c: Record<string, unknown>): Promise<void> => {
    mkdirSync(channelDir(cid), { recursive: true, force: true });
    writeFileSync(credentialsPath(cid), `${JSON.stringify(c, null, 2)}\n`, "utf8");
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save,
      login: async () => load(),
      refresh: async (c: Record<string, unknown>) => {
        const next = { ...c, accessToken: `${String(c["accessToken"])}-refreshed` };
        await save(next);
        return next;
      },
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 在独立临时根里跑一段用例（路径按存储根解析，故每例一个新根）。 */
function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "modelmux-scope-"));
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel(CID));
    try {
      await fn(root);
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = saved;
      clearChannels();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 写一份"登录成果"到 live 的 credentials.json 并收进池子，返回账号 key。 */
function seedAccount(uid: string): string {
  mkdirSync(channelDir(CID), { recursive: true, force: true });
  const cred = { accessToken: `tok-${uid}`, refreshToken: `r-${uid}`, uid, domain: "example.com" };
  writeFileSync(credentialsPath(CID), `${JSON.stringify(cred, null, 2)}\n`, "utf8");
  return captureActive(CID)!.key;
}

function readToken(path: string): string {
  return String((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["accessToken"] ?? "");
}

describe("凭据落点上下文", () => {
  it("不在账号上下文时，credentialsPath() 是 live 文件", withRoot(async () => {
    assert.ok(credentialsPath(CID).endsWith(join("channels", CID, "credentials.json")));
    assert.ok(!credentialsPath(CID).includes(join("accounts")), "live 落点不该在 accounts/ 下");
  }));

  it("runForAccountCredential：落点换成该账号文件，cid 上下文一并给到", withRoot(async () => {
    const key = seedAccount("user-1");
    const accountFile = accountCredentialsPath(key, CID);

    const seen = runForAccountCredential(CID, key, () => ({
      withCid: credentialsPath(CID),
      withoutCid: runInChannel(CID, () => credentialsPath()),
    }));
    assert.equal(seen.withCid, accountFile, "显式传 cid 也被落点覆盖");
    assert.equal(seen.withoutCid, accountFile);
    assert.ok(existsSync(accountFile), "账号文件由 captureActive 建好");
  }));

  it("账号上下文里 save() 写账号文件、live 文件不动", withRoot(async () => {
    const key = seedAccount("user-1");
    const channel = getChannel(CID);
    const accountFile = accountCredentialsPath(key, CID);

    await runForAccountCredential(CID, key, async () => {
      await channel.cred.save({ accessToken: "refreshed", uid: "user-1", domain: "example.com" });
    });

    assert.equal(readToken(accountFile), "refreshed", "续期结果应落在账号文件");
    assert.equal(readToken(credentialsPath(CID)), "tok-user-1", "live 文件不能被顶掉");
  }));

  it("账号上下文里 load() 读账号文件", withRoot(async () => {
    const key = seedAccount("user-1");
    const channel = getChannel(CID);
    const accountFile = accountCredentialsPath(key, CID);

    const loaded = await runForAccountCredential(CID, key, async () => await channel.cred.load());
    assert.equal(loaded["accessToken"], "tok-user-1");

    writeFileSync(accountFile, `${JSON.stringify({ accessToken: "acct" }, null, 2)}\n`, "utf8");
    const again = await runForAccountCredential(CID, key, async () => await channel.cred.load());
    assert.equal(again["accessToken"], "acct", "上下文里读到的是账号那份");
  }));

  it("出了上下文落点回到 live（不泄漏）", withRoot(async () => {
    const key = seedAccount("user-1");
    await runForAccountCredential(CID, key, () => {});
    assert.ok(credentialsPath(CID).endsWith(join("channels", CID, "credentials.json")));
    assert.equal(listAccounts(CID).accounts.length, 1);
  }));
});
