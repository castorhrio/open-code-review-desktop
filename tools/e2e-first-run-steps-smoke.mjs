// Pins the four judgements `tools/e2e-first-run.cjs` makes, without Electron.
//
// The first-run harness is the check that a person opening the installed app for
// the first time lands on a guide, that the run button refuses until a model
// service exists, and that "refuses" is proved by what never left the process. Each
// of those is a *decision*, and a decision inside a file that needs a display
// server, a real CLI and a live renderer is a decision nobody can poke. So the
// decisions live here as values, and this file pushes back on them the way the
// harness cannot: with the exact mutations that would make a green line mean
// nothing.
//
// The one worth naming up front: `runSpawnVerdict` is asked "were there zero runs?"
// and the cheap way to pass that question is to stop recognising runs at all — if
// the CLI renames `review`, the log has no paid run, the gate looks satisfied and
// the guard this harness exists to prove is quietly out of scope. Block C therefore
// asserts that an *unknown* command is red even when the count would pass.
//
// Run with `npm run audit:e2e-first-run-rules`.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const rules = require(path.join(ROOT, "tools", "e2e-first-run-steps.cjs"));
const {
  FIRST_RUN_LANDMARKS,
  FIRST_RUN_STEPS,
  FIRST_RUN_STEP_NAMES,
  firstRunChecks,
  firstRunCheck,
  KNOWN_CLI_COMMANDS,
  isCliSpawn,
  unknownCliCommands,
  isPaidRun,
  paidRuns,
  paidRunsWithoutBudget,
  runSpawnVerdict,
  budgetFlag,
  profileIsolationViolations,
  spawnHomeViolations,
  exclusionHeaderVerdict,
  exclusionRowVerdict,
  under,
} = rules;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const CLI_BIN = path.sep === "/" ? "/opt/app/node_modules/x/bin/opencodereview" : "C:\\app\\node_modules\\x\\bin\\opencodereview.exe";
const WIN_GIT_BIN = "C:\\Program Files\\Git\\cmd\\git.exe";
const cli = (...args) => ({ bin: CLI_BIN, args: args.map(String), env: {} });
const gitSpawn = (...args) => ({ bin: process.platform === "win32" ? WIN_GIT_BIN : "/usr/bin/git", args: args.map(String), env: {} });

/* ---- A. the declared step surface ---- */
{
  check(
    "the step list is frozen, unique, non-empty, and every step declares its needs",
    Object.isFrozen(FIRST_RUN_STEPS) &&
      FIRST_RUN_STEPS.length > 0 &&
      new Set(FIRST_RUN_STEP_NAMES).size === FIRST_RUN_STEP_NAMES.length &&
      FIRST_RUN_STEPS.every((s) => Array.isArray(s.needs) && s.needs.length > 0),
    JSON.stringify(FIRST_RUN_STEP_NAMES)
  );
  const unknownNeeds = FIRST_RUN_STEPS.flatMap((s) => s.needs.filter((n) => !FIRST_RUN_LANDMARKS.includes(n)).map((n) => `${s.name} → ${n}`));
  check("every declared need is a landmark the flow can observe", unknownNeeds.length === 0, unknownNeeds.join("; "));
  const withoutBoot = FIRST_RUN_STEP_NAMES.filter((name) => !FIRST_RUN_STEPS.find((s) => s.name === name).needs.includes("boot"));
  check("every step waits on the throwaway profile, not just on the screen", withoutBoot.length === 0, `steps with no profile precondition: ${withoutBoot.join(", ")}`);
  const deadLandmarks = FIRST_RUN_LANDMARKS.filter((landmark) => !FIRST_RUN_STEPS.some((s) => s.needs.includes(landmark)));
  check("no landmark is declared that nothing depends on", deadLandmarks.length === 0, `unused: ${deadLandmarks.join(", ")}`);
  check(
    "the two quarantine assertions are part of the declared surface",
    FIRST_RUN_STEP_NAMES.includes("the harness booted against a throwaway profile, not the user's") &&
      FIRST_RUN_STEP_NAMES.includes("the user's own CLI config file is byte-for-byte what it was at boot"),
    "they are the only lines that say the fake Key stayed in the temp profile"
  );
}

/* ---- B. landmarks decide what a step may claim ---- */
{
  const green = firstRunChecks(new Set(FIRST_RUN_LANDMARKS));
  check(
    "all landmarks present: one row per step, in order, green and nameless",
    green.length === FIRST_RUN_STEPS.length && green.every((row, i) => row.name === FIRST_RUN_STEP_NAMES[i] && row.ok === true && row.detail === ""),
    JSON.stringify(green.slice(0, 2))
  );
  const none = firstRunChecks(new Set());
  check(
    "no landmark at all: every step is still reported, red, and says it did not run",
    none.length === FIRST_RUN_STEPS.length && none.every((row) => row.ok === false && /did not run$/.test(row.detail)),
    JSON.stringify(none.slice(0, 1))
  );
  const onlyBoot = firstRunChecks(new Set(["boot"]));
  const bootRows = onlyBoot.filter((row) => FIRST_RUN_STEPS.find((s) => s.name === row.name).needs.length === 1);
  const laterRows = onlyBoot.filter((row) => FIRST_RUN_STEPS.find((s) => s.name === row.name).needs.length > 1);
  check(
    "a half-finished flow keeps the early steps green and marks only the later ones red",
    bootRows.every((row) => row.ok === true) && laterRows.every((row) => row.ok === false && !row.detail.includes("boot,")),
    JSON.stringify({ boot: bootRows.length, later: laterRows.slice(0, 1) })
  );
  check("the missing landmark is named, so a red line says how far the flow got", /never reached dialog/.test(firstRunChecks(["boot"])[5].detail), firstRunChecks(["boot"])[5].detail);
  check("an array works as well as a Set (the flow holds a Set; a test may not)", JSON.stringify(firstRunChecks(["boot"])) === JSON.stringify(firstRunChecks(new Set(["boot"]))));
  const thrown = (() => {
    try {
      firstRunCheck(FIRST_RUN_LANDMARKS, "a first-run step nobody declared");
      return null;
    } catch (err) {
      return err;
    }
  })();
  check(
    "asking for an undeclared step throws and names it, instead of being skipped",
    thrown instanceof Error && thrown.message.includes("a first-run step nobody declared"),
    thrown ? thrown.message : "it returned a row, so a typo would silently delete an assertion"
  );
}

/* ---- C. which children cost money ---- */
{
  const cases = [
    ["review --repo x --preview", cli("review", "--repo", "x", "--preview"), false],
    ["review --repo x", cli("review", "--repo", "x"), true],
    ["scan --repo x --preview", cli("scan", "--repo", "x", "--preview"), false],
    ["scan --repo x", cli("scan", "--repo", "x"), true],
    ["config set provider x", cli("config", "set", "provider", "x"), false],
    ["llm test", cli("llm", "test", "--color", "never"), false],
    ["llm providers", cli("llm", "providers", "--color", "never"), false],
    ["session list", cli("session", "list", "--json"), false],
    ["rules check", cli("rules", "check", "--repo", "x", "a.go"), false],
    ["version", cli("version"), false],
    // The bin narrowing's own reverse control: a git call whose first argument
    // happens to read like a CLI command is not a run.
    ["git review", gitSpawn("review", "--bogus"), false],
  ];
  for (const [label, record, expected] of cases) {
    check(`"${label}" ${expected ? "is" : "is not"} a run`, isPaidRun(record) === expected, `isPaidRun → ${isPaidRun(record)}`);
  }
  check("isCliSpawn sorts by the executable, not by argv", isCliSpawn(cli("version")) && !isCliSpawn(gitSpawn("rev-parse", "HEAD")));

  const mixed = [gitSpawn("rev-parse", "HEAD"), cli("llm", "providers"), cli("review", "--preview"), cli("config", "set", "a", "b"), cli("scan")];
  check("paidRuns picks exactly the one run out of a mixed log", paidRuns(mixed).length === 1 && paidRuns(mixed)[0].args[0] === "scan", JSON.stringify(paidRuns(mixed).map((r) => r.args)));
  check("paidRunsWithoutBudget names it (that scan carried no ceiling)", paidRunsWithoutBudget(mixed).length === 1, JSON.stringify(paidRunsWithoutBudget(mixed).map((r) => r.args)));
  check("unknownCliCommands is quiet about the commands the app really uses", unknownCliCommands(mixed).length === 0, JSON.stringify(unknownCliCommands(mixed)));
  check("...and a git spawn's argv never enters that answer", unknownCliCommands([gitSpawn("status", "--short")]).length === 0);
  check(
    "KNOWN_CLI_COMMANDS is exactly what the flow can meet today",
    JSON.stringify(KNOWN_CLI_COMMANDS) === JSON.stringify(["review", "scan", "config", "llm", "rules", "session", "version"]),
    JSON.stringify(KNOWN_CLI_COMMANDS)
  );
}

/* ---- the verdict, which is what the harness reports ---- */
{
  const verdictZero = runSpawnVerdict([cli("review", "--preview"), gitSpawn("diff")], { expected: 0, withBudget: false });
  check("expected 0 with only previews: green", verdictZero.ok, verdictZero.detail);
  const redZero = runSpawnVerdict([cli("review", "--repo", "x")], { expected: 0, withBudget: false });
  check("expected 0 with a real run: red, and it quotes the argv", !redZero.ok && /review --repo x/.test(redZero.detail), redZero.detail);
  const budgeted = [cli("scan", "--repo", "x", budgetFlag, "300000")];
  const greenOne = runSpawnVerdict(budgeted, { expected: 1, withBudget: true });
  check("expected 1 with the ceiling carried: green, and it quotes what ran", greenOne.ok && /max-tokens-budget/.test(greenOne.detail), greenOne.detail);
  const noCeiling = runSpawnVerdict([cli("scan", "--repo", "x")], { expected: 1, withBudget: true });
  check(`expected 1 without ${budgetFlag}: red and names the flag`, !noCeiling.ok && noCeiling.detail.includes(budgetFlag), noCeiling.detail);
  const unknownButQuiet = runSpawnVerdict([cli("analyze", "--repo", "x")], { expected: 0, withBudget: false });
  check(
    "an unrecognised CLI command is red even when the count would pass",
    !unknownButQuiet.ok && /analyze/.test(unknownButQuiet.detail) && /KNOWN_CLI_COMMANDS/.test(unknownButQuiet.detail),
    `${unknownButQuiet.detail} — passing here would let a renamed run command take the guard out of scope`
  );
}

/* ---- D. is the harness really quarantined ---- */
{
  const tempHome = path.sep + path.join("tmp", "ocr-e2e-home-AAA");
  const realHome = path.sep + path.join("home", "dev");
  const cleanEnv = {
    HOME: tempHome,
    USERPROFILE: tempHome,
    OneDrive: tempHome,
    APPDATA: path.join(tempHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
  };
  const clean = {
    env: cleanEnv,
    configPath: path.join(tempHome, ".opencodereview", "config.json"),
    userData: path.join(tempHome, "userData"),
    tempHome,
    realHome,
  };
  const cases = [
    ["a fully redirected profile", clean, 0],
    ["HOME left at the real home", { ...clean, env: { ...cleanEnv, HOME: realHome } }, 1],
    ["USERPROFILE left at the real home (Windows)", { ...clean, env: { ...cleanEnv, USERPROFILE: realHome } }, 1],
    ["APPDATA outside the throwaway home", { ...clean, env: { ...cleanEnv, APPDATA: path.join(realHome, "AppData", "Roaming") } }, 1],
    ["the CLI config path still under the real home", { ...clean, configPath: path.join(realHome, ".opencodereview", "config.json") }, 1],
    ["the Electron profile still in the real one", { ...clean, userData: path.join(realHome, ".config", "open-code-review-desktop") }, 1],
    ["no throwaway home at all", { ...clean, tempHome: "" }, 3],
    ["the throwaway home IS the real home", { ...clean, tempHome: realHome, configPath: path.join(realHome, ".opencodereview", "config.json"), userData: path.join(realHome, "userData"), env: { ...cleanEnv, HOME: realHome, USERPROFILE: realHome, OneDrive: realHome, APPDATA: path.join(realHome, "AppData", "Roaming"), LOCALAPPDATA: path.join(realHome, "AppData", "Local") } }, 1],
    ["an unknown real home", { ...clean, realHome: "" }, 1],
  ];
  for (const [label, input, atLeast] of cases) {
    const violations = profileIsolationViolations(input);
    check(
      atLeast === 0 ? `${label}: no violations` : `${label}: at least ${atLeast} violation(s) named`,
      violations.length >= atLeast,
      JSON.stringify(violations)
    );
  }
  const identical = profileIsolationViolations({ ...clean, tempHome: realHome });
  check("a temp home equal to the real one is refused in words, not silently", identical.some((line) => /IS the real home/.test(line)), JSON.stringify(identical));
}

/* ---- E. whose home each child ran in ---- */
{
  const tempHome = "/tmp/ocr-e2e-home-AAA";
  const realHome = "/home/dev";
  const prefix = "/tmp/ocr-llmtest-";
  const at = (home, ...args) => ({ bin: CLI_BIN, args: args.map(String), env: { HOME: home } });
  const allOurs = [at(tempHome, "review", "--preview"), at(tempHome, "config", "set", "a", "b")];
  const cleanAnswer = spawnHomeViolations(allOurs, { tempHome, realHome, llmTestPrefix: prefix });
  check("every child in the harness home: no violation, no sandbox claimed", cleanAnswer.violations.length === 0 && cleanAnswer.sandboxes.length === 0, JSON.stringify(cleanAnswer));
  const withSandbox = spawnHomeViolations([...allOurs, at(`${prefix}xyz`, "llm", "test")], { tempHome, realHome, llmTestPrefix: prefix });
  check(
    "the app's own throwaway CLI-test profile is allowed, and counted",
    withSandbox.violations.length === 0 && withSandbox.sandboxes.length === 1,
    JSON.stringify(withSandbox)
  );
  const ontoReal = spawnHomeViolations([at(realHome, "config", "set", "providers.x.api_key", "sk-fake")], { tempHome, realHome, llmTestPrefix: prefix });
  check("a child running in the developer's real home is named", ontoReal.violations.length === 1 && /real home/.test(ontoReal.violations[0]), JSON.stringify(ontoReal));
  const elsewhere = spawnHomeViolations([at("/tmp/somebody-else", "review")], { tempHome, realHome, llmTestPrefix: prefix });
  check("a third home is neither allowed nor ignored", elsewhere.violations.length === 1 && /neither home/.test(elsewhere.violations[0]), JSON.stringify(elsewhere));
}

/* ---- E′. the path predicate every answer above rests on ---- */
{
  const home = path.join(path.sep + "tmp", "ocr-e2e-home-AAA");
  const cases = [
    [path.join(home, ".opencodereview", "config.json"), true],
    [home, true],
    // The trap: `ocr-e2e-home-AAAB` starts with the same characters and is a
    // different directory — a prefix test would call a write outside the harness
    // a write inside it.
    [path.join(path.sep + "tmp", "ocr-e2e-home-AAAB", "config.json"), false],
    [path.join(path.sep + "home", "dev", ".opencodereview"), false],
    ["", false],
    [null, false],
  ];
  for (const [target, expected] of cases) {
    check(`under(${JSON.stringify(target)}, the throwaway home) is ${expected}`, under(target, home) === expected, String(under(target, home)));
  }
}

/* ---- F. the exclusion block ---- */
{
  const screen = "进入审查的文件\n1 个文件进入审查\n以下 2 个不进入审查\ngo.mod\ntestdata/sample.json\n";
  check("the header is judged by the CLI's own count", exclusionHeaderVerdict({ screen, dropCount: 2 }).ok);
  const wrongCount = exclusionHeaderVerdict({ screen, dropCount: 3 });
  check("...and a count that does not match the payload is red", !wrongCount.ok && wrongCount.detail.includes("以下 3 个不进入审查"), wrongCount.detail);
  check("a translated reason cell is green and quotes it", exclusionRowVerdict({ path: "go.mod", rawReason: "unsupported_ext", rowText: "暂不支持的类型" }).ok);
  const raw = exclusionRowVerdict({ path: "go.mod", rawReason: "unsupported_ext", rowText: "unsupported_ext" });
  check("a cell that still carries the CLI's raw key is red", !raw.ok && /raw key/.test(raw.detail), raw.detail);
  check("a missing row is red and says it is missing", !exclusionRowVerdict({ path: "go.mod", rawReason: "x", rowText: null }).ok);
  check("a blank cell is red — an empty reason is not a translated one", !exclusionRowVerdict({ path: "go.mod", rawReason: "x", rowText: "   " }).ok);
  check("undefined leaking into the cell is red", !exclusionRowVerdict({ path: "go.mod", rawReason: "x", rowText: "undefined" }).ok);
}

/* ---- G. the harness and the gate still use this surface ---- */
{
  const harness = fs.readFileSync(path.join(ROOT, "tools", "e2e-first-run.cjs"), "utf8");
  const runner = fs.readFileSync(path.join(ROOT, "tools", "e2e-first-run.mjs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const notWired = FIRST_RUN_STEP_NAMES.filter((name) => !harness.includes(JSON.stringify(name)));
  check(
    "every declared step is still a step the harness reports",
    notWired.length === 0,
    `missing from tools/e2e-first-run.cjs: ${notWired.join(" | ")}`
  );
  check(
    "the harness takes the verdicts from this module rather than deciding them inline",
    /require\(path\.join\(ROOT, "tools", "e2e-first-run-steps\.cjs"\)\)/.test(harness) &&
      /firstRunCheck\(landmarks, name\)/.test(harness) &&
      /runSpawnVerdict\(spawnLog/.test(harness) &&
      /spawnHomeViolations\(spawnLog/.test(harness),
    "the red-on-missing-landmark and the run-sorting decisions must not live in the Electron file"
  );
  check(
    "...and the did-not-run sentence stays in this module",
    !/so this step did not run/.test(harness) && !/if \(!dialogIsStubbed\) return check\(/.test(harness),
    "the wording a red line carries is the verdict; writing it inline is how the picker decision ended up untested"
  );
  check(
    "...and the harness does not re-derive which child is the CLI's",
    !/args\[0\] === "review"/.test(harness) && /cliCommands\(spawnLog\)/.test(harness),
    "one rule for `is this a CLI child`, in one place; a second copy here is a second place to be wrong"
  );
  const usesDialogPortalScope = /dialogButton|pressDialogButton/.test(harness) && !/pressButton\(window, "取消"\)\s*;[\s\S]{0,200}这次扫描的规模不小/.test(harness);
  check("the cost dialog is pressed through its own portal scope, not through main", usesDialogPortalScope, "Radix portals the dialog outside <main>; a `main button` search would read as 'the guard never appeared'");
  check("the runner launches the harness and reads a report, not stdout", /e2e-first-run\.cjs/.test(runner) && /report\.json/.test(runner));
  check("audit:app runs the first-run harness", (pkg.scripts["audit:app"] || "").includes("audit:e2e-first-run"));
  check("audit:static runs these rules", (pkg.scripts["audit:static"] || "").includes("audit:e2e-first-run-rules"));
  check("the script pair is defined", Boolean(pkg.scripts["audit:e2e-first-run"]) && Boolean(pkg.scripts["audit:e2e-first-run-rules"]));
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all first-run rule checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
