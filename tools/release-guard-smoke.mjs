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

import { releasePrecheck, planRelease, RELEASE_GUARD_MESSAGES, RELEASE_STEPS } from "./release-guard.mjs";

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

/* ---- the plan: the precheck is first, and a refusal has nothing after it ----
 * The order used to be checked by comparing string offsets in `release.mjs`,
 * which is a property of how the file was written — not of what the release
 * executes. `planRelease` answers both: the ordered steps on a pass, and an
 * empty plan on a refusal.
 */
{
  check("the plan's first step is the precheck", RELEASE_STEPS[0] === "precheck", RELEASE_STEPS.join(" -> "));

  const clean = fakeGit({ [SYMBOLIC]: "main\n", [STATUS]: "" });
  const plan = planRelease({ version: "0.1.14", capture: clean.capture });
  check("a clean tree plans a release", plan.ok === true && plan.branch === "main", JSON.stringify(plan));
  check(
    "and the steps are the release's, in order",
    plan.steps.map((s) => s.name).join(" -> ") === RELEASE_STEPS.slice(1).join(" -> "),
    plan.steps.map((s) => s.name).join(" -> ")
  );
  const commands = Object.fromEntries(plan.steps.map((s) => [s.name, s.command]));
  check(
    "the bump carries the version",
    commands.bump === "npm version 0.1.14 --no-git-tag-version",
    commands.bump
  );
  check(
    "the commit is the release commit",
    commands.commit === 'git add package.json package-lock.json && git commit -m "chore(release): 0.1.14"',
    commands.commit
  );
  check("the gate is the full audit", commands.audit === "npm run audit", commands.audit);
  check("packaging comes after the gate", commands.dist === "npm run dist:win", commands.dist);
  check(
    "and the key scan comes last, over the packages that step produced",
    commands["secret-scan"] === "npm run audit:secrets",
    commands["secret-scan"]
  );

  const detached = fakeGit({ [SYMBOLIC]: "throw" });
  const refused = planRelease({ version: "0.1.14", capture: detached.capture });
  check(
    "a detached HEAD plans nothing to run",
    refused.ok === false && refused.steps.length === 0,
    JSON.stringify(refused)
  );
  check(
    "...so nothing is bumped from a detached HEAD",
    refused.error === RELEASE_GUARD_MESSAGES.DETACHED,
    refused.error
  );
  check("...and only the branch question was asked", detached.calls.length === 1, JSON.stringify(detached.calls));

  const dirty = fakeGit({ [SYMBOLIC]: "main\n", [STATUS]: " M package.json\n" });
  const refusedDirty = planRelease({ version: "0.1.14", capture: dirty.capture });
  check(
    "a dirty tree plans nothing to run either",
    refusedDirty.ok === false && refusedDirty.steps.length === 0,
    JSON.stringify(refusedDirty)
  );
  check(
    "...and both questions were asked, in that order",
    dirty.calls.join(" | ") === `${SYMBOLIC} | ${STATUS}`,
    dirty.calls.join(" | ")
  );
}

/* ---- the script executes that plan, rather than a second copy of it ---- */
{
  const src = fs.readFileSync(path.join(ROOT, "tools/release.mjs"), "utf8");
  const why = (ok, message) => (ok ? "" : message);

  const imports = /import\s*\{\s*planRelease\s*\}\s*from\s*["']\.\/release-guard\.mjs["']/.test(src);
  check("release.mjs takes its plan from the guard", imports, why(imports, "no import of planRelease"));

  const callsPlan = /planRelease\(\{\s*version,\s*capture\s*\}\)/.test(src);
  check("...and builds it before running anything", callsPlan, why(callsPlan, "the plan is imported but not built"));

  const aborts = /if\s*\(!plan\.ok\)[\s\S]{0,200}process\.exit\(2\)/.test(src);
  check("...and aborts on a refusal", aborts, why(aborts, "the refusal does not stop the script"));

  const executes = /for\s*\(\s*const\s+step\s+of\s+plan\.steps\s*\)/.test(src);
  check(
    "...and executes the steps in the order the plan gave them",
    executes,
    why(executes, "release.mjs does not iterate plan.steps")
  );

  // The commands must not exist in both places: a second copy in the script is
  // the one that would drift from the one the check asserts.
  const inlineCommands = /npm version \$\{version\}|git commit -m/.test(src);
  check(
    "the step commands are written in exactly one place",
    !inlineCommands,
    why(!inlineCommands, "release.mjs still spells out a step command")
  );
  const inline = (src.match(/git status --porcelain/g) || []).length;
  check("the clean-tree question is asked in exactly one place", inline === 0, `${inline} inline uses in release.mjs`);
}

console.log(`\n${failures.length === 0 ? "all release-guard checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\nrelease-guard checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
