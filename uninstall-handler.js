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
// process is started on this platform), `quit`, and `schedule`/`quitDelayMs`.
// The last two are what make "the reply arrives before the quit" checkable
// without waiting 400ms in a test.

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
  const warn = opts.warn;
  const quitDelayMs = Number.isFinite(opts.quitDelayMs) ? opts.quitDelayMs : UNINSTALL_QUIT_DELAY_MS;

  return async function uninstall() {
    const plan = install.uninstallPlan();
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
    schedule(() => quit(), quitDelayMs);
    return { ok: true };
  };
}

module.exports = { makeUninstallHandler, UNINSTALL_QUIT_DELAY_MS };
