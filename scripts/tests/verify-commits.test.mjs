/**
 * `verify-commits.mjs` 的回归测试：PR 内全部提交逐条扫、空范围假绿拦截、署名尾注变体。
 *
 * 为什么单独测：PR #349 的尾注是经分支提交溜进 PR 页面的 —— 校验「扫哪些提交」与
 * 「空范围算什么」都是门禁的行为契约，正则或范围逻辑漂移后门禁会静默放行，
 * 只能靠一次性 git 仓库真实跑脚本来钉住。
 *
 * 怎么跑：`npm run test:scripts`（仓库根）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "verify-commits.mjs");

const repos = [];

/** 一次性 git 仓库：返回仓库目录与按序提交各自的 SHA。 */
function makeRepo(subjects) {
  const repo = mkdtempSync(join(tmpdir(), "verify-commits-"));
  repos.push(repo);
  // hooksPath 置空：全局/模板钩子不得干扰校验器本身的被测行为
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `git ${args.join(" ")} 失败：${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  const shas = [];
  for (const [subject, body] of subjects.map((s) => (Array.isArray(s) ? s : [s, ""]))) {
    const args = ["commit", "-q", "--allow-empty", "-m", subject];
    if (body !== "") args.push("-m", body);
    git(...args);
    shas.push(git("rev-parse", "HEAD"));
  }
  return { repo, shas };
}

/** 以 PR 语境跑校验器：PR_BASE/PR_HEAD 未显式传时按空处理，避免继承开发环境残留。 */
function verify(repo, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_BEFORE: "", PR_BASE: "", PR_HEAD: "", PR_TITLE: "", PR_BODY: "", ...env },
  });
}

const ok = (n) => `chore(test): 合规提交 ${n}`;

after(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

describe("verify-commits：PR 内逐条提交", () => {
  it("中间提交带 Co-Authored-By —— 即使头尾干净也必须拦下", () => {
    const { repo, shas } = makeRepo([ok(1), [ok(2), "Co-Authored-By: Claude Opus <noreply@anthropic.com>"], ok(3)]);
    const r = verify(repo, { PR_BASE: shas[0], PR_HEAD: shas[2] });
    assert.equal(r.status, 1, "带尾注的 PR 提交必须非零退出");
    assert.match(r.stderr, /署名类尾注/);
    assert.match(r.stderr, /Co-Authored-By/);
  });

  it("变体尾注（Co-Developed-By / Generated-with）同样拦下", () => {
    for (const trailer of ["Co-Developed-By: Bot <bot@example.com>", "generated-with: Some AI <ai@example.com>"]) {
      const { repo, shas } = makeRepo([ok(1), [ok(2), trailer]]);
      const r = verify(repo, { PR_BASE: shas[0], PR_HEAD: shas[1] });
      assert.equal(r.status, 1, `${trailer} 必须被拦下`);
      assert.match(r.stderr, /署名类尾注/);
    }
  });

  it("PR 全部提交合规 —— 通过且逐条计数", () => {
    const { repo, shas } = makeRepo([ok(1), ok(2)]);
    const r = verify(repo, { PR_BASE: shas[0], PR_HEAD: shas[1] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 条提交/); // base..head 只含 PR 自己的那条新提交
  });

  it("端点解析不到（浅 fetch）—— 报错退出，不回退换范围", () => {
    const { repo, shas } = makeRepo([ok(1)]);
    const r = verify(repo, { PR_BASE: "f".repeat(40), PR_HEAD: shas[0] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /无法解析为提交对象/);
  });

  it("空范围（base == head）—— 假绿拦截", () => {
    const { repo, shas } = makeRepo([ok(1)]);
    const r = verify(repo, { PR_BASE: shas[0], PR_HEAD: shas[0] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /空范围/);
  });

  it("PR 描述带尾注 —— 提交干净也拦", () => {
    const { repo, shas } = makeRepo([ok(1), ok(2)]);
    const r = verify(repo, {
      PR_BASE: shas[0],
      PR_HEAD: shas[1],
      PR_BODY: "改动说明\n\nCo-Authored-By: Codex <codex@example.com>",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PR 描述/);
  });
});
