// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * The `review:run` handler: one run, one exit.
 *
 * This lived inside `main.js`, which meant the only thing a check could say
 * about it was what its source text looked like (`tools/run-diagnostics-smoke.mjs`
 * matched `const exit = createRunExitDoor(send)` with a regex). That is a
 * description of a spelling, not of a behaviour: wrapping the door in a helper,
 * renaming the constant, or making one door per *settle* would all have kept the
 * regex happy while telling the renderer the run ended twice.
 *
 * So the body is a function with its collaborators handed in. `main.js` only
 * registers it, and a check can start a run with a stub `ocr`, answer `onDone`
 * twice, and count the exit signals that actually went out — the behaviour the
 * "one run, one door" promise is about.
 *
 * Everything defaults to the real `run-diagnostics` functions, so the app runs
 * the same code either way; the overrides exist so the door and the settle can
 * be swapped for spies without a second implementation of this wiring.
 */
const diagnostics = require("./run-diagnostics");

/**
 * Make the handler for one IPC channel registration.
 *
 * @param {object} options
 * @param {object} options.ocr       the CLI service (`startRun` is all this uses)
 * @param {Function} options.send    main-process sender: (channel, payload) => void
 * @param {object} options.store     the run-diagnostics store
 * @param {Function} [options.createRunExitDoor]
 * @param {Function} [options.settleRunExit]
 * @param {Function} [options.outcomeMessage]
 * @param {Function} [options.reportOutcome]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.warn]  where the last-resort report goes (default: console.warn)
 * @param {object} [options.settleFailedOutcome] the outcome to report when the settle rejects
 */
function makeRunHandler(options) {
  const opts = options || {};
  const ocr = opts.ocr;
  const send = opts.send;
  const store = opts.store;
  const createRunExitDoor = opts.createRunExitDoor || diagnostics.createRunExitDoor;
  const settleRunExit = opts.settleRunExit || diagnostics.settleRunExit;
  const outcomeMessage = opts.outcomeMessage || diagnostics.outcomeMessage;
  const reportOutcome = opts.reportOutcome || diagnostics.reportOutcome;
  const timeoutMs = opts.timeoutMs == null ? diagnostics.WRITE_TIMEOUT_MS : opts.timeoutMs;
  // Only the last-resort reports below use it; the per-outcome ones ride along
  // with `settleRunExit` (`onLate`) or with the exit payload, which is where the
  // wording has to come from anyway.
  const warn = typeof opts.warn === "function" ? opts.warn : undefined;
  const SETTLE_FAILED = opts.settleFailedOutcome || diagnostics.SETTLE_FAILED;

  return function runReview(spec) {
    // One run, one exit. The door is made here — inside the handler that starts
    // this run — and handed to `settleRunExit`, which is still the only thing
    // that can open it (the opening symbol is private to run-diagnostics) and
    // the only thing that sends. Being per run rather than per call is what
    // makes the door's "says so once" guard real: a second settle for this run
    // meets a door that has already spoken, and stays quiet instead of telling
    // the renderer the run ended twice. This file still cannot name the channel.
    const exit = createRunExitDoor(send);
    return ocr.startRun(
      spec,
      (id, line) => send("run:log", { id, line }),
      (id, result) => {
        // The CLI does not persist warnings, so this is the only moment the
        // round-limit signal exists. Record before the exit event reaches the
        // renderer, which may refresh history immediately: the write is queued
        // and asynchronous (one whole-file read-modify-write at a time), so the
        // exit signal waits for it — otherwise the renderer could read
        // `session:diagnostics` and find nothing simply because the rename had
        // not landed yet.
        //
        // That wait is bounded (`recordBounded`, the same 2s the exit flush
        // uses): the store's file lives in the profile directory, which can be a
        // network mount, and an unbounded wait there would hold the exit signal
        // — and every spinner that ends on it — for as long as the disk took.
        // Past the bound the renderer is told the run is over and the write
        // stays queued, so it still lands (and a quit still waits for it).
        //
        // A lost `io-error` is real news, and so is a rotation: the write
        // landed, but it pushed the oldest records out of the capped file, and
        // those sessions will reopen looking clean. Both are worded by
        // `reportOutcome` from the same tables, so settling is all this file
        // has to do for either. `no-session` is a known shape —
        // the CLI answered with truncation evidence but printed no session id
        // at all (it is not a scan run: `ocr scan` publishes a session id like
        // every other mode) — so there is no session to reopen, the warning
        // cannot be lost, and warning about it every time would train the reader
        // to ignore the line that matters. An
        // `io-error` means the *reopened* session will look clean again even
        // though this one was truncated, and nothing in the UI can show that.
        // A `timeout` is not a loss: the write stays queued and the read of the
        // session waits for it (`readSettled`), so the reopened session still
        // shows the truncation — it is only this run's exit that did not wait.
        //
        // A write that only finishes *after* the bound reports through `onLate`:
        // by then the exit signal has been sent, so the only place left for the
        // news is this log. Without it, a full disk under a slow profile
        // directory (the two usually arrive together) loses the evidence and
        // says nothing.
        //
        // `settleRunExit` owns the order — the record first, the exit signal
        // after — because the renderer refreshes the history the moment it hears
        // the exit, and a record that has not landed yet would make a
        // truncated session look clean again. It owns the *channel* too: this
        // file does not name it, so the exit cannot be sent from anywhere else —
        // the one door is opened by `settleRunExit` itself, after the record
        // landed. The outcome rides along with the signal so the app can say out
        // loud when the evidence did not make it to disk; the wording comes from
        // the same place as the log line below, so there is only one version of
        // it.
        settleRunExit({
          store,
          repo: spec.repo,
          sessionId: result.sessionId || (result.value && result.value.session_id) || "",
          result: result.value || null,
          timeoutMs,
          onLate: (late) => reportOutcome(late, undefined, { late: true }),
          exit,
          send,
          payload: (outcome) => ({
            id,
            result,
            diagnostics: { ...outcome, message: outcomeMessage(outcome) },
          }),
        }).catch((err) => {
          // `settleRunExit` is written not to reject: it catches the record's
          // failure, the report's failure, and a throwing signal (that one is
          // `signal-failed`). So a rejection here is "the end of the run did not
          // happen at all", and it used to be answered with `.catch(() => {})`
          // — a rejected promise declared handled, and the one thing this
          // promise is for (the renderer hearing the run ended) gone with no
          // line anywhere. A spinner that never stops leaves nothing to read
          // afterwards, so say it.
          //
          // The outcome goes through `reportOutcome` like every other one, so
          // this failure is worded and routed from the same place as the rest
          // (`settle-failed`), and it is the loud kind: the drawer opens itself.
          // The raw error is logged too, on its own line: the outcome line says
          // the screen may not have heard, not what broke, and without it a
          // rejected settle is undebuggable. Neither report may throw — this is
          // already the last resort, and a throw here would hand the runtime a
          // rejection nobody is left to handle.
          const log = warn || console.warn;
          const say = (fn) => {
            try {
              fn();
            } catch (_) {}
          };
          say(() => reportOutcome(SETTLE_FAILED, warn));
          say(() =>
            log(
              `[run-diagnostics] ${spec && spec.runId ? `${spec.runId}: ` : ""}settle 抛出的原始错误: ${(err && err.message) || err}`
            )
          );
        });
      },
      (id, progress) => send("run:progress", { id, progress })
    );
  };
}

module.exports = { makeRunHandler };
