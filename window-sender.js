// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * The one door main-process events leave by, and what happens when the window
 * cannot take them yet.
 *
 * `send()` used to be `if (mainWindow && !mainWindow.isDestroyed())
 * mainWindow.webContents.send(…)` — a guard that reads like a safety check but
 * is really a silent drop. `updater.init()` runs before `createWindow()`, so an
 * update state computed at launch went nowhere; a `run:log` line produced while
 * the renderer was still loading, or while the window was being recreated after
 * a close, vanished the same way. Those are precisely the lines this app has no
 * second reader for: a packaged app has no terminal, which is why `probeError`
 * and the uninstall warnings were moved onto `run:log` in the first place. An
 * exit that is quiet exactly when the window is not up yet is not an exit.
 *
 * So a payload sent before a receiver exists is *held*, in order, and flushed
 * the moment the renderer says it is loaded. The queue is bounded, because an
 * unbounded one turns "the renderer never loads" into a memory leak; when the
 * bound is crossed the oldest lines go, and the count comes back out of
 * `markReady()` so the loss is *reported* instead of becoming the quiet version
 * of the failure this module exists to remove.
 *
 * Readiness is the renderer's own `did-finish-load`, not "a window object
 * exists": the window is constructed long before its page has run, and a send
 * into that gap is lost in exactly the same way. It is a flag rather than a
 * question asked of `webContents` because "has the page loaded" is not a
 * property Electron exposes.
 *
 * The window is asked for by a getter rather than handed in: the app creates,
 * closes and recreates it while this object lives, so a captured reference
 * would be the destroyed one.
 *
 * One case is deliberately not solved: if the page never finishes loading at
 * all (`main.js` stops retrying after 40 attempts), `markReady()` is never
 * called and the queue simply fills to `limit`, dropping the rest. That is the
 * accepted trade — with no renderer there is nobody to read a log line, and
 * adding a second channel for launch-time events would bring back the terminal
 * this app does not have. The bound still matters: if any window does load
 * later, the loss comes back through `markReady()` as a count rather than as a
 * silent gap.
 */
const DEFAULT_PENDING_LIMIT = 200;

/**
 * @param {object} options
 * @param {() => object|null} options.currentWindow  the window to send to, or null
 * @param {number} [options.limit]                   how many held lines survive
 *                                                   a renderer that never loads
 */
const createWindowSender = (options) => {
  const opts = options || {};
  const currentWindow = opts.currentWindow;
  if (typeof currentWindow !== "function") {
    throw new TypeError("createWindowSender 需要一个 currentWindow() 取窗口");
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_PENDING_LIMIT;

  let ready = false;
  const held = [];
  let dropped = 0;

  const deliver = (channel, payload) => {
    if (!ready) return false;
    const win = currentWindow();
    if (!win) return false;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
    const contents = win.webContents;
    if (!contents || typeof contents.send !== "function") return false;
    try {
      contents.send(channel, payload);
    } catch (_) {
      // The window can be torn down between the check above and the send. That
      // is the same answer as "no receiver": hold the payload for the next
      // window instead of throwing out of whatever caller produced it.
      return false;
    }
    return true;
  };

  const flush = () => {
    // In order, and only as far as the receiver takes them. A line that cannot
    // go out now must never be overtaken by the next one — a run's log would
    // read out of order after a reload, which is worse than a line that is late.
    while (held.length > 0) {
      const [channel, payload] = held[0];
      if (!deliver(channel, payload)) return false;
      held.shift();
    }
    return true;
  };

  const hold = (channel, payload) => {
    held.push([channel, payload]);
    // Oldest first: the newest lines are the ones a reader can still act on
    // (the run that just ended, the update that just arrived).
    while (held.length > limit) {
      held.shift();
      dropped += 1;
    }
  };

  /** Sends now if it can, holds the line if it cannot. Answers whether it went
   *  out immediately; the answer is for tests and diagnostics, not for callers
   *  to branch on. */
  const send = (channel, payload) => {
    // An older line still waiting means the receiver did not take it a moment
    // ago. Flushing first is what keeps the order; if that fails, this line
    // queues behind the others rather than jumping the queue. While unready
    // `flush()` answers false on its first line without touching the window, so
    // this branch is the ordinary queueing path, not a retry that might deliver.
    if (held.length > 0 && !flush()) {
      hold(channel, payload);
      return false;
    }
    if (deliver(channel, payload)) return true;
    hold(channel, payload);
    return false;
  };

  /** The renderer is loaded: flush what was held, and say what the bound cost.
   *
   *  `sent` is how many lines *this call* got out — not the queue's lifetime
   *  total and not how many were queued when the page started loading. A flush
   *  can be interrupted (the receiver throws on the n-th line, the window is
   *  torn down mid-loop), and the rest stays held; the next `markReady()` — a
   *  reload, or the same page recovering — answers with those. So two answers
   *  add up to the queue, and neither answer on its own describes it.
   *
   *  `lost` is how many lines the bound dropped since the previous ready, and
   *  it is cleared on the way out: a loss is reported once, by the ready that
   *  follows it, not on every later ready. A line refused by an interrupted
   *  flush is *not* lost — it is still queued. */
  const markReady = () => {
    ready = true;
    const before = held.length;
    flush();
    const sent = before - held.length;
    const lost = dropped;
    dropped = 0;
    return { sent, lost };
  };

  /** A fresh window is being created; its page has not loaded yet. Held lines
   *  stay held — a reload must not cost the log of the run that was in flight. */
  const markUnready = () => {
    ready = false;
  };

  return { send, markReady, markUnready, pending: () => held.length, limit };
};

module.exports = { createWindowSender, DEFAULT_PENDING_LIMIT };
