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
  for (const stdout of ["garbage", "1", "0", "0 x", "", "1 2 3"]) {
    const { rel } = await classifyStdout(stdout);
    check(
      `a shape that is not a pair of counts answers no relation: ${JSON.stringify(stdout)}`,
      rel === "" && !RELATIONS.includes(rel),
      JSON.stringify(rel)
    );
  }

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
  const probe = await fresh.git(["--version"], dir);
  delete require.cache[require.resolve(servicePath)];
  cp.default.spawn = realSpawn;

  const opts = (calls[0] || [])[2] || {};
  const env = opts.env || {};
  check("git is spawned with a successful exit", probe.code === 0, probe.stderr || "");
  check("git is spawned with LC_ALL=C", env.LC_ALL === "C", String(env.LC_ALL));
  check("git is spawned with LANG=C", env.LANG === "C", String(env.LANG));
  check("the rest of the environment is kept", env.PATH === process.env.PATH, String(env.PATH || "").slice(0, 40));
  check("git is still spawned asynchronously, not with spawnSync", calls.length === 1 && typeof opts.cwd === "string", `${calls.length} spawn(s)`);
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
