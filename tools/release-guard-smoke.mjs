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
import path from "node:path";

import { relocateDistOutput } from "./release-dist.mjs";
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

    check(
      "the fallback moves every artefact into release/",
      answer.moved.join(" | ") === [SETUP, PORTABLE, LATEST].join(" | "),
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

  /* first fallback in a clean tree: nothing to replace, and release/ may not exist */
  {
    const d = fakeDisk({
      "release-0.1.14": {
        "win-unpacked": { "open-code-review-desktop.exe": null },
        "builder-debug.yml": null,
        [SETUP]: null,
      },
    });
    const answer = relocateDistOutput({ from: FROM, to: TO, fs: d.fs, path: posix });
    check("a fallback with no previous build replaces nothing", answer.replaced === false, JSON.stringify(answer));
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
}

console.log(`\n${failures.length === 0 ? "all release-guard checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\nrelease-guard checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
