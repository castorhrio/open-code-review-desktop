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

/**
 * Read a file as it was at a ref.
 *
 * `git show` reports a path that is not in the ref and a ref that does not
 * resolve the same way at the exit code, but its stderr says which — and the two
 * mean different things to a reader: one is a file that is not in the reviewed
 * snapshot (deleted, renamed, never committed there), the other is a snapshot
 * that does not exist at all. So the reason is classified here instead of
 * collapsing both into one flat "not found".
 *
 * The ref is echoed back on every failure, because the caller has to be able to
 * say *which* snapshot it could not read.
 */
async function readFileAtRef(repo, relPath, ref, startLine, endLine, pad) {
  const res = await git(["show", `${ref}:${relPath}`], repo);
  if (res.code !== 0) {
    const err = res.stderr.trim();
    if (/unknown revision|invalid object|bad revision|ambiguous argument/i.test(err))
      return { ok: false, reason: "bad-ref", ref, path: relPath, error: `无法解析 ${ref}` };
    if (/does not exist|exists on disk, but not in|no such path/i.test(err))
      return { ok: false, reason: "missing", ref, path: relPath, error: `在 ${ref} 中找不到 ${relPath}` };
    const first = err.split(/\r?\n/)[0] || `git show 退出码 ${res.code}`;
    return { ok: false, reason: "failed", ref, path: relPath, error: `读取 ${ref} 中的 ${relPath} 失败：${first}` };
  }
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

/**
 * The one rule for reading the code that sits next to a finding.
 *
 * A review that targeted a ref describes the code *at that ref*, so the code
 * pane has to show that snapshot. Reading the working tree instead shows
 * whatever the file looks like now — and when the working tree is dirty, that
 * is not the code the finding was written about. The README promises the first
 * behaviour ("the code pane reads that file *at that ref* (`git show`), not your
 * working copy"), so this is where the promise is kept.
 *
 * The old handler broke it twice: `HEAD` was treated as "no ref" and read from
 * the working tree, and *any* failed ref read fell back to the working tree
 * too. A file that is not in the reviewed ref at all was therefore shown as
 * though it were, and the only symptom was a finding whose code did not match
 * the finding.
 *
 * So: a ref means the ref, always — `HEAD` included, since `HEAD` is a ref and
 * a dirty working tree is exactly the case where reading it would lie. No ref
 * (a workspace run, a full scan) means the working tree. A failed ref read is
 * reported with its reason, and the caller may offer the working tree as an
 * explicit choice rather than a silent substitution.
 */
async function readFile(repo, relPath, { ref, startLine, endLine, pad } = {}) {
  if (ref) return readFileAtRef(repo, relPath, ref, startLine, endLine, pad);
  return readFileWindow(repo, relPath, startLine, endLine, pad);
}

module.exports = { inspect, readFile, readFileWindow, readFileAtRef, resolveRef, git };
