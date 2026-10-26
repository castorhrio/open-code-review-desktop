// Pins "the picker stub did not take" as a per-step red line, not a skipped one.
//
// The end-to-end flow can only exercise the pickers when `dialog.showOpenDialog`
// is replaceable. When it is not, the steps must still appear in the report and
// must appear red: a check that disappears is counted as a pass by anything that
// counts failures, and that is the exact shape this harness exists to stop.
// `tools/e2e-picker.cjs` now owns that verdict; before this file it was an
// inline branch in `e2e-flow.cjs`, which needs Electron and a real CLI.
//
// Run with `npm run audit:e2e-picker`.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const {
  PICKER_STEP_NAMES,
  PICKER_STUB_MARK,
  PICKER_STUB_MISSING,
  pickerChecks,
  pickerCheck,
} = require(path.join(ROOT, "tools", "e2e-picker.cjs"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// The list is the whole picker surface. Hard-coded here on purpose: adding a
// picker assertion without declaring it (or renaming one) is a change to that
// surface, and it should require a second look rather than drift along with the
// module. `e2e-flow.cjs` uses the same names, and the last block checks that.
const EXPECTED = [
  "全量扫描 shows the 扫描路径 field the picker fills",
  "repo:pickInside hands the renderer a repo-relative path",
  "...and the dialog was asked for a directory, starting at the repo",
  "a cancelled pick leaves 扫描路径 alone and says nothing",
  "a pick outside the repo is refused on screen, not silently dropped",
  "...and 扫描路径 is not widened to the whole repo by the refusal",
  "a relative repo path is refused before the dialog is asked",
  "repo:pickFile with no options opens the all-files picker",
];

/* ---- the declared surface ---- */
{
  check(
    "the step list is frozen, unique and non-empty",
    Object.isFrozen(PICKER_STEP_NAMES) &&
      PICKER_STEP_NAMES.length > 0 &&
      new Set(PICKER_STEP_NAMES).size === PICKER_STEP_NAMES.length,
    JSON.stringify(PICKER_STEP_NAMES)
  );
  check(
    "the step list is exactly the picker assertions the flow reports",
    JSON.stringify(PICKER_STEP_NAMES) === JSON.stringify(EXPECTED),
    JSON.stringify({ declared: PICKER_STEP_NAMES, expected: EXPECTED })
  );
}

/* ---- stubbed: the flow will run the step, so no red line is manufactured ---- */
{
  const rows = pickerChecks(true);
  check(
    "stubbed: one row per step, in order, and every row is green with no detail",
    rows.length === PICKER_STEP_NAMES.length &&
      rows.every((row, index) => row.name === PICKER_STEP_NAMES[index] && row.ok === true && row.detail === ""),
    JSON.stringify(rows)
  );
}

/* ---- not stubbed: every step is red and names the reason ----
 * `undefined` is the interesting one: it is what a property read returns after a
 * patch that silently did not land. Treating it as "unknown, so skip" would put
 * the report back where it started, so anything but `true` is a red step.
 */
{
  for (const state of [false, undefined, null, 0, "yes", {}, []]) {
    const rows = pickerChecks(state);
    const label = JSON.stringify(state) ?? String(state);
    check(
      `not stubbed (${label}): every step is present, red, and names ${PICKER_STUB_MARK}`,
      rows.length === PICKER_STEP_NAMES.length &&
        rows.every(
          (row, index) =>
            row.name === PICKER_STEP_NAMES[index] &&
            row.ok === false &&
            row.detail.includes(PICKER_STUB_MARK) &&
            row.detail.includes(PICKER_STUB_MISSING)
        ),
      JSON.stringify(rows.slice(0, 1))
    );
  }
}

/* ---- the single-step lookup, which is what the flow calls ---- */
{
  const green = pickerCheck(true, PICKER_STEP_NAMES[0]);
  check(
    "pickerCheck answers the declared row for that step",
    green.name === PICKER_STEP_NAMES[0] && green.ok === true,
    JSON.stringify(green)
  );
  const red = pickerCheck(false, PICKER_STEP_NAMES[0]);
  check(
    "...and the same lookup is red when the stub is missing",
    red.name === PICKER_STEP_NAMES[0] && red.ok === false && red.detail.includes(PICKER_STUB_MARK),
    JSON.stringify(red)
  );
  const thrown = (() => {
    try {
      pickerCheck(true, "a picker step nobody declared");
      return null;
    } catch (error) {
      return error;
    }
  })();
  check(
    "an undeclared step throws and names it, instead of being skipped",
    thrown instanceof Error && thrown.message.includes("a picker step nobody declared"),
    thrown ? thrown.message : "it returned a row, so a typo would silently delete an assertion"
  );
}

/* ---- the flow uses this surface, and no longer decides the red itself ---- */
{
  const flowSrc = fs.readFileSync(path.join(ROOT, "tools", "e2e-flow.cjs"), "utf8");
  check(
    "e2e-flow.cjs takes the picker verdict from tools/e2e-picker.cjs",
    /require\(path\.join\(ROOT, "tools", "e2e-picker\.cjs"\)\)/.test(flowSrc) &&
      /pickerVerdict\(dialogIsStubbed, name\)/.test(flowSrc),
    "the red-on-missing-stub decision must not live inline in the flow"
  );
  check(
    "...and no longer writes the missing-stub branch itself",
    !/if \(!dialogIsStubbed\) return check\(/.test(flowSrc) &&
      !/STUB_MISSING\s*=/.test(flowSrc),
    "the branch that turned a missing stub into a red line is now a value"
  );
  check(
    "...and every declared step is one the flow actually reports",
    PICKER_STEP_NAMES.every((name) => flowSrc.includes(JSON.stringify(name))),
    JSON.stringify(PICKER_STEP_NAMES.filter((name) => !flowSrc.includes(JSON.stringify(name))))
  );
  check(
    "...and the flow reports every declared step, so none can vanish from the summary",
    /PICKER_STEP_NAMES\.every\(\(name\) => pickerReported\.has\(name\)\)/.test(flowSrc),
    "without this, deleting a pickerCheck call would delete an assertion"
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all e2e-picker checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
