// Checks that `tools/check-packaging.mjs` can go red.
//
// The gate it guards is the only thing standing between "a new main-process
// module" and "the packaged app dies at startup with `Cannot find module`", and
// the failure mode of the gate itself is being vacuous: an answer of "no
// problems" that would also have been "no problems" for a broken allowlist. That
// cannot be seen by running the gate against this repository — it passes by
// construction — so it is asserted here, from both directions:
//
//   - a fixture repository, where one allowlist line is removed at a time and the
//     answer has to name the module that fell out (direct require, transitive
//     require, and a root module nothing requires yet);
//   - this repository's real `build.files`, where removing any single `.js` line
//     has to turn red and name that line. The list is read from `package.json`
//     rather than written out here, so a module added later is covered by the
//     same assertion instead of quietly widening the gap between the gate and
//     this suite.
//
// No build, no Electron, no electron-builder. Run with `npm run audit:packaging`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { DEFAULT_ENTRIES, findPackagingProblems, matchesPattern } from "./check-packaging.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = createRequire(path.join(ROOT, "package.json"))("./package.json");
const REAL_PATTERNS = pkg.build?.files || [];

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// A problem "names" a file when any of its sentences contains it. Every check
// below is phrased that way on purpose: which of the two messages fires is not
// the contract, *that the module is named* is.
const names = (report, file) => report.problems.some((problem) => problem.includes(file));
const report = (problems, checked = [], rootModules = []) => ({ problems, checked, rootModules });

/* ---- a fixture with one of each shape ----
 *   main.js  requires ./alpha (direct) and ./beta (direct)
 *   alpha.js requires ./gamma   (transitive — the walk has to be deeper than 1)
 *   spare.js is a root module nothing requires  (the `path.join(__dirname, …)`
 *            or brand-new-module shape, invisible to the require graph)
 *   notes.md is a non-`*.js` root file, which must not be swept up
 */
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-packaging-"));
try {
  fs.writeFileSync(path.join(fixture, "main.js"), 'require("./alpha");\nrequire("./beta");\n');
  fs.writeFileSync(path.join(fixture, "alpha.js"), 'require("./gamma");\n');
  fs.writeFileSync(path.join(fixture, "beta.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(fixture, "gamma.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(fixture, "spare.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(fixture, "notes.md"), "# not runtime\n");

  const ALL = ["main.js", "alpha.js", "beta.js", "gamma.js", "spare.js"];
  const run = (patterns) =>
    findPackagingProblems({ root: fixture, patterns, entries: ["main.js"] });

  const complete = run(ALL);
  check(
    "a complete allowlist reports no problem at all, so a red answer means something",
    complete.problems.length === 0,
    complete.problems.join(" | ")
  );
  check(
    "...and the walk really followed the graph, transitively, not just the entry's requires",
    complete.checked.includes("main.js") &&
      complete.checked.includes("alpha.js") &&
      complete.checked.includes("gamma.js"),
    JSON.stringify(complete.checked)
  );
  check(
    "...and it swept the root directory for *.js, ignoring other extensions",
    complete.rootModules.includes("spare.js") && !complete.rootModules.includes("notes.md") &&
      complete.rootModules.length === 5,
    JSON.stringify(complete.rootModules)
  );

  const dropDirect = run(ALL.filter((entry) => entry !== "beta.js"));
  check(
    "removing a directly required module from the allowlist goes red and names it",
    dropDirect.problems.length === 1 && names(dropDirect, "beta.js"),
    dropDirect.problems.join(" | ")
  );

  const dropTransitive = run(ALL.filter((entry) => entry !== "gamma.js"));
  check(
    "removing a module only a *dependency* requires goes red too, naming it",
    dropTransitive.problems.length === 1 && names(dropTransitive, "gamma.js"),
    dropTransitive.problems.join(" | ")
  );
  check(
    "...which is what makes a depth-1 walk insufficient, and it is the shallow answer that would pass",
    dropTransitive.problems.some((problem) => problem.includes("required at runtime")),
    dropTransitive.problems.join(" | ")
  );

  const dropSpare = run(ALL.filter((entry) => entry !== "spare.js"));
  check(
    "a root module nothing requires is still required to be in the allowlist, and is named",
    dropSpare.problems.length === 1 &&
      names(dropSpare, "spare.js") &&
      dropSpare.problems.some((problem) => problem.includes("root module")),
    dropSpare.problems.join(" | ")
  );
  check(
    "...and that message says what to do when the file is not a runtime module",
    dropSpare.problems.some((problem) => problem.includes("tools/")),
    dropSpare.problems.join(" | ")
  );

  const negated = run([...ALL, "!beta.js"]);
  check(
    "a `!` exclusion really removes coverage: the excluded module goes red",
    negated.problems.length === 1 && names(negated, "beta.js"),
    negated.problems.join(" | ")
  );

  const ghost = run([...ALL, "ghost.js"]);
  check(
    "an allowlist line that names no existing file goes red, naming the line",
    ghost.problems.length === 1 && names(ghost, "ghost.js"),
    ghost.problems.join(" | ")
  );

  const noEntry = findPackagingProblems({ root: fixture, patterns: ALL, entries: ["nope.js"] });
  check(
    "a missing entry point goes red instead of being skipped",
    noEntry.problems.length === 1 && names(noEntry, "nope.js"),
    noEntry.problems.join(" | ")
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

/* ---- the known blind spot, written as an assertion ----
 * The gate finds require edges with a regular expression over the source text,
 * so it sees `require("./x")` and nothing else. A module loaded by a computed
 * path — `require(`./x`)`, `require("./" + "x")` — is invisible to it: the
 * walk never reaches the file, so the file is not in the graph and no
 * "required at runtime" complaint is made about it.
 *
 * That is a real hole, and the honest way to hold it is an assertion rather
 * than a comment: the two facts below (a literal require *is* followed, a
 * computed one is not) are what the gate does today. If somebody teaches the
 * scan to follow computed requires, these go red — on purpose, because the
 * mitigation (runtime requires stay literal) would no longer be needed, and
 * the sentence that says so would have to change with it.
 */
const blind = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-packaging-blind-"));
try {
  fs.writeFileSync(
    path.join(blind, "main.js"),
    [
      'require("./literal");',
      "require(`./templated`);",
      'require("./" + "joined");',
      'require(`./lib/${"deep"}`);',
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(blind, "literal.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(blind, "templated.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(blind, "joined.js"), "module.exports = {};\n");
  fs.mkdirSync(path.join(blind, "lib"));
  fs.writeFileSync(path.join(blind, "lib", "deep.js"), "module.exports = {};\n");

  const ALL = ["main.js", "literal.js", "templated.js", "joined.js"];
  const blindRun = findPackagingProblems({ root: blind, patterns: ALL, entries: ["main.js"] });
  check(
    "a literal require is followed by the walk, so that module is in the graph",
    blindRun.checked.includes("literal.js"),
    JSON.stringify(blindRun.checked)
  );
  check(
    "a computed require is not followed: the module never enters the graph",
    !blindRun.checked.includes("templated.js") &&
      !blindRun.checked.includes("joined.js") &&
      !blindRun.checked.includes("lib/deep.js"),
    JSON.stringify(blindRun.checked)
  );
  // The sharpest form of the hole: `lib/deep.js` is required by a computed
  // path *and* is in no allowlist, and the gate says nothing at all. The root
  // sweep does not reach into subdirectories, so neither question covers it.
  check(
    "...and the gate stays silent about all of them, including the one that is not packaged at all",
    blindRun.problems.length === 0,
    blindRun.problems.join(" | ") || "no problem"
  );

  // The mitigation that does exist: a computed require of a *root* module is
  // still caught — by the root sweep, not by the graph — so the message says
  // "root module", and it says what to do about it.
  const withoutTemplated = findPackagingProblems({
    root: blind,
    patterns: ALL.filter((entry) => entry !== "templated.js"),
    entries: ["main.js"],
  });
  check(
    "a computed require of a root module is still caught, by the root sweep and with its own wording",
    withoutTemplated.problems.length === 1 &&
      names(withoutTemplated, "templated.js") &&
      withoutTemplated.problems.some((problem) => problem.includes("root module")),
    withoutTemplated.problems.join(" | ")
  );
} finally {
  fs.rmSync(blind, { recursive: true, force: true });
}

/* ---- the real allowlist, from the real package.json ---- */
{
  check(
    "this repository's build.files has the shapes the matcher understands",
    REAL_PATTERNS.some((p) => p === "main.js") && REAL_PATTERNS.some((p) => p.endsWith("/**")),
    JSON.stringify(REAL_PATTERNS.slice(0, 3))
  );
  check(
    "an exact name matches itself and nothing else",
    matchesPattern("main.js", "main.js") === true &&
      matchesPattern("not-main.js", "main.js") === false,
    JSON.stringify([
      matchesPattern("main.js", "main.js"),
      matchesPattern("not-main.js", "main.js"),
    ])
  );
  check(
    "a `dir/**` pattern matches the directory and everything under it",
    matchesPattern("out/index.html", "out/**") === true &&
      matchesPattern("out", "out/**") === true &&
      matchesPattern("outside/index.html", "out/**") === false &&
      matchesPattern("out.js", "out/**") === false,
    JSON.stringify([
      matchesPattern("out/index.html", "out/**"),
      matchesPattern("outside/index.html", "out/**"),
      matchesPattern("out.js", "out/**"),
    ])
  );

  const real = findPackagingProblems({ root: ROOT, patterns: REAL_PATTERNS, entries: DEFAULT_ENTRIES });
  check(
    "this repository passes its own gate",
    real.problems.length === 0,
    real.problems.join(" | ")
  );
  check(
    "...and the answer is not vacuous: modules were actually walked, entries included",
    real.checked.length > 1 &&
      DEFAULT_ENTRIES.every((entry) => real.checked.includes(entry)),
    JSON.stringify(real.checked)
  );
  check(
    "...and every root *.js is one of the modules the walk reached, so the sweep has nothing left to add",
    real.rootModules.length > 1 && real.rootModules.every((rel) => real.checked.includes(rel)),
    JSON.stringify(real.rootModules)
  );

  // Every allowlist line ending in `.js` is load-bearing: removing it has to turn
  // the gate red. This is the assertion that keeps the gate honest as modules are
  // added — it derives its list from `package.json`, so a module added tomorrow is
  // covered without editing this file, and a line that has quietly become dead
  // (nothing requires it, nothing needs it packaged) is reported here instead of
  // being carried forever.
  const jsLines = REAL_PATTERNS.filter((entry) => !entry.startsWith("!") && entry.endsWith(".js"));
  const notLoadBearing = [];
  const redForAnotherReason = [];
  for (const line of jsLines) {
    const without = findPackagingProblems({
      root: ROOT,
      patterns: REAL_PATTERNS.filter((entry) => entry !== line),
      entries: DEFAULT_ENTRIES,
    });
    if (!names(without, line)) {
      notLoadBearing.push(line);
      continue;
    }
    // "It goes red" is not enough — it has to go red *because the module is no
    // longer packaged*. A gate that went red for some other reason (a typo in
    // the allowlist, a file renamed away) would satisfy a name-only check while
    // the real hole stayed open, and the two reasons are told apart in the
    // message. Pinned here so "the gate is green" can never be explained by a
    // red that means something else.
    const saysWhy = without.problems.some(
      (problem) => problem.includes("required at runtime") || problem.includes("root module")
    );
    if (!saysWhy) redForAnotherReason.push(line);
  }
  check(
    `every one of the ${jsLines.length} allowlist *.js lines is load-bearing: removing it goes red and names it`,
    jsLines.length > 1 && notLoadBearing.length === 0,
    notLoadBearing.join(" | ") || `${jsLines.length} lines`
  );
  check(
    "...and it goes red *because the module stopped being packaged*, not for some other reason",
    redForAnotherReason.length === 0,
    redForAnotherReason.join(" | ") || `${jsLines.length} line(s)`
  );
}

console.log(`\n${failures.length === 0 ? "all packaging self-checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\npackaging self-checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
