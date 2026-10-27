// Exercises git-service.js against a real git repository.
//
// The code pane next to a finding has to show the code that was reviewed. The
// policy that decides *which* code that is lived in the `file:read` handler,
// and it was wrong twice at once:
//
//   - `HEAD` was treated as "no ref", so a review against HEAD read the working
//     tree — exactly the case where a dirty working copy differs from what was
//     reviewed;
//   - any failed ref read fell back to the working tree as well, so a file that
//     is not in the reviewed ref at all was shown as though it were.
//
// Both failures are silent: the pane looks normal, and the only symptom is a
// finding whose code does not match the finding. Nothing else in the suite
// covers this layer — the UI audit stubs the bridge, and the service smoke
// talks to the CLI — so the rule is checked here, against real git.
//
// Run with `npm run audit:git`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const gitSvc = require(path.join(ROOT, "git-service.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- the one assertion an unrecognised failure leans on ----
 * `failed` is the branch a localised or newer git reaches, so the exit code in
 * the sentence is the only part of that diagnostic a changed wording cannot take
 * away — "读取 … 失败（git 退出码 128）：fatal: …" can be looked up, while the same
 * sentence without the code cannot say what went wrong at all. It is written
 * once, here, because a regex repeated at three call sites drifts at one of them
 * and still reads as covered; the self-test below then proves the predicate goes
 * red when the code is missing, which is the half that makes it a gate rather
 * than a coincidence.
 */
const namesExitCode = (message, code = 128) =>
  // The trailing `(?!\d)` because a bare prefix would make code 1 match "退出码 128" — the one
  // confusion this assertion must not have, since 128 is the code a failed git
  // exits with and 1 is what a caller would pass by accident.
  new RegExp(`退出码\\s*${code}(?!\\d)`).test(String(message == null ? "" : message));

/* ---- a throwaway repository with a dirty working copy and a second branch ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-"));
// Async spawn, not spawnSync: spawnSync is refused outright with EBUSY in a
// sandboxed environment, and this suite has to run there too.
const git = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} failed (${code}): ${err || out}`));
      else resolve(out.trim());
    });
  });

const COMMITTED = "package main\n\nfunc main() {}\n";
const DIRTY = "// edited in the working tree, never committed\npackage main\n";
const FEATURE = "package main\n\nfunc feature() {}\n";

await git(["init", "-q"]);
await git(["config", "user.email", "t@example.com"]);
await git(["config", "user.name", "Test"]);
await git(["checkout", "-q", "-b", "main"]);
fs.writeFileSync(path.join(dir, "a.go"), COMMITTED);
await git(["add", "."]);
await git(["commit", "-q", "-m", "initial"]);

await git(["checkout", "-q", "-b", "feature"]);
fs.writeFileSync(path.join(dir, "a.go"), FEATURE);
await git(["commit", "-q", "-am", "feature"]);
await git(["checkout", "-q", "main"]);

// The working copy now differs from every commit — the state in which reading
// the working tree instead of the snapshot silently shows the wrong code.
fs.writeFileSync(path.join(dir, "a.go"), DIRTY);
// A file that exists only in the working tree. Asking for it at a ref must fail
// with `missing`; if the read falls back to the working tree, it succeeds and
// shows code the reviewed snapshot does not contain. The file has to really
// exist, or the test only proves that two missing things are missing.
const WORKTREE_ONLY = "// only in the working tree, never committed\n";
fs.writeFileSync(path.join(dir, "only-in-worktree.txt"), WORKTREE_ONLY);

const read = (opts) => gitSvc.readFile(dir, "a.go", { startLine: 1, endLine: 10, pad: 2, ...opts });
const text = (res) => (res.lines || []).map((l) => l.content).join("\n");

/* ---- a ref means that ref ---- */

const atHead = await read({ ref: "HEAD" });
check("reading at HEAD succeeds", atHead.ok, atHead.error || "");
check(
  "reading at HEAD returns the committed file, not the dirty working copy",
  atHead.ok && text(atHead).includes("func main() {}") && !text(atHead).includes("edited in the working tree"),
  atHead.ok ? text(atHead).split("\n")[0] : atHead.error
);
check("reading at HEAD is labelled as coming from the ref", atHead.source === "git" && atHead.ref === "HEAD", `${atHead.source} / ${atHead.ref}`);

const atFeature = await read({ ref: "feature" });
check(
  "reading at another branch returns that branch's file",
  atFeature.ok && text(atFeature).includes("func feature() {}"),
  atFeature.ok ? text(atFeature).split("\n")[0] : atFeature.error
);

/* ---- no ref means the working tree ---- */

const atWorktree = await read({});
check("reading without a ref returns the working tree", atWorktree.ok && text(atWorktree).includes("edited in the working tree"), atWorktree.error || "");
check("the working tree is labelled as such", atWorktree.source === "worktree", atWorktree.source || "");

/* ---- a failed ref read is reported, never replaced ---- */

const missing = await gitSvc.readFile(dir, "only-in-worktree.txt", { ref: "HEAD" });
check("a file that is not in the ref fails instead of falling back", missing.ok === false, missing.ok ? "it succeeded" : "");
check("...and says which ref was missing it", missing.reason === "missing", missing.reason || "");
check("...and names the ref in the message", /HEAD/.test(missing.error || ""), missing.error || "");
check(
  "...and returns no lines from the working tree",
  Array.isArray(missing.lines) ? missing.lines.length === 0 : missing.lines === undefined,
  JSON.stringify(missing.lines)
);
check(
  "...so the working tree copy is nowhere in the answer",
  !JSON.stringify(missing).includes("only in the working tree"),
  JSON.stringify(missing)
);
// The same file *is* readable when no ref is asked for: the working tree is an
// explicit choice, not something a failed ref read substitutes for.
const worktreeOnly = await gitSvc.readFile(dir, "only-in-worktree.txt", { startLine: 1, endLine: 10, pad: 2 });
check(
  "and the same file reads from the working tree when no ref is asked for",
  worktreeOnly.ok && text(worktreeOnly).includes(WORKTREE_ONLY.trim()),
  worktreeOnly.error || ""
);

const badRef = await gitSvc.readFile(dir, "a.go", { ref: "no-such-ref" });
check("an unresolvable ref fails instead of falling back", badRef.ok === false, badRef.ok ? "it succeeded" : "");
check("...and is reported as an unresolvable ref", badRef.reason === "bad-ref", badRef.reason || "");

/* ---- the same two reasons, asked where they are decided, in both directions ----
 * The checks above reach `missing` through a file that exists on disk but not in
 * the ref, and `bad-ref` through a ref that does not resolve. Neither says what
 * the *other* reason must not say: a `bad-ref` answer that also claims the path
 * is missing — or a `missing` answer that also claims the ref is unresolvable —
 * carries the right `reason` and still sends the reader to fix the wrong thing.
 *
 * The path below exists nowhere (not on disk, not in the ref), which is the
 * other spelling of "missing" (`path ... does not exist in 'HEAD'` rather than
 * `exists on disk, but not in 'HEAD'`). Both are git's own sentences, which is
 * exactly why `gitEnv()` pins `LC_ALL=C` / `LANG=C` in git-service.js: under a
 * localised git these two checks turn into `failed`, and the stub table below is
 * what pins the patterns themselves independently of the locale. So this block
 * and that table are the two halves of one contract — a real git proves the
 * sentences are produced, the table proves what happens when they are not.
 */
const noSuchPath = await gitSvc.readFileAtRef(dir, "不存在/的路径", "HEAD", 1, 5, 0);
check(
  "a path that exists nowhere is missing at a valid ref",
  noSuchPath.ok === false && noSuchPath.reason === "missing",
  `${noSuchPath.reason || "ok"} / ${noSuchPath.error || ""}`
);
check(
  "...and the answer echoes the ref and the path it is about",
  noSuchPath.ref === "HEAD" && noSuchPath.path === "不存在/的路径",
  `${noSuchPath.ref} / ${noSuchPath.path}`
);
check(
  "...and it does not blame the ref, which resolved fine",
  !/无法解析/.test(noSuchPath.error || ""),
  noSuchPath.error || ""
);

const badRefByPath = await gitSvc.readFileAtRef(dir, "a.go", "not-a-real-ref", 1, 5, 0);
check(
  "an unresolvable ref is bad-ref even when the path is fine",
  badRefByPath.ok === false && badRefByPath.reason === "bad-ref",
  `${badRefByPath.reason || "ok"} / ${badRefByPath.error || ""}`
);
check(
  "...and that answer echoes the ref and the path too",
  badRefByPath.ref === "not-a-real-ref" && badRefByPath.path === "a.go",
  `${badRefByPath.ref} / ${badRefByPath.path}`
);
check(
  "...and it does not claim the path is missing, which it is not",
  !/找不到/.test(badRefByPath.error || ""),
  badRefByPath.error || ""
);

/* ---- the sentence the table claims is the sentence git really prints ----
 * `REF_READ_WORDINGS` is an assumption about a program this repo does not own,
 * so it carries one hand-written `sample` per reason and the block further down
 * feeds each sample back through `readFileAtRef`. That proves the table agrees
 * with *itself*. It says nothing about git: the samples are strings somebody
 * typed, and until now the only link to the real program was "the two real
 * failures above happen to come back with the right `reason`" — which is the
 * label, not the recognition behind it.
 *
 * So the same two failures are asked of git directly here — same `git()` and so
 * the same `gitEnv()` (C locale), same repository — and the stderr it prints is
 * handed to the very classifier `readFileAtRef` uses. The claims, one failure
 * each:
 *
 *   - today's git still answers both failures with a single `fatal:` line and
 *     exit 128 — the shape the samples are written in, stated out loud instead
 *     of assumed by whoever writes the next sample;
 *   - each sentence is recognised by exactly one patterned row, and that row is
 *     the one the answer above came back as. "Exactly one" is the half a widened
 *     pattern breaks: both sentences start with `fatal:`, so a row loosened to
 *     that prefix matches both and every other check here stays green;
 *   - the row that recognises the real sentence is the row the hand-written
 *     sample lands on, so sample and reality cannot drift into different rows
 *     while both keep their own `reason`.
 *
 * What is *not* covered stays written down in `docs/OCR-UPSTREAM-SYNC.md`: a
 * failure these checks never produce (a submodule, some spelling git reserves for
 * another case) is still a guess, which is why the fallback branch has to carry
 * git's own words and exit code.
 */
{
  // The product's own `git()`, so the stderr read here is produced under the same
  // C locale `readFileAtRef` will use. Spawned asynchronously — `spawnSync` is
  // refused outright in some sandboxes, and this suite has to run there too.
  const realNotInRef = await gitSvc.git(["show", "HEAD:不存在/的路径"], dir);
  const realNotARef = await gitSvc.git(["show", "not-a-real-ref:a.go"], dir);
  const realCases = [
    { reason: "missing", result: realNotInRef, answer: noSuchPath },
    { reason: "bad-ref", result: realNotARef, answer: badRefByPath },
  ];

  const realStderr = (result) => String(result.stderr || "").trim();
  for (const { reason, result } of realCases) {
    const text = realStderr(result);
    check(
      `a real git still words ${reason} as one fatal: line at exit ${128}`,
      result.code === 128 && text.startsWith("fatal:") && text.split(/\r?\n/).length === 1,
      `code=${result.code} ${JSON.stringify(text)}`
    );
  }

  // The recognition itself, asked row by row rather than through the label: a row
  // that matched is what `classifyRefReadFailure` picks, and picking the right row
  // for the wrong sentence is exactly what a pattern edit does quietly.
  const patternedRows = gitSvc.REF_READ_WORDINGS.filter((row) => row.pattern !== null);
  const rowsMatching = (stderr) =>
    patternedRows.filter((row) => row.pattern.test(stderr)).map((row) => row.reason);

  for (const { reason, result, answer } of realCases) {
    const text = realStderr(result);
    const matches = rowsMatching(text);
    check(
      `the ${reason} row, and only it, recognises the sentence git really prints`,
      matches.length === 1 && matches[0] === reason,
      `matched=${JSON.stringify(matches)} <- ${JSON.stringify(text)}`
    );
    // The wiring half: the classification the code pane receives is the same
    // function applied to the same sentence — not a second reading of it
    // somewhere further down the line.
    const row = gitSvc.classifyRefReadFailure(text);
    check(
      `...and the answer the code pane gets is that classification, not a second reading`,
      row.reason === reason && row.reason === answer.reason,
      `${row.reason} / ${answer.reason} / ${JSON.stringify(text)}`
    );
    // Sample and reality, tied to one row: both strings have to come back from
    // the same row object. Two rows sharing a `reason` is not possible today
    // (the table's reasons are unique), but the row — not the string — is what
    // decides a future sentence, so that is what is compared.
    const sampledRow = gitSvc.REF_READ_WORDINGS.find((entry) => entry.reason === reason);
    check(
      `...and that row is the one the ${reason} sample lands on, so sample and reality cannot split`,
      sampledRow !== undefined && gitSvc.classifyRefReadFailure(sampledRow.sample) === row,
      sampledRow ? JSON.stringify(sampledRow.sample) : "no row with that reason"
    );
  }

  // The "exactly one row" claim above is only a gate if a pattern could fail it.
  // Both real sentences start with `fatal:` — the prefix a pattern gets widened
  // to when someone wants a red to stop — so a fixture-independent failing state
  // is available: a loose pattern matches both, while no row of the table does.
  // Asserted on git's own output, so the demonstration cannot drift from what it
  // demonstrates.
  const loosePattern = /^fatal:/i;
  check(
    "...and a pattern loose enough to match both real sentences would break that claim",
    loosePattern.test(realStderr(realNotInRef)) &&
      loosePattern.test(realStderr(realNotARef)) &&
      patternedRows.every(
        (row) => !(row.pattern.test(realStderr(realNotInRef)) && row.pattern.test(realStderr(realNotARef)))
      ),
    JSON.stringify({ missing: realStderr(realNotInRef), badRef: realStderr(realNotARef) })
  );
}

/* ---- a wording that matches nothing is a plain failure ----
 * The reasons above are read out of git's own stderr, and git's wording is
 * not the app's to control: a localised git, or a newer git, says it
 * differently. Anything that matches neither wording has to land on the
 * generic branch — reported as a failure, with git's own first line, rather
 * than guessed to be a missing file or an unresolvable ref.
 *
 * A directory that is not a repository is what produces such a wording
 * ("fatal: not a git repository"), and the ceiling keeps git from finding a
 * repository further up the tree.
 */
const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-notrepo-"));
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = path.dirname(notARepo);
const unknownWording = await gitSvc.readFileAtRef(notARepo, "a.go", "HEAD", 1, 1, 0);
if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
check(
  "a wording that matches neither is reported as a plain failure",
  unknownWording.ok === false && unknownWording.reason === "failed",
  unknownWording.reason || unknownWording.error || ""
);
check("...and it keeps git's own words in the message", /git/i.test(unknownWording.error || ""), unknownWording.error || "");
// The wording is the part a localised or newer git changes; the exit code is
// not. Keeping it in the sentence is what makes an unrecognised failure
// diagnosable: "读取 … 失败（git 退出码 128）：fatal: …" can be looked up, while
// the same sentence without the code cannot.
check(
  "...and it names git's exit code, the part a changed wording cannot take away",
  namesExitCode(unknownWording.error),
  unknownWording.error || ""
);
/* All three reasons answer the same question, so all three echo the ref and the
 * path they were asked about — the renderer reads `ref` back to label the pane,
 * and a `failed` answer that dropped it would leave the failure attributed to
 * whatever the pane was showing before. The two checks above pin this for
 * `missing` and `bad-ref`; this one closes the third branch, and the summary
 * below keeps all three in one place so a fourth reason cannot be added without
 * deciding whether it echoes too.
 */
check(
  "...and a plain failure echoes the ref and the path as well",
  unknownWording.ref === "HEAD" && unknownWording.path === "a.go",
  `${unknownWording.ref} / ${unknownWording.path}`
);
check(
  "every reason echoes the ref and the path it was asked about",
  [noSuchPath, badRefByPath, unknownWording].every((answer) => answer.ok === false && Boolean(answer.ref) && Boolean(answer.path)),
  JSON.stringify([noSuchPath, badRefByPath, unknownWording].map((answer) => [answer.reason, answer.ref, answer.path]))
);
fs.rmSync(notARepo, { recursive: true, force: true });

/* ---- each reason is a sentence, and sentences drift ----
 * `bad-ref` and `missing` are recognised by matching git's stderr *wording*
 * against two patterns, so the reasons are only as stable as those sentences
 * are. `failed` already had a wording that matches neither (above); the other
 * two branches were only ever hit by a real git, which means the checks proved
 * that *today's* git produces those sentences — not what happens when a
 * different one does.
 *
 * A pattern that stopped matching does not go quiet. Whatever wording it used
 * to recognise falls through to the generic branch, so a file that is not in the
 * reviewed snapshot is reported as "读取 ... 失败": a failure with no reason,
 * which is exactly what `bad-ref` / `missing` exist to spare the reader. Since
 * the drift is invisible from the outside — nothing crashes, the pane just says
 * less — it is asserted here from the inside: the service is loaded against a
 * stubbed `spawn` that emits a chosen stderr, and each wording is fed to the
 * classifier on its own.
 *
 * The list has both directions. The known sentences must land on their reason,
 * and two deliberately *unknown* ones — a plausible rewording, and a localised
 * git with the `LC_ALL=C` fix removed (a wording nothing here should ever
 * recognise) — must land on `failed` rather than being guessed into one of the
 * two reasons. A pattern widened carelessly ("exists" instead of "exists on
 * disk, but not in") would turn that guess into a green check, which is why the
 * unknown wordings are part of the same list.
 */
{
  const { EventEmitter } = await import("node:events");

  // Load a fresh copy of the service with `spawn` stubbed, so the command never
  // runs: `readFileAtRef` only has to classify what it is told.
  const classifyStderr = async (stderrText) => {
    const cp = await import("node:child_process");
    const realSpawn = cp.default.spawn;
    const calls = [];
    cp.default.spawn = (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stderr.emit("data", Buffer.from(stderrText, "utf8"));
        child.emit("close", 128);
      });
      return child;
    };
    const servicePath = path.join(ROOT, "git-service.js");
    delete require.cache[require.resolve(servicePath)];
    try {
      const fresh = require(servicePath);
      const res = await fresh.readFileAtRef(dir, "a.go", "HEAD", 1, 5, 0);
      return { res, calls };
    } finally {
      delete require.cache[require.resolve(servicePath)];
      cp.default.spawn = realSpawn;
    }
  };

  const wordings = [
    // The three spellings `bad-ref` has been seen in.
    { stderr: "fatal: bad revision 'no-such-ref'", want: "bad-ref" },
    { stderr: "fatal: invalid object name 'no-such-ref'.", want: "bad-ref" },
    {
      stderr: "fatal: ambiguous argument 'no-such-ref': unknown revision or path not in the working tree.",
      want: "bad-ref",
    },
    // Both spellings of a path that is not in the ref: git uses one or the other
    // depending on whether the path still exists on disk.
    { stderr: "fatal: path 'a.go' does not exist in 'HEAD'", want: "missing" },
    { stderr: "fatal: path 'a.go' exists on disk, but not in 'HEAD'", want: "missing" },
    { stderr: "fatal: no such path 'a.go' in HEAD", want: "missing" },
    // Drift: a rewording nothing recognises has to be reported as a plain
    // failure, not absorbed into a reason by a loosened pattern.
    { stderr: "fatal: Not a valid object name no-such-ref", want: "failed" },
    { stderr: "fatal: couldn't find 'a.go' in 'HEAD'", want: "failed" },
    // What a localised git says. `LC_ALL=C` is what keeps this off the wire, so
    // it is also the proof that the override is what makes the reasons work: with
    // the locale left alone, both of these become `failed`.
    { stderr: "致命错误：无效的对象名称 'no-such-ref'", want: "failed" },
  ];

  for (const { stderr, want } of wordings) {
    const { res, calls } = await classifyStderr(stderr);
    const said = `${res.reason || "(none)"} / ${res.error || ""}`;
    check(
      `a stderr wording is classified as ${want}: ${stderr.slice(0, 46)}`,
      calls.length === 1 && res.ok === false && res.reason === want,
      calls.length === 1 ? said : `the stub was not used (${calls.length} spawn call(s))`
    );
    // A reason is reported with the ref it is about, whichever branch it took —
    // the reader has to know which snapshot could not be read.
    check("...and the message names the ref it is about", /HEAD/.test(res.error || ""), res.error || "");
  }

  // The two directions must not be able to swap: the `missing` wordings above
  // also contain the word "ref"/"revision"-free sentences, and the `bad-ref` ones
  // never mention a path. A pattern that matched both would silently classify
  // everything as the same thing, which is the failure this list is here for.
  const swapped = [];
  for (const { stderr, want } of wordings) {
    const { res } = await classifyStderr(stderr);
    if (want === "bad-ref" && res.reason === "missing") swapped.push(stderr);
    if (want === "missing" && res.reason === "bad-ref") swapped.push(stderr);
  }
  check("no wording is classified as the opposite reason", swapped.length === 0, swapped.join(" | "));

  // Every `failed` answer has to carry the exit code, because `failed` is where
  // the unknown wordings land: it is the branch a localised / newer git reaches,
  // and it is the one branch whose message cannot lean on recognising anything.
  // The stub reports 128 for every wording, so the assertion is simply "the code
  // is in the sentence" — the same code the stub was told to exit with.
  const failedAnswers = [];
  for (const { stderr, want } of wordings) {
    if (want !== "failed") continue;
    const { res } = await classifyStderr(stderr);
    failedAnswers.push(res.error || "");
  }
  check(
    "every unrecognised wording reports git's exit code in the message",
    failedAnswers.length >= 2 && failedAnswers.every((message) => namesExitCode(message)),
    JSON.stringify(failedAnswers)
  );

  // A git that says nothing at all still has to produce a sentence rather than a
  // dangling colon: no stderr is a real shape (a killed child, a broken pipe).
  const silent = await classifyStderr("");
  check(
    "a failure with no stderr still names the exit code and is a whole sentence",
    silent.res.ok === false &&
      silent.res.reason === "failed" &&
      namesExitCode(silent.res.error) &&
      !silent.res.error.trim().endsWith("：") &&
      !silent.res.error.trim().endsWith(":"),
    silent.res.error || ""
  );

  // The case this suite is named for, asserted on its own rather than trusted to
  // the loop above: a localised git produces a wording nothing here recognises,
  // so the answer has to be `failed` *and* the sentence still has to name the
  // exit code — that code is the only part of it a changed language cannot take
  // away.
  const localised = await classifyStderr("致命错误：无效的对象名称 'no-such-ref'");
  check(
    "a Chinese git's 无效的对象名称 lands on failed and still names the exit code",
    localised.res.ok === false &&
      localised.res.reason === "failed" &&
      namesExitCode(localised.res.error),
    `${localised.res.reason || ""} / ${localised.res.error || ""}`
  );

  /* ---- the exit-code assertion itself, in both directions ----
   * The three checks above are only a gate if `namesExitCode` can say no. A regex
   * loosened to "退出码" would accept a sentence that lost the number — which is
   * exactly the sentence a refactor produces when it stops threading `code` into
   * the message, and nothing else in this suite would notice. The two strings
   * below are that same failure with and without the code, so the second red can
   * only be the code.
   */
  const WITH_CODE = "读取 a.go（HEAD）失败（git 退出码 128）：fatal: not a git repository";
  const WITHOUT_CODE = "读取 a.go（HEAD）失败：fatal: not a git repository";
  check(
    "the exit-code assertion accepts a failure sentence that carries git's code",
    namesExitCode(WITH_CODE),
    WITH_CODE
  );
  check(
    "...and rejects the same sentence once the code is dropped, so the assertion can go red",
    namesExitCode(WITHOUT_CODE) === false,
    WITHOUT_CODE
  );
  check(
    "...and it wants the code git really exited with, not any number in the sentence",
    namesExitCode(WITH_CODE, 128) && namesExitCode(WITH_CODE, 1) === false,
    JSON.stringify([namesExitCode(WITH_CODE, 128), namesExitCode(WITH_CODE, 1)])
  );

  /* ---- the wording assumption is a table, and the table is checked ----
   * `git-service.js` now carries `REF_READ_WORDINGS`: one row per reason, each
   * with the stderr wording that reason exists for. That moves the assumption
   * from "two regex literals plus a comment admitting nobody checks them" into
   * data the suite can feed back through `readFileAtRef`.
   *
   * What the four checks below are for, one failure each:
   *
   *   - the shape rule ("exactly one row without a pattern, and it is last") is
   *     what makes classification order-independent: a second pattern-less row
   *     would make the answer depend on where it sits, and one anywhere but last
   *     would swallow every row after it;
   *   - a row without a sample is a reason with no proof of the wording it
   *     exists for — that is the row quietly going unchecked;
   *   - each row's own sample must come back as that row's reason. This is the
   *     red that a broken pattern produces: the sample falls through to the
   *     fallback, and the failure names the row, the sample and the reason it
   *     got instead of the one it should have;
   *   - all three reasons must be covered *by rows that carry a sample*, so
   *     deleting the `missing` row (or just its sample) turns "the assumption is
   *     fully stated" red instead of silently shrinking the table.
   *
   * The hand-written list above is breadth (six known wordings, three unknown
   * ones); these rows are the table's own claim about itself. Both are needed:
   * the list proves the classifier knows more than one spelling, the samples
   * prove each row's pattern is the thing that does it.
   */
  const wordingTable = gitSvc.REF_READ_WORDINGS;
  const patternless = Array.isArray(wordingTable) ? wordingTable.filter((row) => row.pattern === null) : [];
  check(
    "the wording table has exactly one fallback row, it sits last, and every other row has a pattern",
    Array.isArray(wordingTable) &&
      wordingTable.length >= 3 &&
      patternless.length === 1 &&
      wordingTable[wordingTable.length - 1] === patternless[0] &&
      wordingTable.slice(0, -1).every((row) => row.pattern instanceof RegExp),
    JSON.stringify(Array.isArray(wordingTable) ? wordingTable.map((row) => [row.reason, row.pattern === null]) : wordingTable)
  );
  const sampledRows = Array.isArray(wordingTable)
    ? wordingTable.filter((row) => typeof row.sample === "string" && row.sample.trim().length > 0)
    : [];
  check(
    "every wording row carries a sample sentence and its own reason",
    sampledRows.length === (Array.isArray(wordingTable) ? wordingTable.length : 0) &&
      wordingTable.every((row) => typeof row.reason === "string" && row.reason.trim().length > 0) &&
      new Set(wordingTable.map((row) => row.reason)).size === wordingTable.length,
    JSON.stringify(
      Array.isArray(wordingTable)
        ? wordingTable.filter((row) => typeof row.sample !== "string" || !row.sample.trim()).map((row) => row.reason)
        : wordingTable
    )
  );
  const misreadSamples = [];
  for (const row of sampledRows) {
    const { res } = await classifyStderr(row.sample);
    if (res.ok !== false || res.reason !== row.reason) {
      misreadSamples.push(`${row.sample} -> ${res.reason || "(none)"}（应为 ${row.reason}）`);
    }
  }
  check(
    "each row's sample wording is classified as that row's reason",
    sampledRows.length >= 3 && misreadSamples.length === 0,
    misreadSamples.join(" | ") || `${sampledRows.length} sample(s)`
  );
  const coveredReasons = new Set(sampledRows.map((row) => row.reason));
  check(
    "...and the rows with samples cover all three answers, so none is only reachable by luck",
    ["bad-ref", "missing", "failed"].every((reason) => coveredReasons.has(reason)) && coveredReasons.size === 3,
    JSON.stringify([...coveredReasons])
  );
}

/* ---- the four answers, one by one ----
 * `classifyRef` reads git's *stdout shape* — "<only-in-HEAD> <only-in-ref>" —
 * and turns it into one of four relations: `same`, `ancestor`, `descendant`,
 * `diverged`. Those four decide the default `from` / `to` of a branch-range
 * review, and picking the wrong one is the quietest failure in this file: a
 * range that compares a descendant with HEAD is empty, so the review covers
 * **no file at all** and still reports a clean run.
 *
 * The shape was only ever read from a real git, which proves that *today's* git
 * prints it — not what happens when the shape is different, empty, or not a
 * number. A shape the classifier does not recognise has to answer "" (no
 * relation) rather than be guessed into one of the four: "" makes `inspect`
 * leave the ref out of `relations` and the UI fall back to the working tree,
 * while a guess picks a range that silently reviews nothing.
 *
 * So the four shapes are fed to the classifier one by one, with a stubbed
 * `spawn`, and so are the shapes it does not know. The same four are then
 * checked against real git, so the stub cannot be "right" in a way the real
 * thing is not.
 */
{
  const { EventEmitter } = await import("node:events");

  // A fresh copy of the service with `spawn` stubbed, so no git runs at all:
  // `classifyRef` only has to read the shape it is handed.
  const classifyStdout = async (stdoutText, code = 0) => {
    const cp = await import("node:child_process");
    const realSpawn = cp.default.spawn;
    const calls = [];
    cp.default.spawn = (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        if (stdoutText) child.stdout.emit("data", Buffer.from(stdoutText, "utf8"));
        child.emit("close", code);
      });
      return child;
    };
    const servicePath = path.join(ROOT, "git-service.js");
    delete require.cache[require.resolve(servicePath)];
    try {
      const fresh = require(servicePath);
      const rel = await fresh.classifyRef(dir, "some-ref");
      return { rel, calls };
    } finally {
      delete require.cache[require.resolve(servicePath)];
      cp.default.spawn = realSpawn;
    }
  };

  const RELATIONS = ["same", "ancestor", "descendant", "diverged"];
  const shapes = [
    { stdout: "0 3", want: "descendant", why: "ahead of HEAD" },
    { stdout: "3 0", want: "ancestor", why: "behind HEAD" },
    { stdout: "2 5", want: "diverged", why: "on neither side" },
    { stdout: "0 0", want: "same", why: "the same commit" },
    // The two counts a number cannot carry. Nothing about a commit count needs a
    // conversion — the only question asked of it is "is it zero?" — so these are
    // answered like any other count. They are here because a `parseInt` re-enters
    // this function very easily (the zeros look like numbers), and with it these
    // two become "21 digits rounded to 1e24" and "Infinity": the first still
    // reads as non-zero by luck, the second does not, so the 400-digit one is the
    // assertion that a numeric conversion is not load-bearing.
    { stdout: "999999999999999999999999 0", want: "ancestor", why: "behind HEAD by more commits than a double holds exactly" },
    { stdout: "0 " + "9".repeat(400), want: "descendant", why: "ahead of HEAD by more commits than a double can hold at all" },
  ];
  for (const { stdout, want, why } of shapes) {
    const { rel, calls } = await classifyStdout(stdout);
    check(
      `a ref that is ${why} is classified as ${want}`,
      calls.length === 1 && rel === want,
      `${JSON.stringify(stdout)} -> ${JSON.stringify(rel)}`
    );
  }

  // The shapes it does not know: a rewording of the numbers, a number that is
  // not a number, a missing half, and no output at all. None of them may be
  // answered with a relation — an unrecognised shape is "no relation", and
  // "no relation" is not one of the four.
  //
  // The last six are the `Number.parseInt` hole, and they are why the counts are
  // matched as digits rather than parsed: `parseInt` accepts a *prefix*, so
  // "3x 0" read as 3-and-0 (`ancestor`), "0 3x" as 0-and-3 (`descendant`), and
  // "0x10 0" as 0-and-0 — `same`, the one answer that says "these are the same
  // commit". A sign or a decimal point is no shape either, and would otherwise
  // be read as a relation too ("-1 0" -> `ancestor`). Put `parseInt` back in
  // place of the digit test and these go red while the four known shapes stay
  // green — which is exactly how this hole survived until now.
  const badShapes = [
    "garbage",
    "1",
    "0",
    "0 x",
    "",
    "1 2 3",
    "3x 0",
    "0 3x",
    "0x10 0",
    "-1 0",
    "0 -2",
    "3.9 0",
  ];
  for (const stdout of badShapes) {
    const { rel } = await classifyStdout(stdout);
    check(
      `a shape that is not a pair of counts answers no relation: ${JSON.stringify(stdout)}`,
      rel === "" && !RELATIONS.includes(rel),
      JSON.stringify(rel)
    );
  }

  // The oversized pair, asked on its own so the reason it is allowed is written
  // down: `Number.parseInt("9".repeat(400))` is `Infinity`, so a numeric version
  // of this function has to treat "a count bigger than any repository" as no
  // relation at all — the one answer that makes the UI silently fall back instead
  // of defaulting a branch range. A digit test cannot make that mistake.
  const oversized = await classifyStdout("0 " + "9".repeat(400));
  check(
    "a count too large for a double is still a count, and names a relation",
    oversized.rel === "descendant",
    JSON.stringify(oversized.rel)
  );
  check(
    "...and the number that count would have become is really out of a double's range",
    Number.parseInt("9".repeat(400)) === Infinity && !Number.isFinite(Number.parseInt("9".repeat(400))),
    String(Number.parseInt("9".repeat(400)))
  );

  // A git that failed (an unknown ref, a repository that is not there) has no
  // shape to read at all, and must not be answered with one.
  const failed = await classifyStdout("0 3", 128);
  check(
    "a failed git answers no relation",
    failed.rel === "" && !RELATIONS.includes(failed.rel),
    JSON.stringify(failed.rel)
  );
}

/* ---- the same four answers, from a real git ----
 * The stub above proves the classifier reads the shape it is given; it cannot
 * prove that git prints that shape. So the same four relations are asked of a
 * real repository: `main` is HEAD itself (`same`) and `feature` is one commit
 * ahead of it (`descendant`).
 */
{
  const inspected = await gitSvc.inspect(dir);
  const relations = inspected.relations || {};
  check(
    "a branch that is HEAD itself is classified as same",
    relations.main === "same",
    JSON.stringify(relations)
  );
  check(
    "a branch that is ahead of HEAD is classified as descendant",
    relations.feature === "descendant",
    JSON.stringify(relations)
  );
  check(
    "a branch that does not exist is left out instead of being guessed",
    !("master" in relations),
    JSON.stringify(relations)
  );

  /* ---- a ref name that is not a ref name ----
   * `classifyRef` is handed names git printed (`inspect`'s `refs`), so a
   * malformed one cannot arrive today. That is a constraint of the *caller*, not
   * a promise of this function, and the difference matters the day a name starts
   * coming straight from the renderer: `HEAD...<ref>` is string concatenation, so
   * a name starting with `-`, or one that already contains a range operator,
   * would be parsed by git as something other than "compare HEAD with this ref".
   *
   * Both cases are asked of a real git here, and both must answer "" — no
   * relation. Which of the two guards inside the function answered (git refused
   * with a non-zero exit, or printed a shape that is not two counts) is git's
   * business and deliberately not asserted: the contract is "no relation", and
   * that is what keeps the UI falling back to the working tree instead of picking
   * a range that reviews nothing. `git --version` is printed alongside, not
   * asserted, so the day a newer git answers differently the log says which git
   * produced the answer.
   */
  const gitVersion = await gitSvc.git(["--version"], dir);
  console.log(`        (fixture asked with ${gitVersion.stdout.trim() || "git (version unknown)"})`);
  for (const bad of ["-x", "a...b"]) {
    const rel = await gitSvc.classifyRef(dir, bad);
    check(
      `a ref name that is not a ref name answers no relation: ${JSON.stringify(bad)}`,
      rel === "" && !["same", "ancestor", "descendant", "diverged"].includes(rel),
      JSON.stringify(rel)
    );
  }
}

/* ---- named bases survive the cap ----
 * `inspect` classifies at most `REF_LIMIT` refs, and the ranking puts `main` /
 * `master` / the configured upstream first so the cap "can never drop the ref a
 * user most likely wants to compare against". That priority had no assertion:
 * the fixture above has three branches, so everything fit and a plain
 * `refs.slice(0, 40)` would have passed every check while a real repository
 * with 60 branches silently lost `main` — the UI then says the two branches
 * cannot be compared (no relation), which is wrong, not merely incomplete.
 *
 * The branches below are named so that alphabetical order puts all of them
 * *before* `main`: without the named-first priority, the first 40 refs would be
 * `b00`..`b39` and `main` / `master` / `origin/main` would all be dropped. With
 * it, the three are inside the cap and the last alphabetical branch is not.
 */
{
  const manyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-many-"));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-many-remote-"));
  const manyGit = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: manyDir, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`git ${args.join(" ")} failed (${code}): ${err || out}`));
        else resolve(out.trim());
      });
    });

  try {
    await manyGit(["init", "-q"]);
    await manyGit(["config", "user.email", "t@example.com"]);
    await manyGit(["config", "user.name", "Test"]);
    await manyGit(["checkout", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(manyDir, "a.txt"), "one\n", "utf8");
    await manyGit(["add", "."]);
    await manyGit(["commit", "-q", "-m", "initial"]);
    await manyGit(["branch", "master"]);
    // 58 more branches, all sorting before `main` / `master`.
    for (let i = 0; i < 58; i++) await manyGit(["branch", `b${String(i).padStart(2, "0")}`]);
    // A real upstream: bare remote, and `main` tracked on it, so `@{upstream}`
    // resolves to `origin/main` the way it does in a working clone.
    //
    // Set up without `git push -u`, deliberately. A push is not something a
    // checker can count on — a sandboxed or proxied environment can throttle or
    // soft-skip it, and on this machine it silently succeeds without ever
    // writing the upstream, which turned the two checks below red for a reason
    // that had nothing to do with `inspect`. What `git push -u` would have left
    // behind is exactly three things: the remote-tracking ref, `branch.<name>.remote`
    // and `branch.<name>.merge`. Written directly, the fixture tests `inspect`'s
    // reading of `@{upstream}` instead of the git installation's ability to push.
    await new Promise((resolve, reject) => {
      const child = spawn("git", ["init", "-q", "--bare", remoteDir], { cwd: manyDir, windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init --bare failed (${code})`))));
    });
    await manyGit(["remote", "add", "origin", remoteDir]);
    await manyGit(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await manyGit(["config", "branch.main.remote", "origin"]);
    await manyGit(["config", "branch.main.merge", "refs/heads/main"]);

    const many = await gitSvc.inspect(manyDir);
    const relations = many.relations || {};
    check("all 60 branches are still reported to the UI", many.refs.length === 60, `${many.refs.length} refs`);
    check("the configured upstream is recognised", many.upstream === "origin/main", many.upstream || "(none)");
    check(
      "the cap keeps main even when 58 branches sort before it",
      relations.main === "same",
      JSON.stringify(Object.keys(relations))
    );
    check(
      "the cap keeps master too",
      relations.master === "same",
      JSON.stringify(Object.keys(relations))
    );
    check(
      "and it keeps the configured upstream",
      relations["origin/main"] === "same",
      JSON.stringify(Object.keys(relations))
    );
    check(
      "while an ordinary branch past the cap is left out",
      !("b57" in relations),
      JSON.stringify(Object.keys(relations))
    );
    check(
      "so the cap still bounds how many refs are classified",
      Object.keys(relations).length === 40,
      `${Object.keys(relations).length} relations`
    );
  } finally {
    fs.rmSync(manyDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
}

/* ---- the reasons survive a non-English desktop ----
 * `bad-ref` and `missing` are read out of git's stderr *sentences*, and git
 * translates them: with a Chinese locale it says "无效的对象名称" / "路径 ... 不存在",
 * neither of which matches an English pattern, so both classifications collapse
 * into the generic `failed` branch and the reader is told "读取 ... 失败" — which
 * says nothing about *what* was wrong. Pinning the locale is what makes those two
 * reasons an answer rather than a guess about the user's machine.
 *
 * Two checks, because only one of them can fail on a machine without the locale:
 *
 *   1. the environment git is actually spawned with — asserted directly, and the
 *      one that goes red anywhere if the override is removed;
 *   2. the classification under a claimed Chinese locale — the end-to-end version
 *      of the same promise, red on any machine where that locale is installed.
 */
const savedLocale = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
process.env.LC_ALL = "zh_CN.UTF-8";
process.env.LANG = "zh_CN.UTF-8";

const zhBadRef = await gitSvc.readFile(dir, "a.go", { ref: "no-such-ref" });
check(
  "under a Chinese locale an unresolvable ref is still classified as bad-ref",
  zhBadRef.ok === false && zhBadRef.reason === "bad-ref",
  `${zhBadRef.reason || ""} / ${zhBadRef.error || ""}`
);
const zhMissing = await gitSvc.readFile(dir, "only-in-worktree.txt", { ref: "HEAD" });
check(
  "under a Chinese locale a path that is not in the ref is still classified as missing",
  zhMissing.ok === false && zhMissing.reason === "missing",
  `${zhMissing.reason || ""} / ${zhMissing.error || ""}`
);

// The locale itself: stub `spawn` for a freshly loaded copy of the service (so
// its `require("child_process")` picks up the stub) and read the options it
// passes on. PATH has to survive the override — without it git is not found at
// all — while the message language must not be left to the ambient environment.
//
// The call made through the stub is `readFileAtRef`, a real read of a real file at
// a real ref, rather than `git(...)` directly. The two ask different questions
// and only the second one is about the read path: `gitEnv()` (asked on its own
// further down) says what the environment *should* look like, this block says the
// code that draws the code pane actually spawns git with it. Inlining a
// `spawn("git", ["show", …], { cwd })` into `readFileAtRef` looks like a harmless
// shortcut — it already knows the arguments — and would leave the classifications
// that pane depends on unpinned to the C locale, while a probe that called `git()`
// itself would stay green.
{
  const cp = await import("node:child_process");
  const realSpawn = cp.default.spawn;
  const calls = [];
  cp.default.spawn = (...args) => {
    calls.push(args);
    return realSpawn(...args);
  };
  const servicePath = path.join(ROOT, "git-service.js");
  delete require.cache[require.resolve(servicePath)];
  const fresh = require(servicePath);
  const probe = await fresh.readFileAtRef(dir, "a.go", "HEAD", 1, 5, 0);
  delete require.cache[require.resolve(servicePath)];
  cp.default.spawn = realSpawn;

  const opts = (calls[0] || [])[2] || {};
  const env = opts.env || {};
  check(
    "the read the wiring probe watches really ran, under a Chinese locale, and found the file",
    probe.ok === true && (probe.lines || []).map((l) => l.content).join("\n").includes("func main() {}"),
    probe.ok ? "" : probe.error || ""
  );
  check(
    "...so the environment read back is the one the code pane's read used",
    calls.length === 1 && (calls[0][1] || []).includes("show"),
    JSON.stringify((calls[0] && calls[0][1]) || [])
  );
  check("git is spawned with LC_ALL=C", env.LC_ALL === "C", String(env.LC_ALL));
  check("git is spawned with LANG=C", env.LANG === "C", String(env.LANG));
  check("the rest of the environment is kept", env.PATH === process.env.PATH, String(env.PATH || "").slice(0, 40));
  check("git is still spawned asynchronously, not with spawnSync", calls.length === 1 && opts.cwd === dir, `${calls.length} spawn(s) / ${String(opts.cwd)}`);
}

/* ---- the two keys, asked of the function that builds them ----
 * The block above proves the pinned locale reaches `spawn`; it is also the only
 * thing that proved the *spread* survives, and it does so through a real git
 * call (a missing PATH would fail the probe for an unrelated-looking reason).
 * So `gitEnv` itself is asked directly, while the ambient locale is still
 * Chinese (set above, restored below):
 *
 *   - the two keys are overridden even though the caller's environment says
 *     something else — and the caller's environment is *not* mutated, which is
 *     what separates "return a copy" from "set process.env and hand it back";
 *   - a caller's own variable survives: PATH is what finds `git` at all, and
 *     `GIT_CEILING_DIRECTORIES` is how the `not a repository` fixture above
 *     keeps git from finding a repository further up the tree. Losing the
 *     spread leaves every classification check green and silently breaks the
 *     spawn, which is the failure this asks about;
 *   - it is built per call, not once at load: a caller may change its
 *     environment between calls (the ceiling fixture does), and a snapshot
 *     taken at load would ignore that without any check noticing.
 */
{
  const PROBE = "OCR_GIT_ENV_PROBE";
  const savedProbe = process.env[PROBE];
  try {
    process.env[PROBE] = "before";
    const first = gitSvc.gitEnv();
    process.env[PROBE] = "after";
    const second = gitSvc.gitEnv();

    check("gitEnv() pins LC_ALL to C over the ambient locale", first.LC_ALL === "C", String(first.LC_ALL));
    check("gitEnv() pins LANG to C over the ambient locale", first.LANG === "C", String(first.LANG));
    check(
      "...and leaves the caller's environment alone, it returns a copy",
      process.env.LC_ALL === "zh_CN.UTF-8" && process.env.LANG === "zh_CN.UTF-8",
      `${process.env.LC_ALL} / ${process.env.LANG}`
    );
    check(
      "...and keeps the caller's own variables, PATH included",
      first.PATH === process.env.PATH && first[PROBE] === "before",
      `${String(first.PATH || "").slice(0, 30)} / ${first[PROBE]}`
    );
    check(
      "...and is built per call, so a variable changed between calls is seen",
      second[PROBE] === "after" && first[PROBE] === "before",
      `${first[PROBE]} -> ${second[PROBE]}`
    );
  } finally {
    if (savedProbe === undefined) delete process.env[PROBE];
    else process.env[PROBE] = savedProbe;
  }
}

if (savedLocale.LC_ALL === undefined) delete process.env.LC_ALL;
else process.env.LC_ALL = savedLocale.LC_ALL;
if (savedLocale.LANG === undefined) delete process.env.LANG;
else process.env.LANG = savedLocale.LANG;

/* ---- the working tree does not hide the snapshot ---- */

// The file is committed at HEAD and deleted in the working tree: the snapshot
// still has it, and the working tree does not. Reading at the ref must find it.
fs.rmSync(path.join(dir, "a.go"));
const afterDelete = await read({ ref: "HEAD" });
check(
  "a file deleted in the working tree is still readable at the ref",
  afterDelete.ok && text(afterDelete).includes("func main() {}"),
  afterDelete.ok ? text(afterDelete).split("\n")[0] : afterDelete.error
);
const deletedWorktree = await read({});
check("...and is gone from the working tree", deletedWorktree.ok === false, deletedWorktree.ok ? "it succeeded" : "");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "all git-service checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\ngit-service checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
