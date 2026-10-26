// Checks the release guard: the two states a release must not start from.
//
// `tools/release.mjs` is not run here — it bumps the version, commits, and
// packages the app, so the only thing a check may touch is the decision it makes
// before any of that. That decision lives in `release-guard.mjs`, and `capture`
// is injected precisely so it can be fed a git that answers anything.
//
//   - a detached HEAD is the quiet one: every later step succeeds, and the
//     release commit lands on a commit no branch points at, so the next
//     `git switch main` makes the whole release unreachable.
//   - a dirty tree ships someone else's half-finished work.
//
// Run with `npm run audit:release`.
import fs from "node:fs";
import path from "node:path";

import { releasePrecheck, RELEASE_GUARD_MESSAGES } from "./release-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/**
 * A `capture` double: a table of command -> answer, where an answer of `throw`
 * stands for the non-zero exit `execSync` turns into an exception.
 *
 * Every command asked for is recorded, because *which* commands the guard runs
 * is part of the contract: it may only read, never write, and it must not be
 * tempted to ask `git commit`'s neighbours anything.
 */
function fakeGit(answers) {
  const calls = [];
  const capture = (cmd) => {
    calls.push(cmd);
    const answer = answers[cmd];
    if (answer === undefined) throw new Error(`unexpected command in the guard: ${cmd}`);
    if (answer === "throw") throw new Error("Command failed: " + cmd);
    return answer;
  };
  return { capture, calls };
}

const SYMBOLIC = "git symbolic-ref --short HEAD";
const STATUS = "git status --porcelain";

/* ---- a detached HEAD is refused, before anything is written ---- */
{
  const g = fakeGit({ [SYMBOLIC]: "throw" });
  const answer = releasePrecheck(g.capture);
  check("a detached HEAD is refused", answer.ok === false, JSON.stringify(answer));
  check("...as `detached`", answer.reason === "detached", answer.reason);
  check("...with a sentence saying what to do instead", /git switch/.test(answer.error || ""), answer.error);
  check(
    "...and only the branch question is asked, nothing is written",
    g.calls.length === 1 && g.calls[0] === SYMBOLIC,
    JSON.stringify(g.calls)
  );
  check(
    "...and the sentence is the one the caller prints, not a second copy",
    answer.error === RELEASE_GUARD_MESSAGES.DETACHED,
    answer.error
  );
}

// An empty answer is the same news: `symbolic-ref` printed nothing, which is not
// a branch name. Nothing downstream may treat "" as "no check needed".
{
  const g = fakeGit({ [SYMBOLIC]: "  \r\n", [STATUS]: "" });
  const answer = releasePrecheck(g.capture);
  check("an empty branch answer is a detached HEAD too", answer.ok === false && answer.reason === "detached", JSON.stringify(answer));
  check("...and the dirty question is never reached", g.calls.length === 1, JSON.stringify(g.calls));
}

/* ---- a dirty tree is refused ---- */
{
  const g = fakeGit({ [SYMBOLIC]: "main\n", [STATUS]: " M package.json\n?? notes.txt\n" });
  const answer = releasePrecheck(g.capture);
  check("a dirty tree is refused", answer.ok === false && answer.reason === "dirty", JSON.stringify(answer));
  check("...with the sentence about committing or stashing", /commit or stash/.test(answer.error || ""), answer.error);
  check("...and the branch is still reported, so the log can name it", answer.branch === "main", answer.branch);
  check("...and both questions were asked, in that order", g.calls.join(" | ") === `${SYMBOLIC} | ${STATUS}`, g.calls.join(" | "));
}

/* ---- a clean tree on a branch passes, and names the branch ---- */
{
  for (const [output, branch] of [
    ["main\n", "main"],
    ["release/0.1.14\r\n", "release/0.1.14"],
    ["  hotfix-0.1.14  \n", "hotfix-0.1.14"],
  ]) {
    const g = fakeGit({ [SYMBOLIC]: output, [STATUS]: "" });
    const answer = releasePrecheck(g.capture);
    check(
      `a clean tree on ${branch} passes`,
      answer.ok === true && answer.reason === "ready",
      JSON.stringify(answer)
    );
    check("...and the branch is the trimmed name", answer.branch === branch, JSON.stringify(answer.branch));
  }
}

// Whitespace-only status output is a clean tree: `--porcelain` prints nothing
// when there is nothing to say, but a trailing newline must not read as a change.
{
  const g = fakeGit({ [SYMBOLIC]: "main\n", [STATUS]: "\n" });
  const answer = releasePrecheck(g.capture);
  check("a status that is only whitespace is a clean tree", answer.ok === true, JSON.stringify(answer));
}

/* ---- a git that cannot answer at all is not a pass ---- */
{
  const g = fakeGit({ [SYMBOLIC]: "main\n", [STATUS]: "throw" });
  const answer = releasePrecheck(g.capture);
  check(
    "a status git refuses is reported, not read as clean",
    answer.ok === false && answer.reason === "unknown",
    JSON.stringify(answer)
  );
  check("...keeping git's own words", /Command failed/.test(answer.error || ""), answer.error);
  check("...and still naming the branch it got that far with", answer.branch === "main", answer.branch);
}

/* ---- the script actually uses the guard, and before it writes anything ---- */
{
  const src = fs.readFileSync(path.join(ROOT, "tools/release.mjs"), "utf8");
  const why = (ok, message) => (ok ? "" : message);

  const imports = /import\s*\{\s*releasePrecheck\s*\}\s*from\s*["']\.\/release-guard\.mjs["']/.test(src);
  check("release.mjs imports the guard", imports, why(imports, "no import of release-guard.mjs"));

  const callsGuard = /releasePrecheck\(capture\)/.test(src);
  check("...and calls it with its own capture", callsGuard, why(callsGuard, "the guard is imported but not called"));

  const aborts = /if\s*\(!pre\.ok\)[\s\S]{0,200}process\.exit\(2\)/.test(src);
  check("...and aborts on a refusal", aborts, why(aborts, "the refusal does not stop the script"));

  // The order is the point: a guard that runs after `npm version` has already
  // modified two files, and one that runs after `git commit` has already
  // committed them to nowhere.
  const guardAt = src.indexOf("releasePrecheck(capture)");
  const bumpAt = src.indexOf("npm version ${version}");
  const commitAt = src.indexOf("git commit -m");
  check(
    "the guard runs before the version bump",
    guardAt !== -1 && bumpAt !== -1 && guardAt < bumpAt,
    `guard at ${guardAt}, bump at ${bumpAt}`
  );
  check(
    "and well before the release commit",
    guardAt !== -1 && commitAt !== -1 && guardAt < commitAt,
    `guard at ${guardAt}, commit at ${commitAt}`
  );
  // The old inline check must not have been left behind beside the guard: two
  // copies of "the tree must be clean" is one copy that drifts.
  const inline = (src.match(/git status --porcelain/g) || []).length;
  check("the clean-tree question is asked in exactly one place", inline === 0, `${inline} inline uses in release.mjs`);
}

console.log(`\n${failures.length === 0 ? "all release-guard checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\nrelease-guard checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
