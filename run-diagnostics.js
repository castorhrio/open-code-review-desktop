// SPDX-License-Identifier: Apache-2.0
"use strict";

// Facts about a finished run that the CLI does not persist.
//
// A run can end with `review_limit_reached` — a declared limit (tool-request
// rounds or the token budget) spent the main loop's last round — and still be
// written to the session as a complete file review. The warning exists only in
// that run's JSON stdout: upstream stores no warnings in the session stream, so
// `ocr session list --json` and `session comments` cannot answer for it. Reopen
// the session and the app has no way to repeat what the live result said.
//
// The token-budget case is recoverable from the manifest (items swept to
// failed(budget)), and loadSession derives it. The round limit is not, so the
// few fields needed to keep that promise are kept here, next to the app's own
// state instead of inside the CLI's config directory.
//
// Only the warning type and file are stored: never messages, provider payloads,
// endpoints or keys. The file is capped and every failure is best-effort — a
// diagnostic must never be able to break a run or a session load.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const VERSION = 1;
const MAX_ENTRIES = 200;
const LIMIT_WARNING = "review_limit_reached";

/**
 * How long any one wait around a write may take.
 *
 * The store's file lives in the profile directory, which can be a network
 * mount. Three waits touch it — the run-exit path waiting for the evidence,
 * the quit waiting for the queue, and a read waiting for a write that is still
 * in flight — and they used to spell the bound out separately, so changing it
 * for one of them could leave the others behind. One constant for all three.
 */
const WRITE_TIMEOUT_MS = 2000;

/**
 * `record()` / `remove()` answer with an outcome instead of a bare boolean.
 *
 * - `clean`      nothing needed writing (a run with no evidence, or a delete
 *                that found nothing) — success, and silent
 * - `written`    the evidence landed where a reopened session will look
 * - `no-session` there was evidence but no session id to file it under
 * - `io-error`   there was something to write and the disk refused it
 * - `timeout`    the caller stopped waiting (see `recordBounded`); the write
 *                itself is still queued and may yet land
 *
 * The two failures used to share one `false`, so `main.js` could only warn
 * about both or neither. They are not the same news: an `io-error` means the
 * truncation warning is gone after a restart *and nobody chose that*, which is
 * worth a line in the log; `no-session` is a known shape and warning about it
 * every run is noise.
 *
 * `no-session` is *not* "a scan run". `ocr scan` publishes a session id like
 * every other mode — `cmd/opencodereview/scan_cmd.go` prints
 * `[ocr] Session: <id> (retry with: --resume <id>)` on stderr and puts
 * `session_id` in its JSON (`MODES.scan.resumeSupported` in `ocr-service.js` is
 * `true` for the same reason). So it means what it says: the CLI answered with
 * truncation evidence but no session id at all — the shape upstream produces
 * when there is nothing to resume from. There is then no session to reopen, so
 * no warning can be lost, and this store has nothing to file the evidence under.
 */
const OK_WITHOUT_WRITING = { ok: true, reason: "clean" };
const OK_WRITTEN = { ok: true, reason: "written" };
const NO_SESSION = { ok: false, reason: "no-session" };
const IO_ERROR = { ok: false, reason: "io-error" };

/**
 * The end-of-run signal itself failed.
 *
 * `main.js` answers `run:exit` with `send()`, which throws when the window is
 * already gone — the exact shape of "the app is closing while a run ends". The
 * run is over either way, so the signal failing must not undo the record (which
 * is on disk) nor keep the outcome from the caller; but it also must not pass in
 * silence, because the screen may still be showing the run as live. It gets a
 * word here so the log can say it rather than nothing.
 */
const SIGNAL_FAILED = { ok: false, reason: "signal-failed" };

/**
 * How the two waits ended, in the same shape as a record outcome.
 *
 * `drain()` used to return nothing and stop silently after its round limit: a
 * queue that never settled looked exactly like an empty one, so the app quit —
 * or started the uninstaller — while a write was still pending, and nothing in
 * the log said the truncation evidence might be gone. The three answers below
 * are what the caller can act on (or at least log).
 */
const DRAINED = { ok: true, reason: "drained" };
const MAX_ROUNDS = { ok: false, reason: "max-rounds" };
const TIMEOUT = { ok: false, reason: "timeout" };
const DRAIN_FAILED = { ok: false, reason: "drain-failed" };

/**
 * What a caller should say about an outcome, or `""` when there is nothing to
 * say.
 *
 * The wording lives here rather than in `main.js` for two reasons: the exits
 * (`before-quit`, uninstall) and the end of a run all report through the same
 * vocabulary, and a check can assert the message without starting Electron.
 * `clean` / `written` / `drained` are silent on purpose — a healthy run must not
 * log a line, or the one that matters gets skimmed past.
 *
 * `late` is the outcome of a write that finished *after* the caller was told
 * `timeout`: the run-exit path has already moved on, so the only useful thing
 * left is to say that the evidence did (or did not) end up on disk.
 */
const OUTCOME_MESSAGES = {
  "io-error": "本次运行的上限证据保存失败，重开会话后将看不到这条提示",
  timeout: "上限证据写得太慢，运行结束没有等它；写盘仍在继续",
  "max-rounds": "上限证据的写队列在退出前始终没停，可能仍有写入没落盘",
  "drain-failed": "上限证据的退出冲刷出错，可能仍有写入没落盘",
  // Not a store outcome: the run ended, the evidence is on disk, but the screen
  // was never told. Wording ends on 「运行」 so the log drawer keeps it — the
  // renderer self-opens on a line that reads like trouble, and a session that
  // stays "running" forever is exactly that.
  "signal-failed": "本次运行已经结束，但结束信号没能送达界面，界面可能仍显示运行中",
};
const LATE_OUTCOME_MESSAGES = {
  "io-error": "上限证据在运行结束后写盘失败，重开会话后将看不到这条提示",
  timeout: "上限证据最后仍然没写完；重开会话后可能看不到这条提示",
  "max-rounds": "上限证据的写队列始终没停，可能仍有写入没落盘",
  "drain-failed": "上限证据在运行结束后冲刷出错，可能仍有写入没落盘",
};

function outcomeMessage(outcome, options) {
  const reason = outcome && outcome.reason;
  if (!reason) return "";
  const table = options && options.late ? LATE_OUTCOME_MESSAGES : OUTCOME_MESSAGES;
  return table[reason] || "";
}

/**
 * Log one outcome, once. Returns the line it logged (or `""`).
 *
 * `main.js` calls this for every path that learns something about the evidence
 * — the end of a run, a late write that only finished after the bound, the exit
 * flush, the uninstall flush — so no path can quietly drop the news while
 * another one warns about it.
 */
function reportOutcome(outcome, warn, options) {
  const message = outcomeMessage(outcome, options);
  if (!message) return "";
  const line = `[run-diagnostics] ${message}`;
  (typeof warn === "function" ? warn : console.warn)(line);
  return line;
}

/**
 * Whether a path on this platform compares case-insensitively.
 *
 * Windows always does. macOS does too by default — APFS and HFS+ are
 * case-insensitive out of the box — so the same folder arrives there with a
 * different casing too, and a byte-comparison key lost the truncation evidence
 * on exactly the platform the app ships on.
 *
 * The exception is a macOS volume that was formatted case-sensitive, where two
 * folders differing only in case really are two folders. There the key merges
 * them, which is the safer of the two mistakes: a shared key needs the same
 * session id under both folders, while a byte key loses the evidence of every
 * run on a normal volume.
 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

/**
 * The same repository, however the caller spelled it.
 *
 * The renderer sends the folder the user picked, and that spelling is not
 * stable: the picker hands back `/repo/` with a trailing separator, the CLI
 * echoes `/repo`, a spec built from a nested path carries `..`, and on Windows
 * and macOS the same folder can arrive with different casing. Keys used to be
 * the raw string, so a run recorded under one spelling was invisible under
 * another — and the entry it lost is the truncation evidence a reopened session
 * exists to keep. Resolving (and lower-casing where paths compare
 * case-insensitively) makes the key about the folder rather than the typing.
 *
 * Reading normalises as well, so entries written by an earlier build — which
 * stored the raw string — still answer for any spelling of the same folder.
 *
 * `options.caseInsensitive` overrides the platform's answer, because the
 * case-sensitivity of a filesystem is a property of the volume and not of the
 * OS: a macOS volume can be formatted case-sensitive, and a Linux one can be
 * mounted case-insensitively. It is also the only way to check the macOS
 * behaviour from a machine that is not a Mac. The store passes its own
 * options straight through, so a store can be told the truth about the volume
 * it lives on instead of guessing it from the OS.
 */
function normalizeRepo(repo, options = {}) {
  const raw = String(repo || "");
  if (!raw) return "";
  let abs;
  try {
    abs = path.resolve(raw);
  } catch (_) {
    return raw;
  }
  const caseInsensitive = "caseInsensitive" in options ? Boolean(options.caseInsensitive) : CASE_INSENSITIVE_PATHS;
  return caseInsensitive ? abs.toLowerCase() : abs;
}

/**
 * How many times the drain is willing to see the queue move on.
 *
 * A write can queue another one (a record landing while the window closes, or a
 * remove racing it), so the wait repeats — but a queue that *keeps* re-arming
 * would hold the exit (and the uninstaller) for as long as it kept going. The
 * round limit is the bound; reaching it is a fact the caller has to hear about,
 * not a silent stop.
 */
const MAX_DRAIN_ROUNDS = 100;

/**
 * Wait for a queue to stop moving, or give up and say why.
 *
 * `current()` returns the promise standing for "everything queued so far"; the
 * same promise twice in a row means nothing new was queued while we waited, so
 * the queue has settled. Going through a getter instead of a promise keeps this
 * testable: a queue that never settles is hard to produce on a real disk and
 * trivial to describe here.
 *
 * A rejected write is not a reason to stop — both a record and a remove still
 * have to happen — so the tail is awaited with its failure swallowed (the write
 * reports its own outcome through `record()` / `remove()` instead).
 */
async function drainQueue(current, maxRounds = MAX_DRAIN_ROUNDS) {
  for (let i = 0; i < maxRounds; i++) {
    const tail = current();
    try {
      await tail;
    } catch (_) {}
    if (tail === current()) return DRAINED;
  }
  return MAX_ROUNDS;
}

/**
 * The evidence store for one profile directory.
 *
 * `options` is the volume's answer about case, passed straight to
 * `normalizeRepo`. The store keys every entry by the folder it belongs to, so
 * a volume that folds case and a volume that does not are two different
 * worlds — and the store has to read, write and delete the same way in each.
 * Leaving it out keeps the platform's answer, which is what the app uses; the
 * seam exists because the platform's answer is a guess (a macOS volume can be
 * formatted case-sensitive, a Linux one can be mounted case-insensitively),
 * and because it is the only way to check the macOS behaviour from a machine
 * that is not a Mac — the same reason `normalizeRepo` takes the option.
 *
 * The delete follows the key exactly, so a session id that exists under two
 * folders is two entries and deleting one does not touch the other. On a
 * volume that folds case this still holds: two spellings of one folder are
 * one folder there, so one delete removing that entry is the answer rather
 * than a loss. The dangerous shape would be a delete that matched on the
 * session id alone — the session id is not unique across repositories.
 */
function createStore(file, options = {}) {
  const key = (repo, sessionId) => `${normalizeRepo(repo, options)}\u0000${sessionId || ""}`;

  /**
   * One write at a time, in the order the caller asked for it.
   *
   * Every write here is a whole-file read-modify-write, so two overlapping ones
   * lose an entry: both read the same list, both append their own, and whichever
   * rename lands second silently drops the other. That is exactly the evidence
   * the store exists to protect — two runs finishing close together (one per
   * window, or one recording while another is deleted) is a normal shape, not a
   * corner case.
   *
   * `then(fn, fn)` runs the task whether or not its predecessor settled, because
   * both a record and a remove have to happen; the chain is re-armed on failure
   * so one unexpected throw cannot poison every later write.
   */
  let queue = Promise.resolve();
  function serialize(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || raw.version !== VERSION || !Array.isArray(raw.entries)) return [];
      return raw.entries.filter((e) => e && typeof e.session_id === "string" && e.session_id);
    } catch (_) {
      return [];
    }
  }

  /**
   * Write the whole file, and say whether it landed.
   *
   * Every failure here is deliberately swallowed — a diagnostic must never be
   * able to break a run — but swallowing it *and* reporting nothing is how the
   * store's promise breaks quietly: a full disk or a read-only profile writes
   * no evidence, the app says nothing, and the reopened session looks clean
   * again. So the outcome is returned rather than assumed, and the caller
   * (`main.js`) is the one deciding what to do about it.
   */
  async function writeAll(entries) {
    const data = JSON.stringify({ version: VERSION, entries });
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      // Async on purpose: this file lives in the profile directory, which can be
      // a network mount, and a synchronous write there freezes the whole main
      // process — including every window — for as long as the disk takes. It
      // also gives the queue above something to actually serialise: the
      // read-modify-write now straddles a real suspension point, so two
      // unsequenced records would both read the same list and the second rename
      // would drop the first one's entry.
      await fsp.writeFile(tmp, data, "utf8");
      try {
        await fsp.rename(tmp, file);
      } catch (_) {
        // Windows refuses to rename over an existing file; writing in place is
        // still better than losing the record.
        await fsp.writeFile(file, data, "utf8");
        try {
          await fsp.unlink(tmp);
        } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Record only when the run has truncation evidence; clean runs are not kept.
   *
   * Returns a promise of `{ ok, reason }` (see the vocabulary at the top of this
   * file). The promise settles after the write, so a caller that needs to know
   * before the renderer can ask for the session's diagnostics can await it.
   */
  function record(repo, sessionId, result) {
    return serialize(async () => {
      if (!result || typeof result !== "object") return OK_WITHOUT_WRITING;
      const warnings = Array.isArray(result.warnings)
        ? result.warnings
            .filter((w) => w && w.type === LIMIT_WARNING)
            .map((w) => ({ type: LIMIT_WARNING, ...(w.file ? { file: String(w.file) } : {}) }))
        : [];
      const budget = Boolean(result.summary && result.summary.budget_exceeded);
      if (!warnings.length && !budget) return OK_WITHOUT_WRITING;
      if (!sessionId) return NO_SESSION;

      const entries = readAll().filter((e) => key(e.repo, e.session_id) !== key(repo, sessionId));
      // Stored canonical, so the file does not accumulate one entry per spelling.
      entries.push({ repo: normalizeRepo(repo), session_id: sessionId, warnings, budget_exceeded: budget });
      // Insertion order is the age order; keeping the tail drops the oldest and
      // keeps the newest, without a timestamp that can tie inside one millisecond.
      return (await writeAll(entries.slice(-MAX_ENTRIES))) ? OK_WRITTEN : IO_ERROR;
    });
  }

  function read(repo, sessionId) {
    if (!sessionId) return null;
    const found = readAll().find((e) => key(e.repo, e.session_id) === key(repo, sessionId));
    if (!found) return null;
    // Re-normalise on the way out: the renderer's contract is type + file, even
    // if an older build (or a hand-edited file) left more behind.
    const warnings = (Array.isArray(found.warnings) ? found.warnings : [])
      .filter((w) => w && w.type === LIMIT_WARNING)
      .map((w) => ({ type: LIMIT_WARNING, ...(w.file ? { file: String(w.file) } : {}) }));
    return { warnings, budget_exceeded: Boolean(found.budget_exceeded) };
  }

  /**
   * Wait until the queued writes are on disk.
   *
   * The store writes asynchronously, so a caller that is about to exit needs a
   * way to hold the exit until the file is actually there: Electron does not
   * wait for pending promises when the main process exits, and the evidence
   * that write carries is the whole reason this store exists. Without the
   * wait, closing the app right after a truncated run leaves the reopened
   * session looking clean again.
   *
   * A write can be queued while an earlier one is still landing — a run
   * finishes exactly as the window closes — so the wait repeats until the queue
   * stops moving. See `drainQueue` for what happens at the round limit.
   */
  function drain() {
    return drainQueue(() => queue);
  }

  /**
   * Read the evidence, but not before the writes still in flight have landed.
   *
   * `read()` is a plain file read, and the run-exit path only waits a bounded
   * time for the evidence to be written — the profile directory can be a
   * network mount, and a slow disk must not hold the UI. So a session reopened
   * right after a run that hit that bound could be read while its own evidence
   * was still being written, and a truncated session would look clean again.
   * That is the one outcome this whole store exists to prevent, and it was
   * still reachable through the timeout path.
   *
   * Waiting for the queue to settle first closes that window. The queue is
   * empty almost always, so the wait costs a microtask; when it is not empty,
   * the wait is exactly what makes the answer true. The wait is bounded like
   * every other one here — if the disk never answers, the read answers with
   * whatever is on disk rather than hanging.
   */
  function readSettled(repo, sessionId, timeoutMs = WRITE_TIMEOUT_MS) {
    if (!sessionId) return Promise.resolve(null);
    return drainBounded(() => drain(), timeoutMs).then(() => read(repo, sessionId));
  }

  /** Queued like `record`, so a delete cannot race a write for the same file. */
  function remove(repo, sessionId) {
    return serialize(async () => {
      if (!sessionId) return NO_SESSION;
      const entries = readAll();
      const kept = entries.filter((e) => key(e.repo, e.session_id) !== key(repo, sessionId));
      if (kept.length === entries.length) return OK_WITHOUT_WRITING;
      return (await writeAll(kept)) ? OK_WRITTEN : IO_ERROR;
    });
  }

  return { record, read, readSettled, remove, drain };
}

/**
 * Wait for a promise of an outcome, but not forever.
 *
 * `current()` returns the promise standing for "the writes queued so far have
 * landed"; the answer may be a real outcome (`drained`, `max-rounds`) or a
 * failure. The clock is what keeps a caller off a disk that never answers —
 * and both callers that need it (the quit flush and the read that waits for a
 * pending write) used to spell this race out on their own, so the bound was
 * easy to change in one place and forget in the other.
 */
function drainBounded(current, timeoutMs = WRITE_TIMEOUT_MS) {
  let timer;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  const drained = Promise.resolve()
    .then(() => current())
    .then((outcome) => (outcome && typeof outcome.ok === "boolean" ? outcome : DRAINED))
    .catch(() => DRAIN_FAILED);
  return Promise.race([drained, giveUp]).then((outcome) => {
    clearTimeout(timer);
    return outcome;
  });
}

/**
 * Wait for the queued writes, but not forever.
 *
 * The profile directory can be a network mount, and an app that cannot be
 * closed is worse than an app that lost one warning — so the wait is bounded,
 * and the caller decides what a timeout means for it.
 */
function flushNow(store, timeoutMs = WRITE_TIMEOUT_MS) {
  return drainBounded(() => store.drain(), timeoutMs);
}

/**
 * Record, but never hold the caller longer than `timeoutMs`.
 *
 * `record()` settles after the write, which is what the run-exit path wants: the
 * renderer refreshes the session as soon as it hears `run:exit`, and a record
 * that has not landed yet would make a truncated session look clean again.
 * The wait has to have an upper bound, though — the file lives in the profile
 * directory, which can be a network mount, and an unbounded wait there means the
 * app's own "the run is over" signal arrives whenever the disk gets around to
 * it. So past the bound the caller is told `timeout` and carries on; the write
 * stays queued, and a quit still waits for it (`flushBeforeQuit`).
 */
function recordBounded(store, repo, sessionId, result, timeoutMs = WRITE_TIMEOUT_MS, onLate) {
  let timer;
  let timedOut = false;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(TIMEOUT);
    }, timeoutMs);
  });
  const write = Promise.resolve()
    .then(() => store.record(repo, sessionId, result))
    .catch(() => IO_ERROR)
    .then((outcome) => {
      // The caller was already told `timeout` and has moved on. The write is
      // still the only thing that knows whether the truncation evidence exists,
      // so its real outcome goes to `onLate` — once, and only when the bound was
      // actually hit. Letting it land in the void is how a full disk stays
      // invisible: the run-exit path had already stopped listening.
      if (timedOut && typeof onLate === "function") {
        try {
          onLate(outcome);
        } catch (_) {}
      }
      return outcome;
    });
  return Promise.race([write, giveUp]).then((outcome) => {
    clearTimeout(timer);
    return outcome;
  });
}

/**
 * Record the evidence, then say that the run is over — in that order.
 *
 * The renderer refreshes the history as soon as it hears `run:exit`, and a
 * record that has not landed yet would make a truncated session look clean
 * again. That ordering used to live in a comment in `main.js` beside a promise
 * chain, where nothing would have caught someone moving the `send()` up.
 * Here it is the shape of the function: the signal is called after the record
 * settled, and it is handed the outcome, so the caller does not have to
 * re-derive whether the evidence is on disk.
 *
 * The wait is bounded (`recordBounded`) — a slow disk must not hold the UI —
 * and past the bound the outcome says so, instead of the exit pretending that
 * everything is in order.
 *
 * Both halves of the promise survive their own failure: reporting the outcome
 * throwing still sends the signal (or the screen never comes back), and the
 * signal throwing still leaves the evidence on disk and is logged (or a run that
 * ended looks live forever). See `SIGNAL_FAILED`.
 */
async function settleRunExit(options) {
  const opts = options || {};
  let outcome = null;
  try {
    outcome = await recordBounded(
      opts.store,
      opts.repo,
      opts.sessionId,
      opts.result,
      opts.timeoutMs,
      opts.onLate
    );
    reportOutcome(outcome, opts.warn);
  } catch (_) {
    // Reporting the outcome failed, but the run still ended. The exit signal is
    // what hands the screen back, so it goes out either way — the old promise
    // chain said so with a `finally`, and a run that ends without an exit is a
    // spinner that never stops.
  }
  if (typeof opts.signal !== "function") return outcome;
  try {
    opts.signal(outcome);
  } catch (_) {
    // The signal is the last thing that happens for this run, so a throw here
    // used to be the one path `settleRunExit` left uncovered: `main.js` answers
    // the signal with `send("run:exit")`, which throws when the window is
    // already gone, and the rejected promise was swallowed by a `.catch(() => {})`
    // — a run that ended, evidence on disk, and not a word about the screen that
    // never heard. Say it instead. Report must not throw either: the run is over
    // whether or not the news can be delivered.
    try {
      reportOutcome(SIGNAL_FAILED, opts.warn);
    } catch (_) {}
  }
  return outcome;
}

/**
 * Keep the app from exiting before the evidence is on disk.
 *
 * Electron does not wait for pending promises when the main process exits, so
 * a write that is still in flight when the user closes the window is simply
 * gone — and the reopened session looks clean again, which is the one thing
 * this store exists to prevent. So the quit is held back until the store says
 * it is done.
 *
 * The second pass is the real quit: `flushing` says the first one already took
 * the event, so the retry is allowed to proceed.
 *
 * Exported so the behaviour can be exercised inside a real Electron process
 * instead of only being reasoned about.
 */
function flushBeforeQuit(app, store, timeoutMs = WRITE_TIMEOUT_MS, warn) {
  let flushing = false;
  app.on("before-quit", (event) => {
    if (flushing) return;
    event.preventDefault();
    flushing = true;
    // A quit that gives up on the evidence says so before it quits: after the
    // process is gone there is nobody left to tell, and a silent stop is the
    // failure this whole file exists to prevent.
    flushNow(store, timeoutMs).then((outcome) => {
      reportOutcome(outcome, warn);
      app.quit();
    });
  });
}

module.exports = {
  createStore,
  normalizeRepo,
  CASE_INSENSITIVE_PATHS,
  MAX_ENTRIES,
  LIMIT_WARNING,
  WRITE_TIMEOUT_MS,
  MAX_DRAIN_ROUNDS,
  drainQueue,
  drainBounded,
  outcomeMessage,
  reportOutcome,
  recordBounded,
  settleRunExit,
  SIGNAL_FAILED,
  flushNow,
  flushBeforeQuit,
};
