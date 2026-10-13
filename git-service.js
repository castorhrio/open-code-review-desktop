// SPDX-License-Identifier: Apache-2.0
"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout: "", stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

async function resolveRef(repo, ref) {
  if (!ref) return { ok: false, error: "空引用" };
  const res = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
  const sha = res.stdout.trim();
  return res.code === 0 && sha ? { ok: true, sha } : { ok: false, error: `无法解析 ${ref}` };
}

/**
 * How a ref stands relative to HEAD, which is the only thing that decides
 * whether a `--from <ref> --to HEAD` comparison has anything in it.
 *
 * `git rev-list --count --left-right HEAD...<ref>` prints "<only-in-HEAD>
 * <only-in-ref>", which answers the ancestor question directly:
 *   0 n  HEAD is behind      -> the ref is *ahead* of us (a descendant)
 *   n 0  the ref is behind   -> the ref is an ancestor of HEAD
 *   n m  neither contains the other (diverged); either direction has content
 *   0 0  the same commit
 *
 * The distinction matters because `from` and `to` are not symmetric under the
 * CLI's merge-base diff: `A...B` is empty exactly when B is an ancestor of A.
 * Picking a descendant as `from` while `to` stays on HEAD therefore reviews
 * nothing at all, silently.
 */
async function classifyRef(repoRoot, ref) {
  const res = await git(["rev-list", "--count", "--left-right", `HEAD...${ref}`], repoRoot);
  if (res.code !== 0) return "";
  const [left, right] = res.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(left) || !Number.isFinite(right)) return "";
  if (left === 0 && right === 0) return "same";
  if (left === 0) return "descendant";
  if (right === 0) return "ancestor";
  return "diverged";
}

// A default base only needs one good answer, and a repository with hundreds of
// branches should not turn every `inspect` into hundreds of git spawns. The
// named bases are always evaluated; the rest are capped.
const REF_LIMIT = 40;

async function inspect(repo) {
  if (!repo || !fs.existsSync(repo)) return { ok: false, error: "路径不存在" };
  const root = await git(["rev-parse", "--show-toplevel"], repo);
  if (root.code !== 0) return { ok: false, error: "这不是一个 git 仓库" };
  const repoRoot = root.stdout.trim();

  const [head, branches, remoteBranches, status, log, origin] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
    git(["branch", "--format=%(refname:short)"], repoRoot),
    git(["branch", "-r", "--format=%(refname:short)"], repoRoot),
    git(["status", "--porcelain"], repoRoot),
    git(["log", "--oneline", "-n", "40", "--format=%h\x01%ad\x01%s", "--date=short"], repoRoot),
    git(["rev-parse", "--abbrev-ref", "@{upstream}"], repoRoot),
  ]);

  const local = lines(branches.stdout).filter((b) => b !== "HEAD");
  const remote = lines(remoteBranches.stdout)
    .filter((b) => !b.includes("->"))
    .map((b) => b.replace(/^(origin|upstream)\//, ""));
  const branch = head.stdout.trim();
  const refs = [...new Set([branch, ...local, ...remote])].sort();

  const commits = lines(log.stdout).map((row) => {
    const [hash, date, ...msg] = row.split("\x01");
    return { hash, date, message: msg.join("\x01") };
  });

  const upstream = origin.code === 0 ? origin.stdout.trim() : "";
  // Named bases first, so the cap can never drop the ref a user most likely
  // wants to compare against; `upstream` is classified by its full name because
  // `origin/x` is the form that always resolves.
  const ranked = [
    ...new Set([upstream, "main", "master", ...refs].filter(Boolean)),
  ].slice(0, REF_LIMIT);
  const relations = {};
  await Promise.all(
    ranked.map(async (r) => {
      const rel = await classifyRef(repoRoot, r);
      if (rel) relations[r] = rel;
    })
  );

  return {
    ok: true,
    repoRoot,
    branch,
    upstream,
    refs,
    relations,
    commits,
    dirtyCount: lines(status.stdout).length,
    isGitRepo: true,
  };
}

// Reading the working tree would show different code than the reviewed
// snapshot whenever the run targeted a ref other than the checkout.
async function readFileAtRef(repo, relPath, ref, startLine, endLine, pad) {
  const res = await git(["show", `${ref}:${relPath}`], repo);
  if (res.code !== 0) return { ok: false, error: `在 ${ref} 中找不到 ${relPath}` };
  const all = res.stdout.split(/\r?\n/);
  const from = Math.max(1, (startLine || 1) - pad);
  const to = Math.min(all.length, Math.max(startLine || 1, endLine || startLine || 1) + pad);
  return {
    ok: true,
    path: relPath,
    ref,
    source: "git",
    totalLines: all.length,
    firstLine: from,
    lines: all.slice(from - 1, to).map((content, i) => ({ n: from + i, content })),
  };
}

function readFileWindow(repo, relPath, startLine, endLine, pad) {
  const abs = path.resolve(repo, relPath);
  const root = path.resolve(repo) + path.sep;
  if (!abs.startsWith(root) && abs !== path.resolve(repo)) return { ok: false, error: "路径越界" };
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    return { ok: false, error: `读取文件失败：${err.message}` };
  }
  const all = text.split(/\r?\n/);
  const from = Math.max(1, (startLine || 1) - pad);
  const to = Math.min(all.length, Math.max(startLine || 1, endLine || startLine || 1) + pad);
  return {
    ok: true,
    path: relPath,
    absPath: abs,
    source: "worktree",
    totalLines: all.length,
    firstLine: from,
    lines: all.slice(from - 1, to).map((content, i) => ({ n: from + i, content })),
  };
}

module.exports = { inspect, readFileWindow, readFileAtRef, resolveRef, git };
