// The two judgements the end-to-end flow makes about the screen, kept out of
// `e2e-flow.cjs` so they can be exercised without Electron.
//
// The bug these exist for was one sentence doing two jobs. A wait that times out
// and a screen that does not contain the awaited text both used to reach the
// report as "a.go never showed up", so "the CLI is slow / the spec never arrived"
// and "the renderer built the wrong spec" sent the reader to the same place. The
// marker (`__timeout`) is what lets `screenAfter` tell them apart; the reason
// this module exists is that the decision itself had no test, and it is exactly
// the decision that decided whether a red line was read correctly.
//
// `screenAfter` takes the wait and a *reader*, not a BrowserWindow: the Electron
// plumbing stays in `e2e-flow.cjs`, while the three-way answer — resolved,
// timed-out, failed-for-another-reason — is a value a smoke test can pin.
//
// Known approximation, deliberately kept: the screen is read *after* the wait
// ended, so it is a second look rather than the last frame the wait saw. If the
// renderer changes between those two moments, the quoted screen is "what was
// there just after the deadline", not "what the wait kept failing to match".
// That is acceptable for a failure report (it still shows the form when the CLI
// never answered) and it is written down here so nobody later reads the screen
// as evidence of the exact timeout instant.
"use strict";

// The marker travels on the error itself. A separate return value would have to
// be threaded through every `waitFor` caller; an own property survives the
// `catch` at each call site and cannot be confused with the message text (a CLI
// that happens to print "timed out" must not turn into a timeout verdict).
const timeoutError = (message) => Object.assign(new Error(message), { __timeout: true });

/**
 * The screen a wait was watching, plus *why* the wait ended.
 *
 * `timeoutMs` is echoed rather than inferred so the sentence can name the budget
 * the run actually used. A reader that throws or rejects answers `""` — the
 * report then says nothing about the screen instead of losing the whole check to
 * a second failure.
 */
async function screenAfter(waiting, readScreen, { timeoutMs }) {
  try {
    const screen = await waiting;
    return { screen, timedOut: false, timeoutMs };
  } catch (error) {
    let screen = "";
    try {
      screen = await readScreen();
    } catch {
      /* the screen is evidence, not a requirement: a dead window still reports the wait */
    }
    return { screen, timedOut: Boolean(error && error.__timeout), timeoutMs, error };
  }
}

// One sentence for every check that would otherwise pass on an empty screen.
// "did not appear" is the honest wording: the text was never seen, so the
// assertion was not judged either way. That is different from a screen that
// appeared and said the wrong thing, which each check words itself.
const neverAppeared = (what, timeoutMs) =>
  `${what} did not appear within ${timeoutMs}ms, so this was not judged`;

module.exports = { timeoutError, screenAfter, neverAppeared };
