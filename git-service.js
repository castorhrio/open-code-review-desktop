// SPDX-License-Identifier: Apache-2.0
"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { isInside } = require("./path-guard");

// Every git command runs in the C locale, deliberately.
//
// Two of the classifications below (`readFileAtRef`'s `bad-ref` / `missing`) read
// git's *stderr wording*, and wording is not this program's to control: on a
// Chinese (or any other localised) desktop, git says "fatal: 无效的对象名称" and
// "fatal: 路径 ... 不存在", neither of which matches an English pattern. Both
// failures then fall through to the generic branch, so a file that is simply not
// in the reviewed snapshot is reported as "读取 ... 失败" — the one wording that
// tells the reader nothing. The overall exit codes are unaffected by the locale,
// only the sentences are, so pinning the locale is what makes the patterns in
// `readFileAtRef` a stable contract instead of a guess about the user's
// environment.
//
// `process.env` is spread in rather than replaced: PATH has to survive (that is
// how `git` is found at all), and so does `GIT_CEILING_DIRECTORIES`-style
// configuration the caller may be relying on. Only the message language is
// forced. `git` is spawned asynchronously, never with `spawnSync`: `spawnSync` is
// refused outright (EBUSY) in the sandbox the checks run in.
//
// Built per call rather than once at load: the caller's environment is allowed to
// change between calls (the checks point `GIT_CEILING_DIRECTORIES` at a throwaway
// directory, for instance), and a snapshot taken at load would silently ignore it.
//
// This is a deliberate trade, not a guarantee: no audit turns red when git changes
// its wording (the fixtures are hand-written strings), so the fallback branch has to
// stay diagnosable instead. The full statement of that cost — what is asserted, what
// can only be re-read by hand — is in `docs/OCR-UPSTREAM-SYNC.md` 的
// 『能自动变红的地方，和不能的地方』. Read it before touching the patterns in
// `readFileAtRef`.
const gitEnv = () => ({ ...process.env, LC_ALL: "C", LANG: "C" });

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env: gitEnv() });
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
 *
 * Exported so the four answers can be pinned one by one: this function reads
 * git's *stdout shape* ("<only-in-HEAD> <only-in-ref>"), and a shape it does
 * not recognise has to answer "" rather than one of the four relations — a
 * guess here is a range that reviews no file, and says nothing about it.
 *
 * The shape is read strictly: exactly two counts. Anything else — a third
 * column, a missing half, a line that is not a number — answers "" as well,
 * because "no relation" only makes the UI fall back to the working tree,
 * while a relation read out of a shape that is not the documented one picks a
 * range that silently reviews nothing.
 *
 * A *legal ref name* is an upstream constraint of this function, not a promise
 * it makes: `ref` comes from `inspect`'s own `refs` list (git's
 * `%(refname:short)` output) or from `resolveRef`'s caller, so it is a name git
 * printed, not one the renderer typed. The two guards above are what keeps that
 * constraint from being load-bearing, though: a malformed name either makes git
 * fail (`git rev-list HEAD...-x`: `fatal: ambiguous argument`, exit 128) or, if a
 * future git accepted it, hands back a shape that is not two counts — both
 * answer "" here. `tools/git-service-smoke.mjs` pins both names against real git
 * so this is a fact rather than an intention: if `ref` ever starts arriving
 * straight from the renderer, these are the lines that already hold.
 */
async function classifyRef(repoRoot, ref) {
  const res = await git(["rev-list", "--count", "--left-right", `HEAD...${ref}`], repoRoot);
  if (res.code !== 0) return "";
  const parts = res.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return "";
  const [left, right] = parts.map((n) => Number.parseInt(n, 10));
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
 *
 * `missing` / `bad-ref` / `failed` are this reader's own vocabulary. The other
 * file reader — `install-info.js`'s `openFile`, which opens a file in the working
 * tree — answers `no-file` / `missing` / `open-failed`, and the two are not
 * interchangeable: the renderer branches per endpoint, and each vocabulary is
 * pinned by its own smoke checks (`tools/git-service-smoke.mjs`,
 * `tools/install-info-smoke.mjs`).
 */
async function readFileAtRef(repo, relPath, ref, startLine, endLine, pad) {
  const res = await git(["show", `${ref}:${relPath}`], repo);
  if (res.code !== 0) {
    const err = res.stderr.trim();
    if (/unknown revision|invalid object|bad revision|ambiguous argument/i.test(err))
      return { ok: false, reason: "bad-ref", ref, path: relPath, error: `无法解析 ${ref}` };
    if (/does not exist|exists on disk, but not in|no such path/i.test(err))
      return { ok: false, reason: "missing", ref, path: relPath, error: `在 ${ref} 中找不到 ${relPath}` };
    // The two wordings above are git's, not this program's: a localised or newer
    // git says it differently, and every such spelling lands here. So this
    // sentence has to be diagnosable *without* the classification — it carries
    // git's own first line and its exit code. Without the code, "读取 … 失败：
    // fatal: …" leaves the reader with a sentence they cannot look up; with it,
    // the same sentence can be matched against the git that produced it. The
    // exit code is also the one part of a git failure that does not depend on
    // the message language at all.
    const first = err.split(/\r?\n/)[0] || "";
    const code = typeof res.code === "number" ? res.code : -1;
    return {
      ok: false,
      reason: "failed",
      ref,
      path: relPath,
      error: `读取 ${ref} 中的 ${relPath} 失败（git 退出码 ${code}）：${first || "没有任何 stderr"}`,
    };
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
  if (!isInside(repo, abs)) return { ok: false, error: "路径越界" };
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

module.exports = { inspect, readFile, readFileWindow, readFileAtRef, resolveRef, classifyRef, git };
