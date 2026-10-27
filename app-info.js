// SPDX-License-Identifier: Apache-2.0
"use strict";

// The body of `app:info`, kept out of `main.js` so it can be called.
//
// `main.js` wires IPC; a value assembled inside a handler can only be observed
// by launching Electron and asking the renderer. The three answers that matter
// here are all about absent or misplaced data — no binary, a version on stdout,
// a version on stderr — and each one is shown verbatim in the settings page, so
// a wrong shape is visible to the user rather than just to a log. Pure and
// exported so `tools/app-info-smoke.mjs` can assert all three without Electron.

const firstNonEmptyLine = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || "";

// The CLI normally prints its version on stdout; some builds announce it on
// stderr instead, so whichever actually spoke is the one to read. Only the
// first non-empty line is a version — the rest is a banner. The name prefix is
// part of the sentence, not part of the version the page wants to show.
//
// Only the product's long name is stripped. The binary is also called `ocr`,
// but a line starting with that word is not the same declaration, and guessing
// which short name a future build might print is how a version number loses a
// word that was part of it. `tools/app-info-smoke.mjs` pins the other side too:
// `ocr 1.13.3` keeps its prefix.
const readVersion = (binaryPath, stdout, stderr) => {
  if (!binaryPath) return "";
  const line = firstNonEmptyLine(stdout) || firstNonEmptyLine(stderr);
  return line.replace(/^open-code-review\s*/, "");
};

/* ---- one decision, three places: `timedOut` / `probeError` stay internal ----
 *
 * `readVersionOutput` answers with two diagnostics the settings page does not
 * render: `timedOut` ("we stopped waiting") and `probeError` ("the exec threw").
 * `main.js` spreads the whole answer into `formatAppInfo`, so the drop happens
 * here, and it is recorded in three places that must move together:
 *
 *   1. this file — both are named parameters and `void`-ed above the return
 *      object. An unnamed extra key and a discarded one would look identical.
 *   2. `tools/app-info-smoke.mjs` — the payload's pinned key set excludes both
 *      names even when the probe carries them, and that suite cross-checks the
 *      computed-key list against `src/lib/types.ts`.
 *   3. `src/lib/types.ts` — `AppInfo` declares neither field, so the renderer
 *      cannot read a value the payload never ships.
 *
 * Dropping a diagnostic from the payload is not the same as dropping it
 * entirely: `probeError` is the one that says the service *broke*, and with no
 * other exit it vanished the moment the answer was assembled. `handleAppInfo`
 * therefore hands it to an injected `onProbeError` sink (a no-op by default),
 * and `main.js` sends it to the same `run:log` channel the uninstall warnings
 * use — so the fact lands where a packaged app can read it, not on a stderr
 * nobody has a terminal for. `timedOut` keeps no sink: the wait is
 * bounded by this module's own budget, so "we stopped waiting" is a performance
 * fact whose user-visible consequence (an empty version) the payload already
 * carries, while an exception is a failure nothing else would report.
 *
 * Shipping them later means touching all of them: add the fields to `AppInfo`
 * and to the return object, add their names to `APP_INFO_COMPUTED_KEYS`, and
 * extend the smoke test's pinned key set. Changing one alone leaves the other
 * two asserting the opposite, which is why the places are listed rather than
 * left to be rediscovered.
 */

function formatAppInfo({
  binary,
  versionStdout = "",
  versionStderr = "",
  // `readVersionOutput` also answers *whether this side stopped waiting*, and
  // that flag is accepted and dropped here on purpose (see the comment above
  // `version:` below). Naming it is what makes the drop a decision: an unnamed
  // extra key and a deliberately discarded one look identical in the source,
  // and `main.js` hands this function the whole probe answer (`...probe`) so
  // that `app:info` never picks fields off it. `tools/app-info-smoke.mjs` pins
  // the absence in the payload — including the key set — so the day someone
  // decides the page should say "CLI 未在 N 秒内回话", it turns red here first.
  timedOut = false,
  // The probe's other internal diagnostic, dropped for the same reason and with
  // the same name-it-to-decide-it shape: `probeError` is what `readVersionOutput`
  // records when the `exec` itself *failed* (a throw) rather than answered
  // nothing. `version: ""` is still the answer either way — the page has one
  // sentence for "no version" and a separate `binary` for "not found" — but
  // folding an exception into silence is then a decision this line makes, not
  // something a `.catch()` did on the way past. `tools/app-info-smoke.mjs` pins
  // the absence in the payload, the key set against an answer that carried it,
  // and the fact that the registration never picks fields off the probe.
  probeError = null,
  configPath = "",
  docsUrl = "",
  appVersion = "",
  platform = "",
  installInfo = {},
} = {}) {
  const binaryPath = binary && binary.path ? binary.path : null;
  void timedOut;
  void probeError;
  return {
    // The install facts are spread *first*, so a field of theirs that happens to
    // share a name with one of this function's own answers cannot replace it.
    // The keys below are the answers `app:info` itself gives: `version` comes
    // out of `readVersion` (the probe's budgets already decided what could be
    // read) and `binarySource` is deliberately nulled when there is no path.
    // An install fact called `binary` or `version` is not a better answer to
    // those questions — it is a name collision — so it loses, and the payload
    // keeps saying what this function decided.
    //
    // The cost is stated rather than hidden: a colliding install field vanishes
    // without a word. `tools/app-info-smoke.mjs` reads the collision surface off
    // this function's own return keys (not off a hand-written list of seven) and
    // gives each of them an `evil-*` value through `installInfo`, requiring the
    // computed value to survive — so the day someone moves the spread back below
    // them, the natural edit if `installInfo` reads as "more fields to add", the
    // test is what says the decision changed.
    ...(installInfo || {}),
    binary: binaryPath,
    // "not found" has one answer here: no path, no source. Copying a stale
    // `source` next to a null `path` would let the page say "package" while
    // also saying it could not find the package.
    binarySource: binaryPath ? (binary && binary.source) || null : null,
    // One sentence, one answer: "the version, or nothing". A probe that timed
    // out and a CLI that printed nothing both land on `""`, and the page still
    // has `binary`/`binarySource` to tell "not found" apart from "found but
    // silent" — which is the whole reason `binary` is reported separately. A
    // `versionTimedOut` boolean would be a payload field no renderer reads
    // (`src/lib/types.ts`'s `AppInfo` has no place for it), so it stops here
    // rather than shipping as a field that is only ever asserted to exist.
    version: readVersion(binaryPath, versionStdout, versionStderr),
    configPath,
    docsUrl,
    appVersion,
    platform,
  };
}

/* ---- the probe, with a deadline the CLI cannot extend ----
 *
 * `app:info` is what the settings page renders, and it renders nothing until the
 * answer arrives. A `ocr version` that never returns — the binary held open by
 * an antivirus, a copy on a network share, a spawn that never closes — used to
 * leave the promise pending for the life of the window, so the page stayed blank
 * with nothing on screen explaining it. The version is the only part of the
 * answer that needs the CLI at all; the binary path, the config path and the
 * install facts are already in hand.
 *
 * Two budgets, because they cover different failures:
 *
 *  - `timeoutMs` is handed to the service, which kills the child with it. The
 *    child has to die regardless of whether anyone is still waiting for it;
 *  - the outer deadline is `timeoutMs` plus a small grace, and covers what the
 *    first budget cannot: an `exec` that does not honour it. `exec` is an
 *    injected argument here exactly so that shape is producible — a service that
 *    hangs is otherwise reachable only by breaking a user's machine.
 *
 * A probe that said nothing is not an error. `formatAppInfo` reads empty output
 * as "the CLI said nothing" (`version: ""`), which is what happened, and the page
 * still receives an every-field-complete object to render. The injected `exec` is
 * called as `exec(args, { timeoutMs })` and may throw; a throw answers empty
 * output rather than propagating, because a rejected `app:info` blanks the very
 * page this function exists to keep readable — but it answers empty output *and
 * says that it threw* (`probeError`), so the folding is a decision recorded in
 * the answer instead of a `.catch()` that quietly made `exec` and a silent CLI
 * look the same.
 */
const VERSION_PROBE_MS = 5000;
const VERSION_PROBE_GRACE_MS = 500;

// The one shape every probe answer has: three fields the caller may act on, plus
// the internal `probeError` diagnostic (see `versionAnswer`). Built in one place
// so "the answer's key set does not depend on how the wait ended" is true by
// construction — `main.js` spreads the whole answer into `formatAppInfo`.
const saidNothing = (timedOut) => ({
  versionStdout: "",
  versionStderr: "",
  timedOut,
  probeError: null,
});

// A rejection is a *fact about the service*, not the same fact as "the CLI
// printed nothing": an `exec` that threw may be a programming error here, a
// spawn that failed, or a service whose contract changed. Both answers are still
// empty output — a rejected `app:info` blanks the settings page — so the
// difference is carried in a field instead of being lost in the `.catch`. Kept
// as a sentence (never `undefined`) so "there was an exception" is not confused
// with "there was not one".
const PROBE_ERROR_FALLBACK = "exec rejected without a message";

const describeProbeError = (error) => {
  // An Error (or anything carrying a `message`) is read from that field first;
  // every other value is stringified. A rejected plain object stringifies to
  // `"[object Object]"`, which is a value but not a diagnostic — it names
  // nothing the reader can look up, so it gets the same sentence as an empty
  // message. The rule is "there is always a sentence, and it is either what
  // was thrown or the fact that nothing usable was": `undefined` and `""` are
  // the only strings that must not come out of here.
  //
  // `"message" in error` walks the prototype chain, and that is the decision,
  // not an oversight. An `Error` subclass may expose `message` through a getter
  // on its prototype, and that message is as real as an own property —
  // `Object.prototype.hasOwnProperty.call(error, "message")` would answer "no
  // message" for a legitimate error and hide the one line that says what broke.
  // The price is that an inherited `message` from anywhere in the chain is read
  // too; `probeError` never reaches the payload (`formatAppInfo` names and drops
  // it), so a wrong-but-present sentence costs a worse log line, while dropping
  // a real one costs whoever debugs the next `app:info` an hour.
  // `tools/app-info-smoke.mjs` pins both halves: `Object.create({ message })`
  // yields that message, and a plain `Error` still yields its own.
  //
  // The outermost edge of that chain is `Object.create(null)`: it has no
  // `toString`, so `String(it)` *throws* — and this function runs inside a
  // `.catch`, so a throw here rejects `app:info` and blanks the very page this
  // file exists to keep readable. Hence the guard: a value that cannot be turned
  // into a sentence is answered with the fixed sentence, same as one that said
  // nothing usable. The middle edge is a `message` getter that throws: the `in`
  // test succeeds, reading the property throws, and the same `try` turns that
  // into the fixed sentence instead of a rejected settings page. All three edges
  // are asserted in `tools/app-info-smoke.mjs`, because a `catch` that answers
  // "" is indistinguishable from one that answers a sentence unless someone
  // asks. The no-prototype edge is asked from both ends in that suite: the
  // answer itself (`readVersionOutput`), and the path the app really runs
  // (`handleAppInfo`, where the payload must stay complete *and* the injected
  // sink must receive the fixed sentence — an empty string there is a log line
  // about a failure that says nothing about it).
  const text = (() => {
    try {
      return error && typeof error === "object" && "message" in error
        ? String(error.message || "")
        : String(error == null ? "" : error);
    } catch {
      return "";
    }
  })();
  return text && text !== "[object Object]" ? text : PROBE_ERROR_FALLBACK;
};

/* ---- the one decision the probe ends with ----
 *
 * Two facts end the probe: what the CLI said, and whether we were still
 * waiting when it said it. `late` is the second one — "we stopped waiting" —
 * and it wins even when an answer is there: a service that ignored its budget
 * has no chance to set the flag itself, and a version that arrives after the
 * page asked is not a version this handler can use. `!answer` is the other
 * half: the deadline won the race, so there is nothing to report at all.
 *
 * The decision is a function of its own because the interesting shape cannot
 * be produced through `readVersionOutput`: `Promise.race` settles with
 * whichever promise settles first, and the deadline reaches the race in one
 * microtask hop while the probe's answer needs several (exec → map → catch →
 * race), so whenever the deadline has fired it has already won that race and
 * `answer` is `null` — "late *and* an answer" is unreachable from the outside
 * (measured, not assumed: `tools/app-info-smoke.mjs` pins the reachable shapes
 * and this one is asserted here instead).
 *
 * So the guard is asserted on the decision itself: `tools/app-info-smoke.mjs`
 * calls it with an answer that is there and `late` set, and requires the
 * answer to be dropped.
 */
const versionAnswer = (answer, late) => {
  if (late || !answer) return saidNothing(true);
  return {
    versionStdout: answer.stdout,
    versionStderr: answer.stderr,
    timedOut: answer.timedOut === true,
    // `probeError` is *not* part of the payload: it exists so "we folded an
    // exception into silence" is a recorded decision rather than an unnamed
    // extra key, and `formatAppInfo` names and drops it. A deadline that won the
    // race is not an exception, so it stays `null` there.
    probeError:
      typeof answer.probeError === "string" && answer.probeError ? answer.probeError : null,
  };
};

/* ---- what the probe is allowed to wait, asked on its own ----
 *
 * Both budgets above arrive as arguments and neither is trusted: they come from
 * a caller (and, in the app's case, from a default) and `setTimeout` reads a
 * bad one in a way nobody wants. Two rules make an untrusted value usable:
 *
 *  - the budget handed to the child is the value if it is a positive finite
 *    number, otherwise the default. Zero, a negative number, `NaN` and
 *    `Infinity` are all "the caller did not say", not "wait no time" and not
 *    "wait forever" — `setTimeout(Infinity)` fires immediately in Node, so
 *    `Infinity` slipping through would be the shortest possible wait while
 *    reading as the longest;
 *  - the grace is added only when it is finite and non-negative, otherwise the
 *    default is used. A negative grace must not be subtracted: the outer
 *    deadline would then fire *inside* the child's own budget, which is the one
 *    ordering the two budgets exist to keep (`wait >= budget`).
 *
 * It is a function of its own because the interesting shapes are the invalid
 * ones: `readVersionOutput` has to *wait* for the deadline it computes, so
 * asserting "a negative grace still waits the default" on the clock would take
 * 5.5 seconds. Asked here, the answer is a number, and
 * `tools/app-info-smoke.mjs` checks every invalid input against the same
 * invariant instead of timing four of them.
 */
const versionWaitMs = ({ timeoutMs, graceMs } = {}) => {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : VERSION_PROBE_MS;
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : VERSION_PROBE_GRACE_MS;
  // Never less than the budget the child was given: answering "timed out" while
  // the child is still inside its own budget would report a failure that has not
  // happened yet. True by construction above; the check is the assertion that
  // the two lines above stay that way.
  //
  // The answer is the two numbers the probe *waits with*, and no third. `grace`
  // stays a local: it is an addend, not something any caller acts on, and a
  // `grace` field on the answer would be one only this file's own tests could
  // read — the shape `app-info.js` spent round 71/72 removing from the payload.
  // "The grace fell back to the default" is asked as `wait - budget` instead,
  // which is the quantity that actually reaches `setTimeout`, and
  // `readVersionOutput` destructures exactly `{ budget, wait }`, so the object
  // has no consumer for a third field either way.
  return { budget, wait: budget + grace };
};

async function readVersionOutput({
  binary,
  exec,
  timeoutMs = VERSION_PROBE_MS,
  graceMs = VERSION_PROBE_GRACE_MS,
} = {}) {
  const binaryPath = binary && binary.path ? binary.path : null;
  // No binary, no question: asking one that is not there is how a stale version
  // ends up attached to "not found". The same goes for an `exec` that is not a
  // function: the deadline would answer `timedOut` for a service nobody could
  // call, which reads as "the CLI is slow" instead of "this side is miswired".
  if (!binaryPath || typeof exec !== "function") return saidNothing(false);
  const { budget, wait } = versionWaitMs({ timeoutMs, graceMs });
  let late = false;
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve(null);
    }, wait);
  });
  const probe = Promise.resolve()
    .then(() => exec(["version"], { timeoutMs: budget }))
    .then((res) =>
      res && typeof res === "object"
        ? { stdout: res.stdout || "", stderr: res.stderr || "", timedOut: res.timedOut === true }
        : { stdout: "", stderr: "", timedOut: false }
    )
    // Same shape as the mapped success: the race below reads `stdout`/`stderr`
    // off whichever settled first, so a rejection that answered in the *other*
    // shape would surface as `undefined` output rather than as silence. The
    // exception is *not* dropped on the way: `probeError` carries its message, so
    // "the service threw" and "the service said nothing" stay tellable apart in
    // the answer while both still read as `version: ""` in the payload.
    .catch((error) => ({
      stdout: "",
      stderr: "",
      timedOut: false,
      probeError: describeProbeError(error),
    }));
  const answer = await Promise.race([probe, deadline]);
  clearTimeout(timer);
  // `late` wins even when both settled in the same tick: a service that ignores
  // its budget has no chance to set `timedOut` itself, and "we stopped waiting"
  // is what the caller needs to know. The decision itself lives in
  // `versionAnswer`, where it can be asked the question the race cannot
  // produce (an answer that is there *and* a deadline that has fired).
  return versionAnswer(answer, late);
}

/* ---- the handler's whole body, so the wiring can be called ----
 *
 * `main.js` used to hold this assembly inside the `app:info` registration, so
 * the only way to ask "does the probe's whole answer reach `formatAppInfo`, or
 * does the handler pick two fields off it?" was to read the source or launch
 * Electron. That choice is a decision — `probeError` and `timedOut` exist on the
 * answer so this side can name them and drop them — and a decision should be
 * callable, not read out of a regex.
 *
 * `assembleAppInfo` is the one line where the spread happens. It is separate
 * from `handleAppInfo` because the interesting regression lives *here*
 * (`...probe` rewritten as `versionStdout: probe.versionStdout, …`), and a probe
 * whose diagnostic fields are getters makes "were they read at all?" observable
 * from the outside (`tools/app-info-smoke.mjs` asks exactly that).
 */
const assembleAppInfo = ({
  binary,
  probe = {},
  configPath = "",
  docsUrl = "",
  appVersion = "",
  platform = "",
  installInfo = {},
} = {}) =>
  formatAppInfo({
    binary,
    ...probe,
    configPath,
    docsUrl,
    appVersion,
    platform,
    installInfo,
  });

// The body of `app:info`. `exec` keeps the service's four-argument signature
// (`args, cwd, env, options`); the adapter to the probe's `(args, { timeoutMs })`
// is made here rather than in the registration, so the one piece of wiring that
// used to be untestable is covered by the same call. `binaryResolution` and
// `installInfo` stay functions because the handler answered from the state at
// ask time, not at registration time.
//
// `onProbeError` is where the probe's dropped diagnostic goes instead of
// nowhere (see the three-place list above). It is called at most once, with the
// sentence `describeProbeError` produced, and only when `exec` actually threw —
// a timeout or a silent CLI is an answer, not an exception. The call is guarded
// because the sink is injected and a throwing one would reject `app:info`,
// which is the blank settings page this module exists to prevent.
//
// The install facts are read *after* the probe rather than before it: the
// answer describes the app at the moment it is handed over, and the probe is the
// only part of it that can take seconds. Reading them first would answer with a
// snapshot taken before the wait.
const handleAppInfo = async ({
  exec,
  binaryResolution,
  configPath = "",
  docsUrl = "",
  appVersion = "",
  platform = "",
  installInfo = {},
  onProbeError = () => {},
} = {}) => {
  const binary = typeof binaryResolution === "function" ? binaryResolution() : null;
  const probe = await readVersionOutput({
    binary,
    exec:
      typeof exec === "function"
        ? (args, options) => exec(args, undefined, undefined, options)
        : null,
  });
  if (probe.probeError) {
    try {
      onProbeError(probe.probeError);
    } catch {
      // A log line that throws is still only a log line.
    }
  }
  return assembleAppInfo({
    binary,
    probe,
    configPath,
    docsUrl,
    appVersion,
    platform,
    installInfo: typeof installInfo === "function" ? installInfo() : installInfo || {},
  });
};

module.exports = {
  formatAppInfo,
  assembleAppInfo,
  handleAppInfo,
  readVersionOutput,
  versionAnswer,
  versionWaitMs,
  VERSION_PROBE_MS,
  VERSION_PROBE_GRACE_MS,
};
