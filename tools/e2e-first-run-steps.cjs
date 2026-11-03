// The judgements the first-run harness makes, kept out of `e2e-first-run.cjs` so
// they can be exercised without Electron and without a real CLI.
//
// `tools/e2e-flow.cjs` starts from a configured app: it seeds `last-repo`, hides
// the guide, and waits for a preview that the review page computes by itself. The
// chain a *new* installation walks — empty profile → guide → pick the repository
// → configure a model service → the run gate — was walked by nobody, which is the
// gap `docs/PRODUCT-DOD.md` names for DOD-4. This harness walks it, and the
// decisions it has to get right are here:
//
// 1. **Which steps exist.** A first-run check that silently stops running is
//    counted as a pass by anything that counts failures, so the step list is a
//    declared value and each step names the landmark it depends on. A missing
//    landmark turns the dependent steps red and says which one; it never removes
//    them from the report. (Same rule `tools/e2e-picker.cjs` pins for the pickers.)
// 2. **Which spawns cost money.** The run gate's promise is "nothing left this
//    process toward a provider until a model was configured". The evidence is the
//    process's own spawn log, and two rules decide how that log is read: only a
//    child of the CLI has a command word at all (git is spawned through the same
//    recorder), and a command the list does not know is *reported* rather than
//    counted as harmless — a renamed run command must not be able to make the gate
//    pass by going out of scope. `review` and `scan` are the two commands that
//    reach a provider, and `--preview` next to either means git and the rule tables
//    only. So the classification is a pure function over recorded `{bin, args}`,
//    not a guess the harness re-decides at each call site.
// 3. **Whether the harness is actually quarantined.** It writes a fake API Key.
//    If the isolation did not take, that Key lands in the user's real
//    `~/.opencodereview/config.json` — the exact thing DOD-6 promises never to do.
//    So "am I inside the throwaway profile" is a predicate with a test, not an
//    assumption in a comment.
"use strict";

const path = require("node:path");

// ---- 1. the declared step surface ----

// A landmark is an observed fact about how far the flow got, recorded by the
// step that produced it: `dialog` is added when the folder dialog was really
// asked, `provider-saved` when the fake entry reached the config view. No step
// may need a landmark its own body adds — that makes it unsatisfiable on the way
// in and meaningless on the way out — so the list below is read as "what the
// earlier half of the flow had to have done".
const FIRST_RUN_LANDMARKS = Object.freeze(["boot", "dialog", "repo-picked", "settings-form", "provider-saved", "confirm-shown"]);

const FIRST_RUN_STEPS = Object.freeze([
  { name: "the harness booted against a throwaway profile, not the user's", needs: ["boot"] },
  { name: "the first screen is a first run: no remembered repository, guide not dismissed", needs: ["boot"] },
  { name: "the guide card offers its three steps and both actions that are still open", needs: ["boot"] },
  { name: "开始审查 is refused before a repository is chosen, and says what it wants", needs: ["boot"] },
  { name: "「选择仓库」 asks the OS dialog once and takes its answer", needs: ["boot"] },
  { name: "the file list computes itself after the pick, through a real --preview", needs: ["boot", "dialog"] },
  { name: "the files the CLI refused are listed as refused, each with a translated reason", needs: ["boot", "dialog", "repo-picked"] },
  { name: "the settings page names the same gap the run gate names", needs: ["boot", "dialog", "repo-picked"] },
  { name: "saving an entry with no Key does not unlock 开始审查", needs: ["boot", "dialog", "repo-picked"] },
  { name: "...and no review or scan process left the process before a model was configured", needs: ["boot", "dialog", "settings-form"] },
  { name: "filling the Key on that same entry unlocks 开始审查 with the list intact", needs: ["boot", "dialog", "settings-form"] },
  { name: "no child process ever ran against the developer's real home", needs: ["boot"] },
  { name: "the user's own CLI config file is byte-for-byte what it was at boot", needs: ["boot"] },
  { name: "全量扫描 past the threshold asks before it spends", needs: ["boot", "dialog", "provider-saved"] },
  { name: "...and 取消 in that dialog leaves no process behind", needs: ["boot", "dialog", "confirm-shown"] },
  { name: "...and 仍然开始 spawns exactly one run, carrying the --max-tokens-budget that was set", needs: ["boot", "dialog", "confirm-shown"] },
  { name: "不再提示 retires the guide, and it stays retired across a reload", needs: ["boot", "dialog", "repo-picked"] },
]);

const FIRST_RUN_STEP_NAMES = Object.freeze(FIRST_RUN_STEPS.map((step) => step.name));

const stepByName = (name) => FIRST_RUN_STEPS.find((step) => step.name === name);

const missingLandmarks = (available, step) => step.needs.filter((need) => !available.has(need));

/**
 * One row per declared step, for a flow that reached `available` landmarks.
 *
 * Green here means only "the landmark arrived, the flow will decide this step";
 * the flow still has to report the outcome. Red means the flow never got far
 * enough to judge it, and names how far it did get.
 */
const firstRunChecks = (available) => {
  const reached = available instanceof Set ? available : new Set(available || []);
  return FIRST_RUN_STEPS.map((step) => {
    const missing = missingLandmarks(reached, step);
    return missing.length
      ? { name: step.name, ok: false, detail: `the flow never reached ${missing.join(" / ")}, so this step did not run` }
      : { name: step.name, ok: true, detail: "" };
  });
};

const firstRunCheck = (available, name) => {
  const step = stepByName(name);
  if (!step) {
    throw new Error(
      `unknown first-run step ${JSON.stringify(name)} — declare it in FIRST_RUN_STEPS first, so it cannot be skipped`
    );
  }
  return firstRunChecks(available).find((row) => row.name === name);
};

// ---- 2. which spawns cost money ----

// `ocr review` and `ocr scan` are the two commands that read a model service. A
// `--preview` of either asks git and the rule tables only, costs no tokens and
// needs no Key — which is why the review page runs it unattended. Everything else
// the app asks the CLI for (`config set`, `llm providers`, `llm test`,
// `session list`, `rules check`, `version`) is not a run.
//
// Only a child of the CLI itself carries a command word: `git-service.js` spawns
// `git rev-parse …` through the same recorder, and reading argv[0] of that as a
// subcommand would sort the log by nonsense.
const RUN_COMMANDS = Object.freeze(["review", "scan"]);

// Everything the app asks the CLI for today. A command outside this list is not
// silently treated as "not a run" — it is reported, because that is exactly how a
// renamed run command would make the gate's evidence go quietly green.
const KNOWN_CLI_COMMANDS = Object.freeze(["review", "scan", "config", "llm", "rules", "session", "version"]);

const cliBaseName = (record) => String((record && record.bin) || "").split(/[\\/]/).pop();

const isCliSpawn = (record) => /^opencodereview(\.exe)?$/i.test(cliBaseName(record));

const commandWord = (record) => String((record && record.args && record.args[0]) || "");

const cliCommands = (records) => (records || []).filter(isCliSpawn);

const unknownCliCommands = (records) => {
  const seen = new Set();
  for (const record of cliCommands(records)) {
    const word = commandWord(record);
    if (!KNOWN_CLI_COMMANDS.includes(word)) seen.add(word || "(empty argv)");
  }
  return [...seen];
};

const isPaidRun = (record) =>
  Boolean(record) && isCliSpawn(record) && RUN_COMMANDS.includes(commandWord(record)) && !record.args.includes("--preview");

const paidRuns = (records) => cliCommands(records).filter(isPaidRun);

// The budget flag is the difference between "this run stops where you said" and
// "this run stops when you notice". A scan that starts without it after the
// confirmation quoted a token estimate is the product lying about its own number.
const budgetFlag = "--max-tokens-budget";

const paidRunsWithoutBudget = (records) => paidRuns(records).filter((record) => !record.args.includes(budgetFlag));

const runSpawnVerdict = (records, { expected, withBudget }) => {
  const unknown = unknownCliCommands(records);
  if (unknown.length) {
    return {
      ok: false,
      detail: `the flow saw a CLI command it does not know how to sort: ${unknown.join(", ")} — add it to KNOWN_CLI_COMMANDS in tools/e2e-first-run-steps.cjs only after reading what it does, because a run command that leaves this list silently stops counting`,
    };
  }
  const runs = paidRuns(records);
  const listed = runs.map((record) => record.args.join(" "));
  if (runs.length !== expected) {
    return {
      ok: false,
      detail: `${runs.length} run spawn(s), expected ${expected}${listed.length ? `: ${listed.join(" | ")}` : ""}`,
    };
  }
  if (!expected) return { ok: true, detail: "" };
  const withoutBudget = paidRunsWithoutBudget(records);
  if (withBudget && withoutBudget.length) {
    return { ok: false, detail: `the run started without ${budgetFlag}: ${withoutBudget[0].args.join(" ")}` };
  }
  if (!withBudget && withoutBudget.length !== expected) {
    return { ok: false, detail: `budget bookkeeping disagrees: ${listed.join(" | ")}` };
  }
  return { ok: true, detail: listed.join(" | ") };
};

// ---- 3. is the harness really quarantined? ----

const under = (file, dir) => Boolean(file && dir) && (file === dir || file.startsWith(dir + path.sep));

/**
 * Every place the CLI and the renderer would write, answered as violations.
 *
 * The harness writes a fake API Key through the real `ocr config set`, so a HOME
 * that was not redirected puts that Key in the user's own config — a state no
 * audit can undo afterwards. Anything that is not inside the throwaway home is a
 * violation and names the variable it found.
 */
const profileIsolationViolations = ({ env, configPath, userData, tempHome, realHome }) => {
  const e = env || {};
  const out = [];
  if (!tempHome) out.push("no throwaway home was created");
  if (!realHome) out.push("the real home directory is unknown, so nothing proves the two are different");
  else if (tempHome === realHome) out.push(`the throwaway home IS the real home (${realHome})`);
  for (const key of ["HOME", "USERPROFILE", "OneDrive"]) {
    if (e[key] !== tempHome) out.push(`${key}=${JSON.stringify(e[key])} is not the throwaway home`);
  }
  for (const key of ["APPDATA", "LOCALAPPDATA"]) {
    if (!under(e[key], tempHome)) out.push(`${key}=${JSON.stringify(e[key])} is not under the throwaway home`);
  }
  if (!under(configPath, tempHome)) out.push(`the CLI config path resolves to ${JSON.stringify(configPath)}`);
  if (!under(userData, tempHome)) out.push(`the Electron profile resolves to ${JSON.stringify(userData)}`);
  return out;
};

/**
 * Which child processes ran somewhere this harness does not own.
 *
 * The rule is not "every spawn must carry the throwaway home": the product's own
 * connectivity test deliberately runs the CLI against a *second* throwaway HOME
 * (`config-handler.js`: a saved Key silently wins over `OCR_LLM_*`, so testing
 * values that were never saved means an empty profile), and that is the app
 * isolating itself, not the harness failing to. What must never happen is a child
 * pointing at the developer's real home — that is the one place the fake Key would
 * become a real one's neighbour. So: the harness home and the CLI-test sandboxes
 * under the same temp root are allowed, anything else is named.
 */
const spawnHomeViolations = (records, { tempHome, realHome, llmTestPrefix }) => {
  const violations = [];
  const sandboxes = [];
  for (const record of records || []) {
    const home = record && record.env ? record.env.HOME : undefined;
    if (home === tempHome) continue;
    if (home === realHome) {
      violations.push(`${(record.args || []).join(" ")} ran against the real home (${realHome})`);
      continue;
    }
    if (llmTestPrefix && typeof home === "string" && home.startsWith(llmTestPrefix)) {
      sandboxes.push(home);
      continue;
    }
    violations.push(`${(record.args || []).join(" ")} ran with HOME=${JSON.stringify(home)}, which is neither home`);
  }
  return { violations, sandboxes };
};

// ---- the exclusion rows ----

// The list region says "以下 N 个不进入审查" and then one row per excluded file.
// Both halves come from the CLI payload, so a renderer that counts its own rows or
// prints the raw `exclude_reason` key is the failure this catches.
const exclusionHeaderVerdict = ({ screen, dropCount }) => {
  const expected = `以下 ${dropCount} 个不进入审查`;
  return {
    ok: screen.includes(expected),
    detail: screen.includes(expected) ? "" : `the exclusion block does not read ${JSON.stringify(expected)}; the CLI refused ${dropCount} file(s)`,
  };
};

const exclusionRowVerdict = ({ path: filePath, rawReason, rowText }) => {
  const text = String(rowText === null || rowText === undefined ? "" : rowText).trim();
  if (!rowText) {
    return { ok: false, detail: `${filePath} is not in the exclusion block at all` };
  }
  if (text === String(rawReason)) {
    return { ok: false, detail: `${filePath} shows the CLI's raw key ${JSON.stringify(rawReason)} instead of the label` };
  }
  if (!text || /undefined|NaN/.test(text)) {
    return { ok: false, detail: `${filePath}'s reason cell reads ${JSON.stringify(text)}` };
  }
  return { ok: true, detail: `${filePath} → ${text}` };
};

module.exports = {
  FIRST_RUN_LANDMARKS,
  FIRST_RUN_STEPS,
  FIRST_RUN_STEP_NAMES,
  firstRunChecks,
  firstRunCheck,
  RUN_COMMANDS,
  KNOWN_CLI_COMMANDS,
  isCliSpawn,
  cliCommands,
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
};
