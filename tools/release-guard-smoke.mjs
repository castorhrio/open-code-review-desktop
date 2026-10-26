// Checks the release guard: the two states a release must not start from, and
// the plan a release walks once it has passed them.
//
// `tools/release.mjs` is not run here — it bumps the version, commits, and
// packages the app, so the only things a check may touch are the decision it
// makes before any of that and the order it executes afterwards. Both live in
// `release-guard.mjs`: `capture` is injected so the guard can be fed a git that
// answers anything, and `executeRelease` takes its runners as arguments so the
// plan can be executed against doubles that only record. Nothing here reads
// `release.mjs`'s source — a check on how the file is written goes red on a
// rewrite that behaves identically.
//
//   - a detached HEAD is the quiet one: every later step succeeds, and the
//     release commit lands on a commit no branch points at, so the next
//     `git switch main` makes the whole release unreachable.
//   - a dirty tree ships someone else's half-finished work.
//
// Run with `npm run audit:release`.
import { executeRelease, releasePrecheck, planRelease, RELEASE_GUARD_MESSAGES, RELEASE_STEPS } from "./release-guard.mjs";

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

/* ---- the plan is executed in its own order, by the runners it is given ----
 * This block used to read `tools/release.mjs` and match its source shape: that
 * it calls `planRelease({ version, capture })`, that it loops with
 * `for (const step of plan.steps)`, that no step command is spelled out inline.
 * Those are properties of how the file was written, not of what a release
 * executes — a `while` loop or a renamed local would have turned the check red
 * while the same commands ran in the same order.
 *
 * `executeRelease(plan, { run, runDist })` is the contract now, so the doubles
 * below record what was actually executed: which runner each step went to, in
 * which order, and that a refusal executes nothing at all. `release.mjs` keeps
 * only the two things only it can do — build the plan from real `git` and spawn
 * the real commands.
 */
{
  const clean = fakeGit({ [SYMBOLIC]: "main\n", [STATUS]: "" });
  const plan = planRelease({ version: "0.1.14", capture: clean.capture });

  const ran = [];
  const packaged = [];
  const answer = executeRelease(plan, {
    run: (step) => ran.push(step.command),
    runDist: (step) => packaged.push(step.command),
  });

  check("executing a clean plan runs every step but the precheck", answer.ok === true && answer.ran.join(" -> ") === RELEASE_STEPS.slice(1).join(" -> "), JSON.stringify(answer));
  check(
    "and the commands ran in the plan's order, each exactly once",
    ran.join(" | ") === [
      "npm version 0.1.14 --no-git-tag-version",
      'git add package.json package-lock.json && git commit -m "chore(release): 0.1.14"',
      "npm run audit",
      "npm run audit:secrets",
    ].join(" | "),
    ran.join(" | ")
  );
  check(
    "and packaging is the one step that goes through the fallback runner",
    packaged.length === 1 && packaged[0] === "npm run dist:win",
    JSON.stringify(packaged)
  );
  check(
    "and the key scan runs after packaging, over the packages it produced",
    answer.ran[answer.ran.length - 1] === "secret-scan" && answer.ran[answer.ran.length - 2] === "dist",
    answer.ran.join(" -> ")
  );

  // A refusal is not a shorter run: it is no run. Both refusal shapes go through
  // the same assertion, because "the precheck answered no" is the only fact that
  // matters — the runners are never consulted.
  for (const [label, answers] of [
    ["a detached HEAD", { [SYMBOLIC]: "throw" }],
    ["a dirty tree", { [SYMBOLIC]: "main\n", [STATUS]: " M package.json\n" }],
  ]) {
    const g = fakeGit(answers);
    const refused = planRelease({ version: "0.1.14", capture: g.capture });
    const calls = [];
    const refusedAnswer = executeRelease(refused, {
      run: (step) => calls.push(step.command),
      runDist: (step) => calls.push(`dist:${step.command}`),
    });
    check(
      `executing the plan of ${label} runs nothing`,
      refusedAnswer.ok === false && refusedAnswer.ran.length === 0 && calls.length === 0,
      JSON.stringify([refusedAnswer, calls])
    );
  }

  // A caller that only has one runner does not have to spell out the second: the
  // packaging step falls back to `run` rather than being skipped, because a step
  // that silently does not run is the failure mode this whole plan exists to
  // prevent.
  const oneRunner = [];
  executeRelease(plan, { run: (step) => oneRunner.push(step.name) });
  check(
    "with a single runner, packaging still runs through it",
    oneRunner.includes("dist") && oneRunner.join(" -> ") === RELEASE_STEPS.slice(1).join(" -> "),
    oneRunner.join(" -> ")
  );

  // A runner that throws — the script's own runner exits the process on a failed
  // command — must end the sequence. Nothing after the failed step runs, and the
  // throw is the caller's to report.
  const beforeThrow = [];
  let threw = null;
  try {
    executeRelease(plan, {
      run: (step) => {
        beforeThrow.push(step.name);
        if (step.name === "audit") throw new Error("audit failed");
      },
      runDist: (step) => beforeThrow.push(step.name),
    });
  } catch (err) {
    threw = err;
  }
  check(
    "a step that fails stops the release there",
    threw !== null && beforeThrow.join(" -> ") === "bump -> commit -> audit",
    `${beforeThrow.join(" -> ")} / ${threw && threw.message}`
  );

  // Refusals are answered as data, and an unreadable plan is not a pass either:
  // `null`/`undefined` must not read as "no steps to run, so nothing to worry
  // about".
  for (const empty of [null, undefined, {}]) {
    const calls = [];
    const answerForEmpty = executeRelease(empty, { run: () => calls.push("run"), runDist: () => calls.push("dist") });
    check(
      `a plan that is ${JSON.stringify(empty) || "missing"} executes nothing and says so`,
      answerForEmpty.ok === false && answerForEmpty.ran.length === 0 && calls.length === 0,
      JSON.stringify([answerForEmpty, calls])
    );
  }
}

console.log(`\n${failures.length === 0 ? "all release-guard checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\nrelease-guard checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
