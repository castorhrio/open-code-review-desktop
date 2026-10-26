// The two facts a release has to be cut from, in one place.
//
// `tools/release.mjs` bumps the version, commits, runs the full audit, packages
// and key-scans. Every one of those steps succeeds from a detached HEAD, which is
// the problem: `npm version --no-git-tag-version` writes the two files, the
// commit lands on a commit no branch points at, and the artefacts are built from
// a tree that the next `git switch main` makes unreachable. Nothing fails, and
// the release exists until it quietly does not.
//
// The state is easy to be in on purpose (a release cut from a tag or a PR
// checkout) and easy to be in by accident (`git checkout v0.1.13` to look at
// something, then release from muscle memory), so the guard is a real check
// rather than a note in the header comment.
//
// Kept as a module rather than inline in the script because a guard nobody can
// call is a guard nobody has run: the script itself starts packaging the moment
// it is imported, so the decisions live here, where `release-guard-smoke.mjs`
// feeds them one fixture at a time.
//
// `capture` is injected: it takes a shell command and answers its stdout, and it
// throws when the command fails (that is `execSync`'s contract, and what
// `tools/release.mjs` passes). Both checks read their answer out of *git's exit
// status*, not out of its wording, so this file has no message to parse.

/** The refusal for a HEAD that is not on a branch. */
const DETACHED =
  "HEAD is detached, so there is no branch for the release commit to land on — " +
  "check out the branch this release belongs to first (`git switch <branch>`)";

/** The refusal for a tree with uncommitted work in it. */
const DIRTY = "the working tree is not clean — commit or stash first";

/**
 * Ask git the two questions, in the order that makes the answer readable.
 *
 * The branch comes first: "HEAD is detached" is a fact about where the release
 * would land, and reporting a dirty tree first would send the reader to commit
 * work that is about to be attached to nothing.
 *
 * Every reason answers the same shape — `{ ok: false, reason, error, branch }` —
 * because the caller has one thing to do with a refusal (print it and stop) and
 * one thing to do with a pass (name the branch in the first line of the log).
 */
export function releasePrecheck(capture) {
  let branch = "";
  try {
    branch = String(capture("git symbolic-ref --short HEAD") || "").trim();
  } catch (_) {
    // `symbolic-ref` exits non-zero exactly when HEAD is not a symbolic ref, i.e.
    // detached. There is no stderr to match on and nothing else to ask.
    return { ok: false, reason: "detached", branch: "", error: DETACHED };
  }
  if (!branch) return { ok: false, reason: "detached", branch: "", error: DETACHED };

  let status = "";
  try {
    status = String(capture("git status --porcelain") || "");
  } catch (err) {
    // Not a known-bad tree, an unreadable one: git itself refused (not a
    // repository, an index it cannot lock). The platform's words are kept
    // because they are the only thing that says which of those it is.
    const reason = (err && err.message) || (typeof err === "string" ? err : "");
    return {
      ok: false,
      reason: "unknown",
      branch,
      error: reason ? `could not read the working tree: ${reason}` : "could not read the working tree",
    };
  }
  if (status.trim()) return { ok: false, reason: "dirty", branch, error: DIRTY };
  return { ok: true, reason: "ready", branch };
}

export const RELEASE_GUARD_MESSAGES = { DETACHED, DIRTY };

/**
 * The release's steps, in the order that makes each one safe.
 *
 * `precheck` is first because it is the only step that can answer "there is no
 * branch to release from" before anything is written. The rest are the commands
 * `tools/release.mjs` runs once it has passed.
 *
 * Kept here as names — and the commands below — so the check can assert the
 * order, rather than compare source offsets. A guard that had drifted below the
 * version bump would still pass every check that only looked at its answer;
 * asserting the plan is what makes the position a property of the code the
 * release actually executes.
 */
export const RELEASE_STEPS = ["precheck", "bump", "commit", "audit", "dist", "secret-scan"];

/** Everything after the precheck, with the version already substituted. */
function releaseCommands(version) {
  return [
    { name: "bump", command: `npm version ${version} --no-git-tag-version` },
    {
      name: "commit",
      command: `git add package.json package-lock.json && git commit -m "chore(release): ${version}"`,
    },
    { name: "audit", command: "npm run audit" },
    { name: "dist", command: "npm run dist:win" },
    { name: "secret-scan", command: "npm run audit:secrets" },
  ];
}

/**
 * The one decision `tools/release.mjs` makes before it writes anything.
 *
 * A refusal carries `steps: []`: the short-circuit is the answer, not something
 * the caller has to remember to do. So "the precheck runs first, and nothing
 * runs after it failed" is checkable by calling this with a detached HEAD and
 * finding an empty plan — no source offsets involved.
 */
export function planRelease({ version, capture } = {}) {
  const pre = releasePrecheck(capture);
  if (!pre.ok) return { ...pre, steps: [] };
  return { ...pre, steps: releaseCommands(version) };
}
