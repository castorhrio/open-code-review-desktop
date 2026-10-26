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
//
// The first thing the script refuses is the machine: this path packages a Windows
// build (`dist:win`, `win-unpacked`) and says so rather than half-porting itself
// to a platform it was never written for — see `parsePlatform`.
//
// The same split is what a *failed* release needs. Its runners throw instead of
// exiting (`stepFailure`), this module decides what a throw means
// (`releaseAbort`: the lines to print, the exit status, how far it got), and
// `runRelease` is the one answer the script acts on — so the exit status is
// decided in one place instead of inside whichever step happened to fail.

/** The sentence a bad invocation prints, before a single step is planned. */
export const RELEASE_USAGE = "usage: node tools/release.mjs <x.y.z>";

/** Exactly what `npm version` and the release tag expect — no `v`, no suffix. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/**
 * The version argument, checked where it can be checked.
 *
 * This used to be two lines at the top of `tools/release.mjs` — a regex test and
 * a `process.exit(2)` — which meant the only input the release script accepts was
 * the one thing about it no check could reach: importing the script starts
 * packaging. The version decides the commit message, the output dir and the
 * artefacts' names, so a bad one is worth refusing with a sentence rather than
 * with whatever `npm version` makes of it three steps later.
 *
 * `argv` is `process.argv.slice(2)`, i.e. the arguments after the script name.
 * Answers `{ ok: true, version }` or `{ ok: false, reason, error }` where the
 * error is the line to print — the usage sentence plus what was wrong with what
 * was given. A leading `v` is worth its own hint: `v0.1.14` is what a git tag and
 * a GitHub release are called, so it is the mistake people actually make, and
 * `npm version v0.1.14` would happily create a `v`-prefixed tag that the release
 * output dir does not use.
 */
export function parseVersion(argv = []) {
  const args = Array.isArray(argv) ? argv : [argv];
  const raw = typeof args[0] === "string" ? args[0].trim() : "";
  if (!raw) return { ok: false, reason: "missing", error: `${RELEASE_USAGE} — no version given` };
  if (!VERSION_SHAPE.test(raw)) {
    const hint = /^v\d+\.\d+\.\d+$/.test(raw) ? ` (drop the leading "v": ${raw.slice(1)})` : "";
    return { ok: false, reason: "invalid", error: `${RELEASE_USAGE} — "${raw}" is not x.y.z${hint}` };
  }
  return { ok: true, reason: "ready", version: raw };
}

/**
 * The platform this release path can actually cut, and the refusal for every
 * other one.
 *
 * Everything below is Windows-shaped and not by oversight: `releaseCommands`
 * hardcodes `npm run dist:win`, `retryDistIntoFallback` hardcodes
 * `electron-builder --win` and the `win-unpacked` app dir, and the fallback
 * exists for a locked path on *this* machine. macOS and Linux releases are cut by
 * `npm run dist:mac` / `npm run dist:linux` on a machine of that kind, with
 * different artefacts, a different app dir and no Nsis installer. Half-porting
 * this script (a `process.platform` switch over the command names) would leave
 * the move and the fallback still pretending the output is `win-unpacked`, i.e.
 * a script that looks cross-platform and is not — the worst of both.
 *
 * So the machine is refused where it can be refused: before the precheck, before
 * the bump, before anything on disk changes. The sentence names the machine *and*
 * the two commands that do work there, because "unsupported platform" on its own
 * sends the reader looking for a flag that does not exist.
 *
 * `platform` is a parameter rather than `process.platform` read inside, so the
 * check can ask what a mac would be told without owning a mac — the same reason
 * `capture` is injected above.
 */
export const RELEASE_PLATFORM = "win32";

/** The refusal sentence for a machine this path was never written for. */
function unsupportedPlatformError(platform) {
  const named = typeof platform === "string" && platform ? `"${platform}"` : "an unknown platform";
  return (
    `this release path is Windows-only — it runs \`npm run dist:win\` and moves ` +
    `release/win-unpacked into place, so ${named} cannot cut a release with it; ` +
    `run \`npm run dist:mac\` or \`npm run dist:linux\` by hand instead`
  );
}

/**
 * Whether this machine may cut a release with `tools/release.mjs`.
 *
 * Answers the same shape as `parseVersion` — `{ ok, reason, platform }`, plus the
 * line to print on a refusal — because the script refuses both inputs the same
 * way (`console.error(error)`, exit 2) and a caller should not have to remember
 * two shapes. An empty or non-string platform is refused rather than read as
 * "this one": a `process.platform` that is somehow missing is not evidence of
 * Windows.
 */
export function parsePlatform(platform = process.platform) {
  const value = typeof platform === "string" ? platform.trim() : "";
  if (value === RELEASE_PLATFORM) return { ok: true, reason: "ready", platform: value };
  return { ok: false, reason: "unsupported-platform", platform: value, error: unsupportedPlatformError(value) };
}

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

/**
 * Run a plan's steps, in the plan's order, through the two runners given.
 *
 * WHY THIS IS HERE AND NOT IN `tools/release.mjs`
 * The loop that executes the plan used to live in the script, so the only way to
 * check "the steps run in this order, and a refusal runs nothing" was to read the
 * script's source and match its shape — `for (const step of plan.steps)`, the
 * literal `planRelease({ version, capture })` call. Those are properties of how
 * the file happens to be written: a `while` loop, a `.forEach`, or passing the
 * options through a variable would each have turned the check red while the
 * release still executed the same commands in the same order. This function is
 * the contract instead. The smoke calls it with recording doubles and asserts
 * what was *executed*, and `release.mjs` is left with the two things it alone can
 * do: build the plan from `git` and supply runners that touch the real disk.
 *
 * `run` gets the ordinary steps and `runDist` the packaging one, because that is
 * the only step with a fallback worth keeping out of this module (see
 * `tools/release.mjs`: a locked `win-unpacked.tmp` sends packaging to a fresh
 * output dir). `runDist` defaults to `run`, so a caller that has no fallback
 * does not have to spell one out.
 *
 * A runner that throws ends the sequence: nothing after a failed step runs, and
 * the throw is the caller's. Both of `tools/release.mjs`'s runners throw — a
 * non-zero exit status becomes an `Error` carrying that status in `code` — and
 * `runRelease` below is the single place that turns a throw into an answer. That
 * is what makes the next paragraph reachable outside the smoke's doubles: the
 * runners used to call `process.exit`, so on the real path the process was gone
 * before anything could ride on the throw.
 *
 * The answer names what ran (`ran: [...]`, in order) and, on a refused plan,
 * `{ ok: false, ran: [] }` — the refusal is the answer, not a third state the
 * caller has to remember.
 *
 * The same list rides along on the exception a failing runner throws
 * (`err.ran`), because a throw is the only answer the caller ever sees for a
 * half-done release: the steps that *completed*, in order, and never the one
 * that failed. It is what "how far did it get" means after a failed packaging
 * run, and keeping it out of the error would leave the release log — which is
 * what a human reads at that moment — as the only record. The failing step's own
 * name rides along beside it (`err.failed`), so the log can say *where* it
 * stopped instead of leaving the reader to diff the plan against `ran`.
 */
export function executeRelease(plan, deps = {}) {
  const run = typeof deps.run === "function" ? deps.run : () => {};
  const runDist = typeof deps.runDist === "function" ? deps.runDist : run;
  if (!plan || !plan.ok) return { ok: false, reason: (plan && plan.reason) || "refused", ran: [] };
  const ran = [];
  for (const step of plan.steps) {
    try {
      if (step.name === "dist") runDist(step);
      else run(step);
    } catch (err) {
      // `ran` is pushed *after* the step returns, so a failed step is not in it.
      // A runner may throw a non-Error (`throw "..."`), and a frozen error keeps
      // the platform's own words — neither is a reason to lose the throw itself.
      if (err && typeof err === "object") {
        try {
          err.ran = ran;
          err.failed = step.name;
        } catch (_) {
          /* a frozen error still carries its own message, which is the main thing */
        }
      }
      throw err;
    }
    ran.push(step.name);
  }
  return { ok: true, ran };
}

/**
 * The error a runner throws for a command that exited non-zero.
 *
 * It is one function rather than a line inside `tools/release.mjs`'s runner for
 * the same reason everything else here is: the *shape* of the throw is the
 * contract `releaseAbort` reads (`code`, and a message naming the command), and a
 * script that cannot be imported cannot be asked what shape it throws. `status`
 * is `spawnSync`'s — a number, or `null` when the child was killed by a signal —
 * so a killed command is reported as exited 1 rather than as `null` or as a
 * sentence with a hole in it.
 */
export function stepFailure(cmd, status) {
  const code = typeof status === "number" && Number.isInteger(status) && status > 0 ? status : 1;
  return Object.assign(new Error(`\`${cmd}\` exited ${code}`), { code });
}

/** The exit status a failing runner said, when it said one. */
function exitStatusOf(err) {
  if (!err || typeof err !== "object") return 1;
  // `code` is also where errno strings live (`ENOENT`), so only a positive
  // integer counts as an exit status: an `Error` that fails a command and an
  // `Error` that fails a syscall do not share a vocabulary.
  for (const key of ["status", "exitCode", "code"]) {
    const value = err[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return 1;
}

/**
 * What a half-done release has to say for itself: the lines to print, the exit
 * status, and how far it got.
 *
 * This is the answer to the one question a failed release leaves behind — "what
 * is on disk now?" — so it is a value rather than three `console.error` calls at
 * the bottom of `tools/release.mjs`: the words are the contract, and a check can
 * read them. The status comes from the failed step's own exit status when its
 * runner carried one (a `spawnSync` runner does), and is `1` otherwise — never
 * `0`, because a release that threw did not succeed.
 *
 * `ran` is copied out of the throw rather than returned by reference: the caller
 * keeps it for its log, and a runner that threw a frozen error must not be the
 * reason the list is missing.
 */
export function releaseAbort(err) {
  const code = exitStatusOf(err);
  const ran = err && typeof err === "object" && Array.isArray(err.ran) ? err.ran.slice() : [];
  const failed = err && typeof err === "object" && typeof err.failed === "string" ? err.failed : "";
  const said =
    typeof err === "string"
      ? err
      : err && typeof err.message === "string" && err.message.trim()
        ? err.message
        : "the failing step gave no reason";
  const where = failed ? `at step ${failed}` : "outside any step";
  const progress = ran.length ? `after: ${ran.join(" -> ")}` : "with no step completed";
  return {
    code,
    ran,
    failed,
    lines: [
      `release aborted ${where} (${progress}): ${said}`,
      // Two different states, and the human reading this log is the only one who
      // can decide what to do about it: a completed step has already written to
      // the tree (the bump writes two files, the commit lands), while nothing
      // completed means the release stopped before it changed anything.
      ran.length
        ? `the steps above already ran: the tree is not the one it started from, nothing was pushed`
        : `nothing completed, so the release did not get as far as changing the tree`,
    ],
  };
}

/**
 * Run a plan and answer what happened, without ever throwing.
 *
 * `executeRelease` above is the primitive — it lets a failing runner's throw out,
 * which is what makes the sequence stoppable. This is the shape a *script* needs:
 * one answer it can act on (`ok`, `code`, `error`, `ran`), so the release's exit
 * status is decided in one place instead of inside whichever runner happened to
 * fail. `tools/release.mjs` prints `error` and exits `code`; that is all it does
 * with a failure.
 *
 * A refused plan is answered with `code: 2`, the status the script already used
 * for "the release was not started", so a refusal and a mid-release failure stay
 * distinguishable in a shell that only sees `$?`.
 */
export function runRelease(plan, deps = {}) {
  let answer;
  try {
    answer = executeRelease(plan, deps);
  } catch (err) {
    const abort = releaseAbort(err);
    return { ok: false, reason: "failed", code: abort.code, ran: abort.ran, error: abort.lines.join("\n") };
  }
  if (!answer.ok) {
    const said = plan && typeof plan.error === "string" && plan.error ? plan.error : `the plan was refused (${answer.reason})`;
    return { ok: false, reason: answer.reason, code: 2, ran: [], error: `release aborted: ${said}` };
  }
  return answer;
}
