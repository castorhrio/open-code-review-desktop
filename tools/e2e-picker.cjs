// The picker half of the end-to-end report, kept out of `e2e-flow.cjs` so the
// "the stub did not take" verdict can be exercised without Electron.
//
// `e2e-flow.cjs` replaces `dialog.showOpenDialog` with a queue of answers, and
// the picker steps then ask nobody. When that patch cannot be installed, a real
// modal would open and no one could click it — so the steps do not run. The old
// code wrote that decision inline (`if (!dialogIsStubbed) return check(name,
// false, ...)`), which meant the one failure mode this harness exists to prevent
// — a step that vanishes from the report and is counted as a pass — was guarded
// by a branch with no test of its own.
//
// So the step list and the verdict are values here. `pickerChecks` answers one
// row per step: green and nameless when the stub took (the flow will run the
// step and decide it), red with the marker when it did not. `pickerCheck` is the
// single-step lookup the flow uses; asking for a step that is not declared is an
// error rather than a skipped check, because a typo would otherwise delete an
// assertion silently.
//
// The three states are deliberately distinct: `true` means stubbed, **anything
// else** means not stubbed. In particular `undefined` (the property read back
// after a patch that did not land) must not read as "unknown, so skip".
"use strict";

const PICKER_STUB_MARK = "PICKER_STUB";

const PICKER_STUB_MISSING =
  "dialog.showOpenDialog is not writable in this Electron/sandbox combination, so this picker step did not run";

// One entry per assertion that needs the dialog stub. Kept in the order the
// flow reports them, and named exactly as the flow's `pickerCheck` calls, so the
// reported report and the declared surface are the same list.
const PICKER_STEP_NAMES = Object.freeze([
  "全量扫描 shows the 扫描路径 field the picker fills",
  "repo:pickInside hands the renderer a repo-relative path",
  "...and the dialog was asked for a directory, starting at the repo",
  "a cancelled pick leaves 扫描路径 alone and says nothing",
  "a pick outside the repo is refused on screen, not silently dropped",
  "...and 扫描路径 is not widened to the whole repo by the refusal",
  "a relative repo path is refused before the dialog is asked",
  "repo:pickFile with no options opens the all-files picker",
]);

const pickerChecks = (dialogIsStubbed) =>
  PICKER_STEP_NAMES.map((name) =>
    dialogIsStubbed === true
      ? { name, ok: true, detail: "" }
      : { name, ok: false, detail: `${PICKER_STUB_MISSING} [${PICKER_STUB_MARK}]` }
  );

const pickerCheck = (dialogIsStubbed, name) => {
  if (!PICKER_STEP_NAMES.includes(name)) {
    throw new Error(
      `unknown picker step ${JSON.stringify(name)} — declare it in PICKER_STEP_NAMES first, so it cannot be skipped`
    );
  }
  return pickerChecks(dialogIsStubbed).find((row) => row.name === name);
};

module.exports = {
  PICKER_STEP_NAMES,
  PICKER_STUB_MARK,
  PICKER_STUB_MISSING,
  pickerChecks,
  pickerCheck,
};
