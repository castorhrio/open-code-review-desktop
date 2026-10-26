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
// It also covers the two ends of the release that used to be unreachable because
// they lived in `release.mjs`: the version argument (`parseVersion`, refused
// before a single step is planned) and the packaging fallback's sequence
// (`retryDistIntoFallback` — clear the stale output dir, retry the build into it,
// move the result out), which is the path a same-version retry takes.
//
// And the machine: every command in the release packages a Windows build and the
// fallback moves `win-unpacked`, so `parsePlatform` refuses any other platform
// before the version is even read — with the two commands that do work there,
// because "unsupported platform" sends the reader looking for a flag that does not
// exist. The call site in `release.mjs` is the one thing that has to be read as a
// source line rather than called: importing that script starts packaging.
//
// And the answer a *failed* release gives: `stepFailure` (a non-zero status
// becomes a throw carrying it), `err.failed` / `err.ran` (which step stopped it,
// which ones completed) and `runRelease` (the lines and exit status the script
// acts on). Those were the last part of the release that could only be described
// — the runner exited, so the process never got to report how far it had got.
//
// The move of the fallback's output into `release/` is pinned from both sides:
// what the skip list names stays behind, and what it has never heard of is moved
// (the fallback dir is deleted at the end, so anything not moved is destroyed).
// Both answers are *sorted*: the walk is over `readdirSync`, whose order nothing
// promises, and the release log prints these lists — so the order has to be the
// code's, and a directory that answers in another order has its own fixture.
//
// The last block walks the same move against a *real* temp root
// (`fs.mkdtempSync`): a fake disk proves the order of the calls, a real one
// proves the calls are the right ones.
//
// Run with `npm run audit:release`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearStaleDistOutput, DIST_SKIP, fallbackOutputDir, relocateDistOutput, retryDistIntoFallback } from "./release-dist.mjs";
import {
  executeRelease,
  parsePlatform,
  parseVersion,
  releaseAbort,
  releasePrecheck,
  planRelease,
  runRelease,
  stepFailure,
  RELEASE_GUARD_MESSAGES,
  RELEASE_PLATFORM,
  RELEASE_STEPS,
  RELEASE_USAGE,
} from "./release-guard.mjs";

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

/* ---- the version argument is refused before a single step is planned ----
 * It used to be a regex test and a `process.exit(2)` at the top of
 * `release.mjs`, which is the one part of the release no check could reach:
 * importing the script starts packaging. The version decides the commit message,
 * the output dir and every artefact's name, so a bad one is refused with a
 * sentence here rather than by `npm version` three steps later.
 */
{
  const good = parseVersion(["0.1.14"]);
  check("a version argument plans a release", good.ok === true && good.version === "0.1.14", JSON.stringify(good));
  check("...and carries no error line", good.error === undefined, JSON.stringify(good));
  check(
    "...and surrounding whitespace is not a reason to refuse",
    JSON.stringify(parseVersion([" 0.1.14\n"])) === JSON.stringify(good),
    JSON.stringify(parseVersion([" 0.1.14\n"]))
  );

  for (const argv of [[], ["  "], [undefined]]) {
    const answer = parseVersion(argv);
    check(
      `no version (${JSON.stringify(argv)}) is refused as missing`,
      answer.ok === false && answer.reason === "missing",
      JSON.stringify(answer)
    );
    check(
      "...with the usage sentence and nothing else to guess at",
      answer.error === `${RELEASE_USAGE} — no version given`,
      answer.error
    );
  }

  // `v0.1.14` is what the tag and the GitHub release are called, so it is the
  // mistake people actually make — and `npm version v0.1.14` would create a
  // `v`-prefixed tag while the output dir stayed `release-0.1.14`.
  for (const bad of ["1.2", "0.1", "0.1.14-beta", "0.1.14.1", "latest", "v0.1.14", "../0.1.14"]) {
    const answer = parseVersion([bad]);
    check(`"${bad}" is refused`, answer.ok === false && answer.reason === "invalid", JSON.stringify(answer));
    check(
      `...with the usage sentence quoting what was given`,
      typeof answer.error === "string" && answer.error.startsWith(RELEASE_USAGE) && answer.error.includes(bad),
      answer.error
    );
  }
  check(
    "a v-prefixed version says to drop the v, because that is the mistake it is",
    /drop the leading "v": 0\.1\.14/.test(parseVersion(["v0.1.14"]).error || ""),
    parseVersion(["v0.1.14"]).error
  );
}

/* ---- the machine is refused before the version is even read ----
 * Everything `tools/release.mjs` does is Windows-shaped: `npm run dist:win`,
 * `electron-builder --win` into a fresh dir, `win-unpacked` moved into `release/`.
 * That was true and unstated, which meant a mac or a linux box got a release that
 * failed somewhere in the middle — after the bump and the commit — with a message
 * from electron-builder about a target it does not have. `parsePlatform` is the
 * refusal, and it is a value so the sentence can be read here.
 *
 * It is *not* a `process.platform` switch over the command names: the move and the
 * fallback are `win-unpacked` all the way down, so a switch would produce a script
 * that looks cross-platform and moves the wrong directory on the platforms it
 * claimed to support.
 */
{
  check("this release path names the one platform it packages for", RELEASE_PLATFORM === "win32", RELEASE_PLATFORM);

  const windows = parsePlatform("win32");
  check("a Windows machine may cut this release", windows.ok === true && windows.reason === "ready" && windows.platform === "win32", JSON.stringify(windows));
  check("...and carries no error line, so the script prints nothing", windows.error === undefined, JSON.stringify(windows));
  check(
    "...and surrounding whitespace is not a reason to refuse",
    JSON.stringify(parsePlatform(" win32\n")) === JSON.stringify(windows),
    JSON.stringify(parsePlatform(" win32\n"))
  );

  for (const other of ["darwin", "linux", "freebsd", "android", "win32-x64", "WIN32", "Windows"]) {
    const answer = parsePlatform(other);
    check(`${other} is refused`, answer.ok === false && answer.reason === "unsupported-platform", JSON.stringify(answer));
    // The sentence has to say *what to do instead*. "unsupported platform" on its
    // own sends the reader looking for a flag that does not exist, and the two
    // commands that do work on that machine are the whole actionable content.
    check(
      "...naming the machine and the two commands that do work there",
      typeof answer.error === "string" &&
        answer.error.includes(`"${other}"`) &&
        /Windows-only/.test(answer.error) &&
        /dist:mac/.test(answer.error) &&
        /dist:linux/.test(answer.error),
      answer.error
    );
    check(
      "...and saying why (the command and the app dir it moves), not only that it is refused",
      /dist:win/.test(answer.error) && /win-unpacked/.test(answer.error),
      answer.error
    );
    // A wrong machine is not a wrong invocation: printing the usage sentence here
    // would tell the reader to fix an argument that is perfectly fine.
    check("...without the version usage line, because the argument was not the problem", !answer.error.includes(RELEASE_USAGE), answer.error);
  }

  // A platform that is empty or not a string is not evidence of Windows. It is
  // what a caller gets after a bad read of `process.platform` — answering "ready"
  // there would let the release start on no information at all. (`undefined` is
  // *not* in this list: it is how you ask for the default argument, i.e. for the
  // real machine, which is the check right below.)
  for (const missing of [null, "", "   ", 42, {}, ["win32"]]) {
    const answer = parsePlatform(missing);
    check(
      `${JSON.stringify(missing) || String(missing)} is refused rather than read as this platform`,
      answer.ok === false && answer.reason === "unsupported-platform",
      JSON.stringify(answer)
    );
    check("...with a sentence that does not put a hole where the machine should be", !/""/.test(answer.error) && /unknown platform/.test(answer.error), answer.error);
  }

  // The default is the real machine, and it answers the same thing the explicit
  // argument does — otherwise the script's `parsePlatform(process.platform)` and
  // the checks above would be testing two different functions.
  check(
    "the default platform is the machine this check is running on",
    parsePlatform().platform === process.platform && parsePlatform().ok === (process.platform === "win32"),
    JSON.stringify(parsePlatform())
  );

  // The one check that reads a source file rather than calling a function, and it
  // is deliberate: `tools/release.mjs` starts packaging the moment it is imported,
  // so the *call site* of this refusal is the only part no fixture can reach.
  // Without it, deleting the guard from the script leaves every check above green
  // while the refusal becomes dead code. Comment lines are stripped first, so the
  // sentence in the header cannot satisfy it on the guard's behalf.
  {
    const ROOT = path.resolve(import.meta.dirname, "..");
    const script = fs
      .readFileSync(path.join(ROOT, "tools", "release.mjs"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    check(
      "the release script refuses the machine before it plans anything",
      /parsePlatform\(\s*process\.platform\s*\)/.test(script),
      "tools/release.mjs does not call parsePlatform(process.platform)"
    );
    check(
      "...printing the module's own sentence, so the words have one home",
      /console\.error\(\s*platform\.error\s*\)/.test(script) && /process\.exit\(\s*2\s*\)/.test(script),
      "tools/release.mjs does not print platform.error and exit 2"
    );
  }
}

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

  // The same contract for the other runner. Packaging is the one step that goes
  // through `runDist`, so "a failed step ends the release" has to hold there too
  // — otherwise the two runners would have different failure semantics and only
  // the easier one would be proven. What must not happen after a failed build is
  // the key scan: it would scan the packages the previous release left in
  // `release/` and report them as this one's.
  const beforePackagingThrow = [];
  let packagingThrew = null;
  try {
    executeRelease(plan, {
      run: (step) => beforePackagingThrow.push(step.name),
      runDist: (step) => {
        beforePackagingThrow.push(step.name);
        throw new Error("electron-builder exited 1");
      },
    });
  } catch (err) {
    packagingThrew = err;
  }
  check(
    "packaging that fails stops the release before the key scan",
    packagingThrew !== null && beforePackagingThrow.join(" -> ") === "bump -> commit -> audit -> dist",
    `${beforePackagingThrow.join(" -> ")} / ${packagingThrew && packagingThrew.message}`
  );

  // A throw is the only answer a half-done release ever gets, so "how far did it
  // get" has to ride on the exception: the steps that completed, in order, and
  // never the one that failed. Written as a three-step plan because the whole
  // claim is about the boundary between step two and step one.
  {
    const steps = (...names) => ({ ok: true, steps: names.map((name) => ({ name, command: `cmd:${name}` })) });
    const threeSteps = steps("step1", "step2", "step3");
    // The packaging step goes through the other runner, and a build that fails is
    // the likely one, so the same contract has to hold with `dist` in the middle
    // — a plan whose second step is `dist` is the only way to get there.
    for (const [label, plan, runner] of [
      ["run", threeSteps, { run: (step) => { if (step.name === "step2") throw new Error("boom"); } }],
      [
        "runDist",
        steps("step1", "dist", "step3"),
        { run: () => {}, runDist: (step) => { if (step.name === "dist") throw new Error("boom"); } },
      ],
    ]) {
      let threw = null;
      try {
        executeRelease(plan, runner);
      } catch (err) {
        threw = err;
      }
      check(
        `a step that throws out of ${label} carries the steps that completed, and not the failed one`,
        threw !== null && Array.isArray(threw.ran) && threw.ran.join(" -> ") === "step1",
        JSON.stringify(threw && threw.ran)
      );
    }

    // The list is the completed steps and nothing else: a caller that trusted it
    // to name the failure would report step2 as done.
    let partial = null;
    try {
      executeRelease(threeSteps, {
        run: (step) => {
          if (step.name === "step3") throw new Error("boom");
        },
      });
    } catch (err) {
      partial = err;
    }
    check(
      "...so two completed steps are named, in order, when the third fails",
      partial !== null && partial.ran.join(" -> ") === "step1 -> step2",
      JSON.stringify(partial && partial.ran)
    );

    // A runner is free to throw something that is not an Error; that is still
    // the caller's answer to report, not a second failure while recording it.
    let rawThrew = null;
    try {
      executeRelease(threeSteps, {
        run: () => {
          throw "plain string failure";
        },
      });
    } catch (err) {
      rawThrew = err;
    }
    check(
      "...and a runner that throws a non-Error is re-thrown exactly as it was",
      rawThrew === "plain string failure",
      JSON.stringify(rawThrew)
    );
  }

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

/* ---- a failed release is answered, not thrown at the process ----
 * The previous round added `err.ran` so a failed release could say how far it got.
 * On the real path that was a claim with nothing behind it: `tools/release.mjs`'s
 * runner called `process.exit` on a non-zero status, so the process was gone
 * before the list could ride on anything and only the smoke's doubles ever saw
 * it. The runners throw now — carrying the failed command's exit status in
 * `code` — and `runRelease` is the single place that turns the throw into what
 * the script acts on. Both halves are values, so both are checked here.
 */
{
  const steps = (...names) => ({ ok: true, steps: names.map((name) => ({ name, command: `cmd:${name}` })) });
  const plan = steps("bump", "commit", "audit", "dist", "secret-scan");

  // The real runner's shape: `spawnSync`'s non-zero status becomes an `Error`
  // carrying that status, so the release's exit status is the failed command's.
  const failsAt = (name, status) => ({
    run: (step) => {
      if (step.name === name) throw Object.assign(new Error(`\`cmd:${name}\` exited ${status}`), { code: status });
    },
    runDist: (step) => {
      if (step.name === name) throw Object.assign(new Error(`\`cmd:${name}\` exited ${status}`), { code: status });
    },
  });

  const outcome = runRelease(plan, failsAt("audit", 7));
  check("a failed step is answered, not thrown out of the release", outcome.ok === false && outcome.reason === "failed", JSON.stringify(outcome));
  check("...with the failing command's own exit status", outcome.code === 7, JSON.stringify(outcome.code));
  check(
    "...naming the step that failed and the ones that had completed",
    /at step audit/.test(outcome.error || "") && /bump -> commit/.test(outcome.error || ""),
    outcome.error
  );
  check("...keeping the runner's own sentence, which names the command", /cmd:audit` exited 7/.test(outcome.error || ""), outcome.error);
  check(
    "...and answering the completed steps, so a caller can log them",
    outcome.ran.join(" -> ") === "bump -> commit",
    JSON.stringify(outcome.ran)
  );

  // The runner's own throw, which is the only reason the list above is reachable
  // on the real path: `tools/release.mjs` turns a non-zero status into this and
  // `runRelease` reads it back. Both ends are values, so the pair can be walked —
  // and a `spawnSync` result that was killed by a signal (`status: null`) has to
  // land on 1, not on `NaN` or on a sentence with a hole in it.
  {
    const exited = stepFailure("npm run audit", 7);
    check("a failed command's throw carries its exit status", exited && exited.code === 7, JSON.stringify(exited && exited.code));
    check("...and names the command that failed", /npm run audit/.test(exited.message) && /exited 7/.test(exited.message), exited.message);
    const killed = stepFailure("npm run dist:win", null);
    check(
      "a command killed by a signal is reported as exited 1, not as a hole in the sentence",
      killed.code === 1 && /exited 1/.test(killed.message),
      `${killed.code} / ${killed.message}`
    );
    const walked = runRelease(
      { ok: true, steps: [{ name: "audit", command: "npm run audit" }] },
      {
        run: (step) => {
          throw stepFailure(step.command, 4);
        },
        runDist: () => {},
      }
    );
    check(
      "...and the two ends agree: a runner's throw becomes that exit status",
      walked.ok === false && walked.code === 4 && /npm run audit/.test(walked.error || ""),
      JSON.stringify([walked.code, walked.error])
    );
  }

  // The same for the other runner: packaging failing is the likely one, and the
  // exit status has to survive that path too.
  const packaging = runRelease(plan, failsAt("dist", 3));
  check(
    "a failed packaging step is answered the same way, with its status",
    packaging.ok === false && packaging.code === 3 && packaging.ran.join(" -> ") === "bump -> commit -> audit",
    JSON.stringify(packaging)
  );
  check(
    "...so the key scan is not reported as having run over a build that failed",
    !packaging.ran.includes("secret-scan"),
    JSON.stringify(packaging.ran)
  );

  // Every step in turn, failed: "answered with a non-zero status and how far it
  // got" has to hold at each position, not only where a human happened to write a
  // fixture. The `ran` prefix is what the release log reads back at that moment —
  // a position that answered the wrong prefix would send the reader to the wrong
  // half of the disk, and one that named the *failed* step would send them there
  // believing it had completed.
  for (const [index, name] of plan.steps.map((step) => [plan.steps.indexOf(step), step.name])) {
    const before = plan.steps.slice(0, index).map((step) => step.name);
    const progress = before.length ? `after: ${before.join(" -> ")}` : "with no step completed";
    const answer = runRelease(plan, failsAt(name, 5));
    check(
      `a failure at ${name} is answered with that step's exit status`,
      answer.ok === false && answer.reason === "failed" && answer.code === 5,
      JSON.stringify([answer.ok, answer.reason, answer.code])
    );
    check(
      `...naming the steps that had completed before ${name}, and not ${name} itself`,
      answer.ran.join(" -> ") === before.join(" -> ") && !answer.ran.includes(name),
      JSON.stringify(answer.ran)
    );
    check(
      `...and saying where it stopped (${progress})`,
      answer.error.includes(`at step ${name}`) && answer.error.includes(progress),
      answer.error
    );
    // Nothing after the failure is ever claimed: the key scan over a half-built
    // release is the one consequence the reader would not think to check.
    check(
      `...so no step after ${name} is reported as having run`,
      !answer.ran.includes("secret-scan") || name === "secret-scan",
      JSON.stringify(answer.ran)
    );
  }

  // A successful release is the same shape with `ok: true`, so the caller has one
  // branch to read rather than two.
  const finished = runRelease(plan, { run: () => {}, runDist: () => {} });
  check(
    "a release that finishes is answered ok, with every step",
    finished.ok === true && finished.ran.join(" -> ") === RELEASE_STEPS.slice(1).join(" -> "),
    JSON.stringify(finished)
  );

  // A runner that fails without an exit status still must not exit 0, and an
  // error that carries an errno string in `code` (`ENOENT`) is not an exit status
  // — turning it into one would report a status the command never had.
  for (const [label, thrown, code] of [
    ["a plain Error", new Error("boom"), 1],
    ["a non-Error throw", "plain string failure", 1],
    ["an Error with an errno string in code", Object.assign(new Error("spawn failed"), { code: "ENOENT" }), 1],
    ["an Error with no message", new Error(""), 1],
    ["an Error carrying status 9", Object.assign(new Error("exited 9"), { status: 9 }), 9],
  ]) {
    const answer = runRelease(plan, {
      run: () => {
        throw thrown;
      },
      runDist: () => {},
    });
    check(
      `${label} still answers a non-zero status (${code})`,
      answer.ok === false && answer.code === code,
      JSON.stringify([answer.ok, answer.code])
    );
    check(
      "...and never an empty error line",
      typeof answer.error === "string" && answer.error.trim().length > 0 && /release aborted/.test(answer.error),
      answer.error
    );
  }

  // The lines themselves, because they are what a human reads at that moment.
  {
    const abort = releaseAbort(Object.assign(new Error("`npm run dist:win` exited 1"), { code: 1, ran: ["bump", "commit"], failed: "dist" }));
    check("the abort sentence names the step, where it got to, and what it said", abort.lines[0].includes("at step dist") && abort.lines[0].includes("bump -> commit") && abort.lines[0].includes("exited 1"), abort.lines[0]);
    check(
      "...and the second line says the tree was already changed, rather than implying nothing happened",
      /the steps above already ran/.test(abort.lines[1] || "") &&
        /not the one it started from/.test(abort.lines[1] || "") &&
        !/did not get as far/.test(abort.lines[1] || ""),
      abort.lines[1]
    );
    check("...with the same list and status the answer carries", abort.code === 1 && abort.ran.join(" -> ") === "bump -> commit" && abort.failed === "dist", JSON.stringify([abort.code, abort.ran, abort.failed]));

    const nothingRan = releaseAbort(new Error("git commit exploded"));
    check(
      "a failure before any step completed says so, instead of listing an empty progress",
      /no step completed/.test(nothingRan.lines[0]) && /did not get as far as changing the tree/.test(nothingRan.lines[1] || "") && nothingRan.ran.length === 0,
      JSON.stringify(nothingRan.lines)
    );

    // A frozen error cannot carry `ran`, so the list has to come from somewhere
    // else rather than being silently lost on the floor.
    const frozen = Object.freeze(new Error("frozen"));
    const frozenAbort = releaseAbort(frozen);
    check(
      "an error that cannot be annotated is still reported, without inventing progress",
      frozenAbort.code === 1 && frozenAbort.ran.length === 0 && /frozen/.test(frozenAbort.lines[0]),
      JSON.stringify(frozenAbort)
    );

    // The list is copied, not handed out by reference: the caller keeps it for a
    // log while `runRelease`'s answer has already been read.
    const annotatable = Object.assign(new Error("boom"), { ran: ["bump"] });
    const copied = releaseAbort(annotatable);
    copied.ran.push("not a step");
    check("the completed-step list in the answer is a copy", annotatable.ran.join(" ->") === "bump", JSON.stringify(annotatable.ran));
  }

  // A refused plan answers a status of its own, so a shell that only sees `$?`
  // can tell "refused before anything ran" from "failed halfway".
  {
    const g = fakeGit({ [SYMBOLIC]: "throw" });
    const refused = planRelease({ version: "0.1.14", capture: g.capture });
    const answer = runRelease(refused, { run: () => check("a refused plan runs nothing", false), runDist: () => {} });
    check(
      "a refused plan is answered with the refusal status and no steps",
      answer.ok === false && answer.code === 2 && answer.ran.length === 0,
      JSON.stringify(answer)
    );
    check(
      "...and carries the refusal's own sentence, not a generic one",
      /git switch/.test(answer.error || ""),
      answer.error
    );
  }

  // `err.failed` is what the abort sentence is built from, so it has to be on the
  // throw itself — not only in `releaseAbort`'s answer.
  {
    let threw = null;
    try {
      executeRelease(plan, {
        run: (step) => {
          if (step.name === "commit") throw new Error("commit failed");
        },
        runDist: () => {},
      });
    } catch (err) {
      threw = err;
    }
    check(
      "the throw names the failing step beside the completed ones",
      threw !== null && threw.failed === "commit" && threw.ran.join(" -> ") === "bump",
      JSON.stringify([threw && threw.failed, threw && threw.ran])
    );
  }
}

/* ---- the packaging fallback moves a build without losing it ----
 * `tools/release.mjs` retries packaging into `release-<version>/` when
 * electron-builder cannot rename into a locked `release/win-unpacked`, and then
 * moves the artefacts across. That move is the only place in the release chain
 * that rearranges the real disk without a command behind it, so nothing above
 * could reach it: importing `release.mjs` starts packaging. `relocateDistOutput`
 * takes the filesystem and the path module as arguments, so the whole path can
 * be walked here against a fake disk.
 *
 * The three facts being pinned are the ones a well-meaning rewrite loses:
 * `builder-debug.yml` describes the *temp* output dir and must not overwrite the
 * real one's, the previous `win-unpacked` has to go before the new one is
 * renamed into its place (a rename onto a non-empty directory fails on Windows,
 * the platform this path exists for), and the fallback dir is deleted *last* —
 * deleting it first would remove exactly the files the move exists to keep.
 */
{
  const posix = path.posix;

  /**
   * A fake disk: nested objects, a directory being an object and a file being
   * `null`. Uniform on purpose — a release artefact and an app dir are moved by
   * the same call, and the check has to see both.
   *
   * `renameSync` refuses when the target exists — that is Windows' answer
   * (`EEXIST`/`EPERM`), and it makes "the stale dir was removed first" a
   * behavioural fact rather than a comment about op order.
   */
  function fakeDisk(root) {
    const ops = [];
    const parts = (p) => p.split("/").filter(Boolean);
    const lookup = (names) => {
      let node = root;
      for (const name of names) {
        if (!node || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, name)) return undefined;
        node = node[name];
      }
      return node;
    };
    const resolve = (p) => {
      const names = parts(p);
      if (names.length === 0) return { parent: null, name: "", exists: true };
      const parent = lookup(names.slice(0, -1));
      const name = names[names.length - 1];
      const exists = Boolean(parent) && typeof parent === "object" && Object.prototype.hasOwnProperty.call(parent, name);
      return { parent, name, exists };
    };
    const fs = {
      existsSync: (p) => resolve(p).exists,
      readdirSync: (p) => {
        const node = lookup(parts(p));
        if (!node || typeof node !== "object") throw new Error(`ENOENT: no such directory, scandir '${p}'`);
        return Object.keys(node);
      },
      renameSync: (from, to) => {
        const source = resolve(from);
        if (!source.exists) throw new Error(`ENOENT: no such file or directory, rename '${from}'`);
        const target = resolve(to);
        if (!target.parent) throw new Error(`ENOENT: no such directory, rename '${to}'`);
        if (target.exists) throw new Error(`EEXIST: '${to}' already exists`);
        target.parent[target.name] = source.parent[source.name];
        delete source.parent[source.name];
        ops.push({ op: "rename", from, to });
      },
      rmSync: (p) => {
        const target = resolve(p);
        if (target.exists) delete target.parent[target.name];
        ops.push({ op: "rm", path: p });
      },
      mkdirSync: (p) => {
        let node = root;
        for (const name of parts(p)) {
          if (!node[name] || typeof node[name] !== "object") node[name] = {};
          node = node[name];
        }
        ops.push({ op: "mkdir", path: p });
      },
    };
    const index = (pred) => ops.findIndex(pred);
    return { fs, ops, index, lookup: (p) => lookup(parts(p)), resolve };
  }

  const FROM = "/release-0.1.14";
  const TO = "/release";
  const SETUP = "open-code-review-desktop-0.1.14-setup.exe";
  const PORTABLE = "open-code-review-desktop-0.1.14-portable.exe";
  const LATEST = "latest.yml";

  /* the ordinary fallback: a previous release/win-unpacked is in the way */
  {
    const d = fakeDisk({
      "release-0.1.14": {
        "win-unpacked": { "open-code-review-desktop.exe": null },
        "builder-debug.yml": null,
        [SETUP]: null,
        [PORTABLE]: null,
        [LATEST]: null,
      },
      release: {
        "win-unpacked": { "stale.exe": null },
        "open-code-review-desktop-0.1.13-setup.exe": null,
      },
    });
    // Caught rather than left to crash the run: the first thing a rewrite gets
    // wrong here is the order below, and "the move threw" has to read as a failed
    // check with the platform's words, not as a stack trace that stops the suite.
    let answer = null;
    let moveError = null;
    try {
      answer = relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      moveError = err;
    }
    check("the fallback move completes with a previous app dir in the way", moveError === null, moveError && moveError.message);
    if (!answer) answer = { moved: [], skipped: [], replaced: null };

    // Sorted, not in the directory's own order: the walk is over `readdirSync`,
    // whose order nothing promises, so the answer is a sorted set. This table
    // happens to be listed alphabetically, which is why the block after this one
    // exists — an unsorted expectation would pass here and fail on release day.
    check(
      "the fallback moves every artefact into release/",
      answer.moved.join(" | ") === [LATEST, PORTABLE, SETUP].sort().join(" | "),
      answer.moved.join(" | ")
    );
    // Only `builder-debug.yml` is *left behind*: `win-unpacked` was moved as a
    // directory before the loop ran, so it is no longer in the temp dir to skip.
    // Both are the entries the temp output dir owns rather than the release's.
    check(
      "...leaving the temp output dir's builder-debug.yml behind instead of shipping it",
      answer.skipped.join(" | ") === "builder-debug.yml",
      answer.skipped.join(" | ")
    );
    check("...and saying that it replaced a previous app dir", answer.replaced === true, JSON.stringify(answer));

    check(
      "the temp dir's builder-debug.yml never overwrites the real one",
      !d.ops.some((o) => o.op === "rename" && o.from === `${FROM}/builder-debug.yml`),
      JSON.stringify(d.ops)
    );
    const staleIndex = d.index((o) => o.op === "rm" && o.path === `${TO}/win-unpacked`);
    const freshIndex = d.index((o) => o.op === "rename" && o.from === `${FROM}/win-unpacked`);
    check(
      "the previous win-unpacked is removed before the new one is renamed into place",
      staleIndex >= 0 && freshIndex > staleIndex,
      `${staleIndex} -> ${freshIndex}`
    );
    check(
      "...and the new app dir is the one that lands there",
      JSON.stringify(d.lookup(`${TO}/win-unpacked`)) === JSON.stringify({ "open-code-review-desktop.exe": null }),
      JSON.stringify(d.lookup(`${TO}/win-unpacked`))
    );
    const last = d.ops[d.ops.length - 1];
    check(
      "the fallback dir is deleted last, after everything worth keeping has left it",
      Boolean(last) && last.op === "rm" && last.path === FROM,
      JSON.stringify(last)
    );
    check(
      "...so it is gone and release/ holds the old and the new artefacts",
      !d.resolve(FROM).exists && Object.keys(d.lookup(TO)).length === 5,
      JSON.stringify(Object.keys(d.lookup(TO) || {}))
    );
  }

  /* the answer's order is the code's, not the directory's */
  {
    // `fs.readdirSync` answers in whatever order the filesystem holds — the table
    // below is listed deliberately *not* alphabetically, which is the shape a real
    // directory can have and the one the block above cannot produce (it is
    // alphabetical there, so an unsorted `moved` would have passed).
    //
    // This is the difference between a release log that says the same thing on
    // every machine and one whose order changes between runs: the list is printed.
    const d = fakeDisk({
      "release-0.1.14": {
        [SETUP]: null,
        "win-unpacked": { "open-code-review-desktop.exe": null },
        [LATEST]: null,
        "builder-debug.yml": null,
        [PORTABLE]: null,
      },
      release: {},
    });
    const answeredIn = d.fs.readdirSync(FROM);
    let answer = null;
    let threw = null;
    try {
      answer = relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check("the fallback move completes whatever order the directory answers in", threw === null, threw && threw.message);
    if (!answer) answer = { moved: [], skipped: [] };
    check(
      "...and the moved list comes back sorted, not in the directory's own order",
      answer.moved.join(" | ") === [LATEST, PORTABLE, SETUP].sort().join(" | "),
      answer.moved.join(" | ")
    );
    check(
      "...which really is a different order from the one the directory gave, so this is not a coincidence",
      answeredIn.join(" | ") !== answer.moved.join(" | "),
      answeredIn.join(" | ")
    );
    check(
      "...and nothing was moved twice or skipped by the sort",
      answer.moved.length === new Set(answer.moved).size && answer.moved.length === 3,
      JSON.stringify(answer.moved)
    );
    check(
      "...while the one entry the temp dir owns is still the only one left behind",
      answer.skipped.join(" | ") === "builder-debug.yml",
      answer.skipped.join(" | ")
    );
  }

  /* an entry the skip list has never heard of is moved, not deleted with the dir */
  {
    // `DIST_SKIP` is a denylist of what the *temp* output dir owns, so an entry
    // it does not name has exactly two possible fates: moved into `release/`, or
    // destroyed when the fallback dir is removed at the end of the move. This is
    // the case that decides which — an artefact electron-builder writes today
    // (`builder-effective-config.yaml`) but which was never added to the list.
    // Without it, "the unknown file was silently left behind and then deleted"
    // looks exactly like a green run.
    const EFFECTIVE = "builder-effective-config.yaml";
    const d = fakeDisk({
      "release-0.1.14": {
        "win-unpacked": { "open-code-review-desktop.exe": null },
        "builder-debug.yml": null,
        [EFFECTIVE]: null,
        [SETUP]: null,
      },
      release: {},
    });
    let answer = null;
    let threw = null;
    try {
      answer = relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check("the fallback move completes with an unlisted artefact in the temp dir", threw === null, threw && threw.message);
    if (!answer) answer = { moved: [], skipped: [], replaced: null };
    check(
      "an artefact the skip list has never heard of is moved into release/, not left to be deleted",
      answer.moved.includes(EFFECTIVE),
      answer.moved.join(" | ")
    );
    check(
      "...and it is still in release/ after the fallback dir is gone",
      d.lookup(`${TO}/${EFFECTIVE}`) !== undefined && !d.resolve(FROM).exists,
      JSON.stringify({ inRelease: d.lookup(`${TO}/${EFFECTIVE}`), fallbackGone: !d.resolve(FROM).exists })
    );
    check(
      "...while the two entries the temp dir owns are the only ones left behind",
      answer.skipped.join(" | ") === "builder-debug.yml",
      answer.skipped.join(" | ")
    );
    // The list itself, because the sentence above only holds while it stays this
    // short: a third name added here starts deleting build output instead of
    // shipping it, and that has to be a deliberate, visible edit.
    check(
      "the skip list is still exactly the temp output dir's own two entries",
      DIST_SKIP.join(" | ") === "win-unpacked | builder-debug.yml",
      DIST_SKIP.join(" | ")
    );
  }

  /* first fallback in a clean tree: nothing to replace, and release/ may not exist */
  {
    const d = fakeDisk({
      "release-0.1.14": {
        "win-unpacked": { "open-code-review-desktop.exe": null },
        "builder-debug.yml": null,
        [SETUP]: null,
      },
    });
    // Caught like the blocks around it: a rewrite that empties the fallback dir
    // before renaming out of it throws here, and that must read as a failed check
    // rather than stopping the suite before the real-disk block.
    let answer = null;
    let threw = null;
    try {
      answer = relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check("a fallback with no previous build completes", threw === null, threw && threw.message);
    if (!answer) answer = { moved: [], skipped: [], replaced: null };
    check("...and replaces nothing", answer.replaced === false, JSON.stringify(answer));
    check(
      "...and does not remove an app dir that is not there",
      !d.ops.some((o) => o.op === "rm" && o.path === `${TO}/win-unpacked`),
      JSON.stringify(d.ops)
    );
    check(
      "and creates release/ before the first rename, because the failed build made no output dir",
      d.index((o) => o.op === "mkdir" && o.path === TO) === 0 &&
        d.index((o) => o.op === "mkdir" && o.path === TO) < d.index((o) => o.op === "rename"),
      JSON.stringify(d.ops)
    );
    const last = d.ops[d.ops.length - 1];
    check(
      "...and still ends by deleting the fallback dir",
      Boolean(last) && last.op === "rm" && last.path === FROM,
      JSON.stringify(last)
    );
  }

  /* nothing to move: say so, and touch nothing */
  {
    const d = fakeDisk({ "release-0.1.14": { "builder-debug.yml": null }, release: { "win-unpacked": {} } });
    let threw = null;
    try {
      relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check(
      "a retried build that produced no app dir is refused with a sentence naming the path",
      threw !== null && /nothing to relocate/.test(threw.message) && threw.message.includes(`${FROM}/win-unpacked`),
      threw && threw.message
    );
    check("...before anything on the disk is touched", d.ops.length === 0, JSON.stringify(d.ops));
  }

  /* a fallback dir that exists but holds nothing is refused, not reported as a move */
  {
    // The stale dir a same-version retry leaves behind is cleared *before* the
    // build, so an empty one means the retried build produced no app dir at all.
    // Answering `moved: []` and deleting it would let the caller log
    // "relocated 1 into release/" (`moved.length + 1`) for a build that produced
    // nothing — a green line for a failed packaging run, which is the exact
    // failure mode this whole guard exists to prevent.
    const d = fakeDisk({ "release-0.1.14": {}, release: {} });
    let threw = null;
    try {
      relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check(
      "an empty fallback dir is refused rather than reported as a move of nothing",
      threw !== null && /nothing to relocate/.test(threw.message),
      threw && threw.message
    );
    check(
      "...and the empty dir is left where it is, so the retry has somewhere to build",
      d.resolve(FROM).exists && d.ops.length === 0,
      JSON.stringify(d.ops)
    );
  }

  /* relocating a directory onto itself would delete the build */
  {
    const d = fakeDisk({ "release-0.1.14": { "win-unpacked": { "a.exe": null } } });
    let threw = null;
    try {
      relocateDistOutput({ from: FROM, to: `${FROM}/`, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check("relocating a directory onto itself is refused", threw !== null && /onto itself/.test(threw.message), threw && threw.message);
    check("...without deleting it", d.ops.length === 0 && d.resolve(FROM).exists, JSON.stringify(d.ops));
  }

  /* a move that fails halfway leaves the artefacts where they are */
  {
    const d = fakeDisk({
      "release-0.1.14": { [SETUP]: null, "win-unpacked": { "open-code-review-desktop.exe": null } },
      // A second fallback run against the same output dir finds its own earlier
      // artefact already in place — the rename that cannot land on top of it.
      release: { [SETUP]: null },
    });
    let threw = null;
    try {
      relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    } catch (err) {
      threw = err;
    }
    check(
      "a file that cannot be renamed surfaces as an exception, not as a quiet half-move",
      threw !== null && /EEXIST/.test(threw.message),
      threw && threw.message
    );
    check(
      "...and the fallback dir is not deleted, so what is left can still be moved by hand",
      d.resolve(FROM).exists && !d.ops.some((o) => o.op === "rm" && o.path === FROM),
      JSON.stringify(d.ops)
    );
  }

  /* clearing the stale dir: gone is a no-op, anything else is removed */
  {
    const absent = fakeDisk({ release: {} });
    const nothing = clearStaleDistOutput({ dir: FROM, fs: absent.fs });
    check(
      "clearing a fallback dir that is not there does nothing at all",
      nothing.removed.length === 0 && absent.ops.length === 0,
      JSON.stringify([nothing, absent.ops])
    );

    // The empty leftover is the case that reads as harmless and is not: an
    // existing dir with no entries still makes the retried build's output sit on
    // top of a previous attempt's.
    const empty = fakeDisk({ "release-0.1.14": {} });
    const clearedEmpty = clearStaleDistOutput({ dir: FROM, fs: empty.fs });
    check(
      "an empty leftover fallback dir is removed too, with no entries to name",
      clearedEmpty.removed.length === 0 && !empty.resolve(FROM).exists,
      JSON.stringify([clearedEmpty, empty.ops])
    );

    // A path that is a file rather than a directory still has to go, and its
    // entries cannot be read — that must not become "cannot clear it".
    const file = fakeDisk({ "release-0.1.14": null });
    let threw = null;
    let clearedFile = null;
    try {
      clearedFile = clearStaleDistOutput({ dir: FROM, fs: file.fs });
    } catch (err) {
      threw = err;
    }
    check(
      "a fallback path that is a file is still cleared, without its entries",
      threw === null && clearedFile !== null && clearedFile.removed.length === 0 && !file.resolve(FROM).exists,
      `${threw && threw.message} / ${JSON.stringify(clearedFile)}`
    );

    let noDir = null;
    try {
      clearStaleDistOutput({});
    } catch (err) {
      noDir = err;
    }
    check("clearing without a dir is refused", noDir !== null && /needs a `dir`/.test(noDir.message), noDir && noDir.message);
  }

  /* the retry sequence: clear the stale dir, build into it, move the result out
   * A same-version retry is the normal case here — the first attempt is the one
   * that hit the locked rename. What it left in `release-0.1.14/` (a whole
   * `win-unpacked`, a setup.exe with the very name the new build produces) used
   * to be built on top of, and the move then met names it could not rename over.
   * The three facts that make the sequence safe are asserted here rather than
   * read out of `tools/release.mjs`, which no check can import.
   */
  {
    const d = fakeDisk({
      "release-0.1.14": { "win-unpacked": { "stale.exe": null }, [SETUP]: null },
      release: { [LATEST]: null },
    });
    const built = [];
    let asked = null;
    const answer = retryDistIntoFallback({
      version: "0.1.14",
      root: "/",
      run: (cmd) => {
        // The build must start from an empty output dir. Asserted from inside the
        // runner, because "cleared at some point" is not the property that
        // matters — "cleared before the build" is.
        check(
          "the stale fallback dir is gone before the retried build starts",
          !d.resolve(FROM).exists,
          JSON.stringify(d.ops)
        );
        built.push(cmd);
      },
      relocate: (args) => {
        asked = args;
        return { moved: [SETUP], skipped: [], replaced: false, from: args.from, to: args.to };
      },
      fs: d.fs,
      path: posix,
    });

    // Sorted like the move's answer: `clearStaleDistOutput` reports top-level
    // entries, and the filesystem does not promise an order for them.
    check(
      "the retry clears exactly the stale entries and says how many",
      answer.cleared.removed.join(" | ") === [SETUP, "win-unpacked"].sort().join(" | "),
      JSON.stringify(answer.cleared)
    );
    check(
      "...then builds into the same dir it cleared, named once",
      built.length === 1 &&
        answer.dir === fallbackOutputDir("0.1.14") &&
        built[0] === "npx electron-builder --win -c.directories.output=release-0.1.14",
      JSON.stringify(built)
    );
    check(
      "...and hands the move this attempt's two dirs, and nothing else",
      asked !== null && asked.from === FROM && asked.to === TO,
      JSON.stringify(asked && { from: asked.from, to: asked.to })
    );
    check(
      "...and reports what the move did",
      answer.landed.moved.join(" | ") === SETUP,
      JSON.stringify(answer.landed)
    );
    check(
      "...without touching the real release/ itself",
      !d.ops.some((o) => o.op === "rm" && o.path === TO),
      JSON.stringify(d.ops)
    );
  }

  /* a retried build that fails moves nothing, and does not pretend otherwise */
  {
    const d = fakeDisk({ "release-0.1.14": { [SETUP]: null }, release: {} });
    let threw = null;
    let relocated = false;
    try {
      retryDistIntoFallback({
        version: "0.1.14",
        root: "/",
        // What `tools/release.mjs` passes: its runner exits the process on a
        // failed command, which from here is a throw.
        run: () => {
          throw new Error("electron-builder exited 1");
        },
        relocate: () => {
          relocated = true;
          return { moved: [], skipped: [], replaced: false };
        },
        fs: d.fs,
        path: posix,
      });
    } catch (err) {
      threw = err;
    }
    check(
      "a retried build that fails ends the release with the build's error",
      threw !== null && /electron-builder exited 1/.test(threw.message),
      threw && threw.message
    );
    check("...and nothing is moved out of a dir the build never filled", relocated === false);
    check(
      "...so release/ keeps exactly what it had",
      Object.keys(d.lookup(TO)).length === 0 && !d.ops.some((o) => o.op === "rename"),
      JSON.stringify(d.ops)
    );
  }

  /* the sequence is not runnable without its parts */
  {
    for (const [label, deps] of [
      ["no version", { root: "/", run: () => {} }],
      ["no repo root", { version: "0.1.14", run: () => {} }],
      ["no build runner", { version: "0.1.14", root: "/" }],
    ]) {
      let threw = null;
      try {
        retryDistIntoFallback(deps);
      } catch (err) {
        threw = err;
      }
      check(
        `a retry with ${label} is refused instead of building into somewhere unexpected`,
        threw !== null && /retryDistIntoFallback needs/.test(threw.message),
        threw && threw.message
      );
    }
  }
}

/* ---- the same move, on a real disk ----
 * Everything above drives `relocateDistOutput` and friends through a fake `fs`.
 * That proves the *order* of the calls and the shape of the answer; it does not
 * prove the calls are the right ones, because a double accepts whatever it is
 * handed — "the temp dir's app dir is renamed into `release/`" stayed a claim
 * about names the double made up. The one path in the release chain that
 * rearranges files on the real disk had never been run against the real disk by
 * any check, so its first real run was going to be release day.
 *
 * Each check gets its own root under the OS temp dir and removes it in
 * `finally`: a failed assertion must not leave a `release-0.1.14/` behind, both
 * because the next run would find it and because the fallback dir is exactly
 * what these functions look for.
 */
{
  const SETUP = "open-code-review-desktop-0.1.14-setup.exe";
  const LATEST = "latest.yml";
  const EFFECTIVE = "builder-effective-config.yaml";

  /** Make the parent directories, then write the file — the shape of a build. */
  const put = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  /** A throwaway root, cleaned up whether the check passed or threw. */
  const scratch = (fn) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-release-"));
    try {
      return fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  /* the ordinary fallback, with `fs`/`path` left at their defaults */
  {
    const seen = scratch((root) => {
      const from = path.join(root, "release-0.1.14");
      const to = path.join(root, "release");
      put(path.join(from, "win-unpacked", "open-code-review-desktop.exe"), "this build's app");
      put(path.join(from, SETUP), "this build's setup");
      put(path.join(from, LATEST), "this build's feed");
      put(path.join(from, "builder-debug.yml"), "describes the temp output dir");
      // Not in `DIST_SKIP`: whatever the build wrote beside the installers has to
      // land in `release/`, because the fallback dir is deleted at the end of the
      // move. Pinned on the real disk as well as on the fake one, since a name the
      // fake table made up would prove nothing about the real `readdirSync`.
      put(path.join(from, EFFECTIVE), "the merged config this build ran with");
      put(path.join(to, "win-unpacked", "stale.exe"), "the previous release's app");
      put(path.join(to, "open-code-review-desktop-0.1.13-setup.exe"), "the previous release's setup");
      // No `fs`, no `path`: this is the call `tools/release.mjs` makes. Caught for
      // the same reason the fake-disk block catches it — a rewrite that loses the
      // order throws `EEXIST` here, and that has to read as a failed check with
      // the platform's words rather than as a stack trace that stops the suite.
      let landed = null;
      let moveError = null;
      try {
        landed = relocateDistOutput({ from, to });
      } catch (err) {
        moveError = err;
      }
      return {
        landed,
        moveError,
        appLanded: fs.existsSync(path.join(to, "win-unpacked", "open-code-review-desktop.exe")),
        staleGone: !fs.existsSync(path.join(to, "win-unpacked", "stale.exe")),
        setupLanded: fs.existsSync(path.join(to, SETUP)),
        feedLanded: fs.existsSync(path.join(to, LATEST)),
        previousKept: fs.existsSync(path.join(to, "open-code-review-desktop-0.1.13-setup.exe")),
        debugShipped: fs.existsSync(path.join(to, "builder-debug.yml")),
        effectiveLanded: fs.existsSync(path.join(to, EFFECTIVE)),
        fallbackGone: !fs.existsSync(from),
      };
    });

    check(
      "the fallback move lands the app dir in release/ on a real disk",
      seen.moveError === null && seen.appLanded && seen.landed !== null && seen.landed.replaced === true,
      `${seen.moveError && seen.moveError.message} / ${JSON.stringify([seen.appLanded, seen.landed && seen.landed.replaced])}`
    );
    check(
      "...replacing the previous release's app dir instead of merging into it",
      seen.staleGone,
      JSON.stringify(seen.staleGone)
    );
    check(
      "...and the artefacts land beside it, leaving the previous release's own alone",
      seen.setupLanded && seen.feedLanded && seen.previousKept,
      JSON.stringify([seen.setupLanded, seen.feedLanded, seen.previousKept])
    );
    check(
      "...without shipping the temp output dir's builder-debug.yml",
      !seen.debugShipped && seen.landed !== null && seen.landed.skipped.join(" | ") === "builder-debug.yml",
      JSON.stringify([seen.debugShipped, seen.landed && seen.landed.skipped])
    );
    check(
      "...with the artefact no skip rule knew about landing beside them, not deleted",
      seen.effectiveLanded,
      JSON.stringify(seen.effectiveLanded)
    );
    check(
      "...and the fallback dir is deleted once everything worth keeping has left it",
      seen.fallbackGone,
      JSON.stringify(seen.fallbackGone)
    );
  }

  /* the fallback path that is a file, not a directory */
  {
    // The `try { readdirSync } catch` in `clearStaleDistOutput` exists for this
    // shape, and on a fake disk it is always reached through the double's own
    // throw. Here it is the platform's: `readdirSync` on a file is `ENOTDIR`, and
    // it must not become "cannot clear it".
    const seen = scratch((root) => {
      const dir = path.join(root, "release-0.1.14");
      fs.writeFileSync(dir, "a stray file where the output dir should be");
      let threw = null;
      let cleared = null;
      try {
        cleared = clearStaleDistOutput({ dir });
      } catch (err) {
        threw = err;
      }
      return { threw, cleared, gone: !fs.existsSync(dir) };
    });
    check(
      "a real file where the fallback dir should be is cleared, not fatal",
      seen.threw === null && seen.gone,
      `${seen.threw && seen.threw.message} / ${JSON.stringify(seen.cleared)}`
    );
    check(
      "...and answers no entries to name, because a file has none",
      seen.cleared !== null && seen.cleared.removed.length === 0,
      JSON.stringify(seen.cleared)
    );
  }

  /* the whole retry, on a real disk: clear, build, move */
  {
    // The piece the fake-disk retry check cannot prove is the one the release log
    // claims: that the retried build really did start from an empty output dir
    // and that its output, not the previous attempt's, is what release/ holds
    // afterwards. The build is simulated by writing the files electron-builder
    // would — into the dir the command it was handed names.
    const seen = scratch((root) => {
      put(path.join(root, fallbackOutputDir("0.1.14"), "win-unpacked", "stale.exe"), "the previous attempt's app");
      put(path.join(root, fallbackOutputDir("0.1.14"), SETUP), "the previous attempt's setup");
      put(path.join(root, "release", LATEST), "the previous release's feed");

      const fallbackExistedAtBuild = [];
      let answer = null;
      let retryError = null;
      try {
        answer = retryDistIntoFallback({
          version: "0.1.14",
          root,
          run: (cmd) => {
            fallbackExistedAtBuild.push(fs.existsSync(path.join(root, fallbackOutputDir("0.1.14"))));
            put(path.join(root, fallbackOutputDir("0.1.14"), "win-unpacked", "open-code-review-desktop.exe"), `built by ${cmd}`);
            put(path.join(root, fallbackOutputDir("0.1.14"), SETUP), "this build's setup");
            put(path.join(root, fallbackOutputDir("0.1.14"), "builder-debug.yml"), "describes the temp output dir");
          },
        });
      } catch (err) {
        retryError = err;
      }
      return {
        answer,
        retryError,
        fallbackExistedAtBuild,
        // Deliberately *not* re-sorted here: the answer has to come back sorted
        // from the function, otherwise the release log's order is the disk's.
        clearedEntries: answer ? answer.cleared.removed : [],
        appLanded: fs.existsSync(path.join(root, "release", "win-unpacked", "open-code-review-desktop.exe")),
        staleGone: !fs.existsSync(path.join(root, "release", "win-unpacked", "stale.exe")),
        setupLanded: fs.existsSync(path.join(root, "release", SETUP)),
        feedKept: fs.existsSync(path.join(root, "release", LATEST)),
        debugShipped: fs.existsSync(path.join(root, "release", "builder-debug.yml")),
        fallbackGone: !fs.existsSync(path.join(root, fallbackOutputDir("0.1.14"))),
        root,
      };
    });

    check(
      "a same-version retry starts the build from a cleared fallback dir on a real disk",
      seen.fallbackExistedAtBuild.length === 1 && seen.fallbackExistedAtBuild[0] === false,
      JSON.stringify(seen.fallbackExistedAtBuild)
    );
    check(
      "...having named the two stale entries it removed first, in sorted order",
      seen.clearedEntries.join(" | ") === [SETUP, "win-unpacked"].sort().join(" | "),
      JSON.stringify(seen.clearedEntries)
    );
    check(
      "...and this build's output, not the previous attempt's, is what release/ holds",
      seen.retryError === null &&
        seen.appLanded &&
        seen.staleGone &&
        seen.setupLanded &&
        seen.feedKept &&
        !seen.debugShipped,
      `${seen.retryError && seen.retryError.message} / ${JSON.stringify({
        appLanded: seen.appLanded,
        staleGone: seen.staleGone,
        setupLanded: seen.setupLanded,
        feedKept: seen.feedKept,
        debugShipped: seen.debugShipped,
      })}`
    );
    check(
      "...and the fallback dir is gone afterwards",
      seen.fallbackGone,
      JSON.stringify(seen.fallbackGone)
    );
  }
}

console.log(`\n${failures.length === 0 ? "all release-guard checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\nrelease-guard checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
