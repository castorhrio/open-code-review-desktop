// SPDX-License-Identifier: Apache-2.0
"use strict";

// The uninstall answer, and the order it is made of.
//
// `app:uninstall` is the one IPC channel whose success means this process is
// about to stop existing. Three things have to happen, in this order:
//
//   1. the truncation evidence is flushed. The uninstaller deletes the profile
//      directory, and `before-quit` fires *after* the uninstaller has started —
//      by then the directory it would write to is being removed. So the flush
//      cannot be left to the quit; it has to happen here, first.
//   2. the uninstaller is spawned, detached: it outlives this process by design,
//      because it deletes the directory this process runs from and Windows keeps
//      those files locked until the app is gone.
//   3. the reply and the quit. The settings page switches to 「正在卸载…」 from the
//      *reply*, so a quit in the same tick tore the window down before the answer
//      could be drawn — the user saw a window vanish and no confirmation.
//
// That order used to live in `main.js` as eleven lines of an `ipcMain.handle`
// body, i.e. it was a property of how one file happened to be written. The
// failure it guards is not visible from the outside either: an uninstall that
// spawned nothing and answered nothing looks, from the log, like an uninstall
// nobody asked for. So the body lives here, where a check can call it with
// doubles — `tools/uninstall-flush.mjs` — and `main.js` keeps only the wiring,
// the same split `run-handler.js` and `config-handler.js` already use.
//
// What the caller supplies, and why each is a parameter rather than an import:
// `install` (the uninstall plan, which decides whether there is anything to
// spawn at all), `store` (the evidence to flush), `spawn` (how a detached
// process is started on this platform), `quit`, `warn` (where a sentence about a
// step that went wrong is written — `main.js` points it at the renderer's log
// drawer, because a packaged app has no terminal to read `console.warn` from),
// and `schedule`/`quitDelayMs`. The last two are what make "the reply arrives
// before the quit" checkable without waiting 400ms in a test. The defaults for
// the two collaborators `main.js` leaves out — a real `setTimeout` and a no-op
// `quit` — are themselves exercised by `tools/uninstall-flush.mjs`, with each
// one omitted rather than replaced by a double.

const { flushAndReport } = require("./run-diagnostics");

/**
 * How long the reply is given to reach the renderer before this process quits.
 *
 * A delay, not a wait on the uninstaller: that process is spawned detached and
 * `unref`ed, so it outlives this one by design and quitting first is the whole
 * point. What the delay buys is the page that asked for the uninstall getting
 * its answer — it switches to 「正在卸载…」 from the reply, and a quit in the same
 * tick tears the window down before it can. Named rather than inline so the
 * reason travels with the value, and spelled in exactly one place: a second copy
 * in `main.js` would be the one that drifts.
 *
 * 400ms is best-effort, not a guarantee that the reply has already been drawn:
 * the reply is on its way when this handler resolves, and the delay only gives
 * it a head start. Nothing here waits for the page to confirm, because by this
 * point the window is about to be closed by the same server that would answer
 * such a confirmation.
 */
const UNINSTALL_QUIT_DELAY_MS = 400;

/**
 * The `app:uninstall` handler.
 *
 * Answers `{ ok: true }` when the uninstaller was started, and the plan's own
 * `{ ok: false, error }` when there was nothing to start (a portable build has
 * no uninstaller, and the sentence says what to do instead). In that case
 * nothing is flushed, nothing is spawned and no quit is scheduled: the app has
 * to stay usable, because the user's next move is reading that sentence.
 *
 * The flush is the one step whose failure must not cancel the others. It arrives
 * as a *value* (`flushAndReport` answers `drain-failed` / `timeout` /
 * `max-rounds` instead of rejecting), it is logged before the uninstaller starts
 * — the last moment the loss can be reported at all — and the uninstall goes
 * ahead regardless: the evidence is worth a line, not the whole action.
 *
 * A spawn that throws is the opposite case: nothing was started, so the quit is
 * *not* scheduled and the failure is answered instead. Quitting there would leave
 * the app gone, the uninstaller never run, and no page left to say so.
 *
 * The plan itself can throw, and that is the one failure that used to escape:
 * `uninstallPlan()` reads the filesystem to find the install root, and `main.js`
 * hands this handler straight to `ipcMain.handle` — so a throw there became a
 * rejected `invoke` in the renderer, where the settings page's `catch` has
 * nothing to show but a guess of its own. The failure is folded into the same
 * `{ ok: false, error }` shape the plan's own refusals use, and nothing is
 * flushed, spawned or scheduled: there is nothing to act on, and the app has to
 * stay usable to read the sentence.
 */
function makeUninstallHandler(options) {
  const opts = options || {};
  const install = opts.install;
  const store = opts.store;
  const spawnUninstaller = opts.spawn;
  const quit = typeof opts.quit === "function" ? opts.quit : () => {};
  const schedule = typeof opts.schedule === "function" ? opts.schedule : (fn, ms) => setTimeout(fn, ms);
  // `flushAndReport`, not `flushNow`: see above — the failure has to arrive as a
  // value, and the line it writes has to go out before the uninstaller starts.
  const flush = typeof opts.flush === "function" ? opts.flush : flushAndReport;
  const warn = typeof opts.warn === "function" ? opts.warn : defaultWarn;
  const quitDelayMs = Number.isFinite(opts.quitDelayMs) ? opts.quitDelayMs : UNINSTALL_QUIT_DELAY_MS;

  /**
   * A quit that failed, as a line.
   *
   * The uninstaller has already been started when this is reached, so the user's
   * action is done and the app failing to close is a nuisance, not a lost
   * uninstall. It is still said out loud: if `app.quit()` did not take, the
   * window stays open showing 「正在卸载…」 forever, and the only thing that turns
   * that into an explanation is this sentence arriving in the log drawer.
   *
   * `warn` is called inside its own try/catch for the same reason
   * `run-diagnostics`' `reportOutcome` does: a sink that throws would become the
   * uncaught exception this wrapper exists to prevent, one call later.
   */
  const logQuitFailure = (err) => {
    const reason = (err && err.message) || (typeof err === "string" ? err : "");
    const line = reason ? `[uninstall] 退出失败：${reason}` : "[uninstall] 退出失败";
    try {
      warn(`${line}（卸载程序已经启动，可以直接结束本程序）`);
    } catch (_) {
      // No second sink left to tell.
    }
  };

  /**
   * The quit, and what is left of a quit that went wrong.
   *
   * This is scheduled, so it runs in a timer where nothing above it can catch a
   * throw: a throwing `quit` would become an uncaught exception in the main
   * process — a crash at the exact moment the user expected the app to close,
   * after the uninstaller started. And a `quit` wired to an async teardown
   * answers a promise that nobody awaits, whose rejection surfaces as an
   * unhandled rejection instead. Both are the same news, so both become the same
   * line, and neither can undo the uninstall.
   */
  const quitAfterReply = () => {
    try {
      const answer = quit();
      if (answer && typeof answer.then === "function") {
        answer.then(undefined, (err) => logQuitFailure(err));
      }
    } catch (err) {
      logQuitFailure(err);
    }
  };

  return async function uninstall() {
    // The plan decides whether there is anything to spawn at all, so it runs
    // before everything else — including before the flush, which is only worth
    // doing if an uninstaller is about to start.
    let plan;
    try {
      plan = install.uninstallPlan();
    } catch (err) {
      return { ok: false, error: planFailure(err) };
    }
    // A plan that answers nothing is the same news as one that threw: nothing
    // can be spawned and the page must not be handed a rejection.
    if (!plan) return { ok: false, error: planFailure() };
    if (!plan.ok) return plan;
    await flush(store, warn);
    try {
      spawnUninstaller(plan.target);
    } catch (err) {
      const reason = (err && err.message) || String(err || "");
      return { ok: false, error: reason ? `启动卸载程序失败：${reason}` : "启动卸载程序失败" };
    }
    // Scheduled, never called inline: the reply this function is about to return
    // has to be on its way to the renderer first.
    schedule(quitAfterReply, quitDelayMs);
    return { ok: true };
  };
}

/**
 * The sink when the caller supplies none.
 *
 * `console.warn` is the fallback, not the rule: a packaged Windows app has no
 * terminal, so `main.js` passes the renderer's own log channel instead. The
 * throw is swallowed because a console that is gone must not be able to break
 * the uninstall either.
 */
function defaultWarn(line) {
  try {
    console.warn(line);
  } catch (_) {}
}

/**
 * The sentence for a plan that could not be read at all.
 *
 * The platform's own words are appended rather than replaced: `ELOOP` and
 * `EACCES` send the user to two different places, and the page has nothing else
 * to show. The prefix is this file's, because the handler is the one that knows
 * the failure happened while *reading* the plan.
 */
function planFailure(err) {
  const reason = (err && err.message) || (typeof err === "string" ? err : "");
  return reason ? `读取卸载信息失败：${reason}` : "读取卸载信息失败";
}

module.exports = { makeUninstallHandler, UNINSTALL_QUIT_DELAY_MS };
