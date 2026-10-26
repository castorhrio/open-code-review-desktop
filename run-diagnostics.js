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
/**
 * How many records the file keeps — across *all* repositories, not per folder.
 *
 * One file, one cap: fifty repositories still keep at most this many runs'
 * worth of truncation evidence between them, because the whole file is read and
 * rewritten on every recorded run. `record` trims on each write, keeping the
 * newest and dropping the oldest (`entries.slice(-MAX_ENTRIES)`, insertion
 * order being the age order), so the trim happens at *write* time and in file
 * order rather than by any timestamp that could tie inside one millisecond.
 *
 * A trimmed session reopens as `null` — the same answer a clean run gives. That
 * is the price of the cap and it is deliberate: the alternative is an unbounded
 * file in the profile directory that grows forever. What must not happen is the
 * trim looking like a *loss* the app could have reported; it is a rotation, and
 * the newest records are exactly the ones a user is likely to reopen.
 */
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
 * The settle did not finish at all.
 *
 * `settleRunExit` is written so it does not reject: the record's failure is
 * caught, the report's failure is caught, and a throwing signal is caught and
 * reported as `signal-failed`. So a rejection here means something *outside*
 * that promise broke — a store that is not a store, a `payload` builder that
 * throws before the door gets its word, an injected collaborator that was wired
 * wrong — and it used to be answered with `.catch(() => {})` in the handler.
 * A `.catch` that returns nothing is a rejected promise declared handled: the
 * one thing the promise exists for (the renderer hearing that the run ended)
 * could go missing with no line anywhere, and a spinner that never stops leaves
 * no trace to read afterwards.
 *
 * It gets its own reason rather than reusing `signal-failed`: that one means
 * "the evidence is on disk, only the push failed", which is a different (and
 * milder) story than "the end of the run was not carried out".
 */
const SETTLE_FAILED = { ok: false, reason: "settle-failed" };

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
};
/**
 * The wording for one failure that is *not* about the evidence at all.
 *
 * `signal-failed` is the run that ended with its evidence safely on disk and no
 * one told the screen. It used to sit in `OUTCOME_MESSAGES` beside `io-error`
 * and `timeout`, which are all facts about the file on disk, so asking
 * `outcomeMessage` about the store answered with a sentence about a push — and
 * the next store outcome added there would have inherited that confusion. It
 * has its own name now: `outcomeMessage` answers `""` for it (it is not a store
 * outcome) and `reportOutcome` routes it here instead.
 *
 * The wording still has to read like trouble: the drawer self-opens on a line
 * matching `TROUBLE_LINE` in `src/lib/format.ts` (error / warning / 失败 /
 * 无法 / ✗), and this line used to end on 「运行中」, which the rule does not
 * match — so the one line saying the screen never heard the run ended stayed
 * behind a closed drawer. A failed *signal* is a failure, so it says so.
 * `tools/run-diagnostics-smoke.mjs` reads that rule out of the renderer and
 * asserts this line against it.
 */
const SIGNAL_FAILED_MESSAGE = "本次运行已经结束，但结束信号推送失败，界面可能仍显示运行中";
const signalFailedMessage = () => SIGNAL_FAILED_MESSAGE;
/**
 * The wording for the settle that never finished.
 *
 * 「可能」 is deliberate: the settle can reject before or after the door spoke,
 * so a line claiming the screen definitely never heard would be wrong half the
 * time, and the log is the only place left to be accurate. It still has to read
 * like trouble (`TROUBLE_LINE` in `src/lib/format.ts`), or the one line about a
 * run whose exit may be lost stays behind a closed drawer.
 */
const SETTLE_FAILED_MESSAGE = "本次运行收尾失败，退出信号可能没有发出，界面可能仍显示运行中";
const settleFailedMessage = () => SETTLE_FAILED_MESSAGE;
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
 * The message to log for *any* outcome, store or not.
 *
 * `outcomeMessage` speaks only for the store; the one non-store outcome the app
 * reports (`signal-failed`) is answered by `signalFailedMessage`. Keeping the
 * two answers apart here is what lets a caller ask "did the evidence make it"
 * and "did the screen hear it" without one answer standing in for the other.
 */
function outcomeLogMessage(outcome, options) {
  const store = outcomeMessage(outcome, options);
  if (store) return store;
  if (outcome && outcome.reason === SIGNAL_FAILED.reason) return signalFailedMessage();
  if (outcome && outcome.reason === SETTLE_FAILED.reason) return settleFailedMessage();
  return "";
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
  const message = outcomeLogMessage(outcome, options);
  if (!message) return "";
  const line = `[run-diagnostics] ${message}`;
  (typeof warn === "function" ? warn : console.warn)(line);
  return line;
}

/**
 * The *platform's* answer — the fallback, not the rule.
 *
 * The rule is the *volume's* answer, asked per repository by
 * `detectCaseInsensitive` (wired in `createAppStore`). Case-sensitivity is a
 * property of the volume, not of the OS: a macOS volume can be formatted
 * case-sensitive, and a Linux one can be mounted case-insensitively, so the
 * platform alone is a guess that is wrong in both directions.
 *
 * This constant is what the store falls back to when there is no explicit
 * answer and the volume could not be asked (`null`: nothing to compare, the
 * path is gone, or the volume reports no `dev`/`ino` identity). The fallback
 * says Windows and macOS fold case and everyone else keeps it — always right
 * on Windows, right on a default macOS volume, wrong on a case-sensitive one.
 * Wrong-but-folding is the safer of the two mistakes *there*: a merged key
 * needs the same session id under both spellings before anything is lost,
 * while a byte key loses the truncation evidence of every run on a normal
 * volume.
 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

/**
 * The other spelling of a name.
 *
 * Every ASCII letter is flipped, so the result differs from the original in
 * more than one place: a volume that folded only *some* of the letters would
 * still not answer to it.
 */
const flipCase = (name) =>
  String(name || "").replace(/[A-Za-z]/g, (ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()));

/**
 * How many segments the probe may walk up looking for a name with letters.
 *
 * Small on purpose: the segment to spell twice is the deepest one that carries
 * letters, which is one level up for a date-shaped path and never more than a
 * few in practice. The bound only exists so a path of pure digits/symbols
 * cannot walk to the filesystem root and ask a really different question.
 */
const MAX_LETTER_WALK = 8;

/**
 * Whether the parent directory's own names settle the case question.
 *
 * Only one listing is evidence that the volume keeps case: an entry spelled
 * exactly as the name that resolved, and no entry spelled exactly the other
 * way. `readdir` returns the names as they are stored, so a folding volume
 * holding `Payments-API` lists that even when the caller spelled it
 * `payments-api` — the exact spelling is then missing and this returns `null`,
 * because the listing cannot tell "folds case" from "kept, under another
 * spelling". The comparison is deliberately exact and not case-folded: folding
 * it here would make every listing match `other` (the two spellings differ only
 * in case) and the probe could never answer `false` again.
 *
 * Two exact entries — the spelled one and the other — cannot happen on the path
 * this runs on, because `stat` on the other spelling succeeded there and the
 * dev/ino comparison already answered. Should it happen anyway, the answer
 * stays `null` rather than a guess. A directory that cannot be listed is
 * likewise "cannot tell".
 */
function keepsCaseByListing(dir, spelled, other, readdir) {
  let listing;
  try {
    listing = Array.from(readdir(dir), (name) => String(name));
  } catch (_) {
    return null;
  }
  const spelledThere = listing.includes(spelled);
  const otherThere = listing.includes(other);
  return spelledThere && !otherThere ? false : null;
}

/**
 * Whether the volume holding `target` folds case.
 *
 * The answer belongs to the volume, not to the OS: a macOS volume can be
 * formatted case-sensitive, and a Linux one can be mounted case-insensitively.
 * The platform's default is a guess, and it is wrong in both directions — so
 * the volume is asked instead.
 *
 * The question is asked *of the path itself*, and nothing is written: the
 * deepest segment that carries letters is spelled a second way, and the two
 * spellings are compared by identity. The same file → the volume folds case.
 * A second entry under the other spelling → two different folders, so the
 * volume keeps case. `ENOENT` on the other spelling → *maybe* the volume keeps
 * case, so the parent directory is read once (`keepsCaseByListing`) and the
 * answer is `false` only when its own names settle it. An unresolved spelling
 * alone is not evidence: a folding volume answers `ENOENT` for a name that was
 * simply never there, and calling that "keeps case" would split one folder into
 * two keys on the volume that folds.
 *
 * Nothing is written, deliberately. The path usually belongs to the user's own
 * repository, and a probe file left behind in someone's working tree is worse
 * than a wrong answer. (The profile directory is not asked: the store's key is
 * about the *repository* path, so the profile volume's answer would be the
 * answer to a different question.)
 *
 * A path that cannot be read at all answers `null` — "cannot tell" — and the
 * caller falls back to the platform's answer.
 */

function detectCaseInsensitive(target, options = {}) {
  const stat = options.stat || fs.statSync;
  const raw = String(target || "");
  if (!raw) return null;
  let abs;
  try {
    abs = path.resolve(raw);
  } catch (_) {
    return null;
  }
  // The segment to spell twice: the deepest one that carries letters. A folder
  // called `2024` has none, so the walk goes up to its parent — a date-shaped
  // path like `/repo/2024/10/26` still gets an answer instead of "why is this
  // folder case-sensitive on macOS".
  //
  // The walk is bounded by MAX_LETTER_WALK for one reason: the deepest segment
  // that carries letters is normally one or two levels up, and a path made
  // only of digits and symbols (`/2024/10/26/...`, a timestamped build dir)
  // must not be walked to `/`. Past the bound the answer is "cannot tell"
  // (`null`), which falls back to the platform's answer — an honest guess,
  // not a wrong answer about a volume nobody asked.
  let dir = path.dirname(abs);
  let base = path.basename(abs);
  let spelled = abs;
  for (let depth = 0; depth < MAX_LETTER_WALK && !/[A-Za-z]/.test(base); depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    base = path.basename(dir);
    spelled = dir;
  }
  if (!/[A-Za-z]/.test(base)) return null;
  const other = flipCase(base);
  if (other === base) return null;

  let here;
  let there;
  try {
    here = stat(spelled);
  } catch (_) {
    // The path is not there (a repository that was deleted, a spelling that
    // never existed): there is nothing to compare, so there is no answer.
    return null;
  }
  try {
    there = stat(path.join(dir, other));
  } catch (err) {
    // "The other spelling does not resolve" is *not* the same fact as "the
    // volume keeps case". On a case-folding volume it also means "there is no
    // such name at all", because the segment being doubled can be one that was
    // never there (a path typed wrong, a repository moved, a date-shaped leaf).
    // Answering `false` there would hand the store a wrong certainty, let
    // `resolveCaseInsensitive` skip the platform's fallback, and split one
    // folder into two keys on the exact volume that folds case — which is the
    // loss this probe exists to prevent.
    //
    // So `ENOENT` is evidence about the *volume* only after the parent
    // directory has been read: the spelled name listed, and no entry answering
    // to the other spelling. Everything else — an error that is not `ENOENT`,
    // an unreadable directory, an entry in the other spelling — is "cannot
    // tell" (`null`), which falls back to the platform's answer.
    if (!err || err.code !== "ENOENT") return null;
    return keepsCaseByListing(dir, base, other, options.readdir || fs.readdirSync);
  }
  // Both spellings exist. They are one folder only if they are one file: two
  // entries whose names differ in case are two folders on a volume that keeps
  // case, and the answer there is "keeps case".
  if (!here || !there || !here.ino || !there.ino) return null;
  if (here.dev !== there.dev || here.ino !== there.ino) return false;
  return true;
}

/**
 * A detector that asks each path once.
 *
 * The store keys every entry by folder, so a file with a hundred entries would
 * otherwise ask the volume a hundred times for the same answer — and the
 * repository under review is often on a network mount, where a hundred round
 * trips for one read is a hundred round trips too many.
 */
function createCaseDetector(options = {}) {
  const cache = new Map();
  return (target) => {
    let abs;
    try {
      abs = path.resolve(String(target || ""));
    } catch (_) {
      return null;
    }
    if (!cache.has(abs)) cache.set(abs, detectCaseInsensitive(abs, options));
    return cache.get(abs);
  };
}

/**
 * The answer the store keys by.
 *
 * Three sources, in order: an explicit answer, the volume's own answer, and
 * the platform's answer. A volume that cannot tell (`null`) falls through to
 * the platform's answer instead of being read as "case-sensitive" — the
 * platform's answer is right on Windows and on a default macOS volume, and a
 * volume that could not be asked is no reason to second-guess it. (Read the
 * other way round, a probe that could not answer would *lose* the evidence of
 * every run on a case-folding volume, which is the one thing this store
 * exists to prevent.)
 *
 * `options.platformCaseInsensitive` is the platform's answer, injectable so
 * the rule can be checked from a platform whose default is the other way —
 * otherwise the check would only ever be meaningful on one of them.
 */
function resolveCaseInsensitive(abs, options = {}) {
  if (options && typeof options.caseInsensitive === "boolean") return options.caseInsensitive;
  if (options && typeof options.detect === "function") {
    const answer = options.detect(abs);
    if (answer === true || answer === false) return answer;
  }
  if (options && typeof options.platformCaseInsensitive === "boolean") return options.platformCaseInsensitive;
  return CASE_INSENSITIVE_PATHS;
}

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
 * `options.caseInsensitive` overrides the platform's answer, and
 * `options.detect` asks the volume instead — because the case-sensitivity of a
 * filesystem is a property of the volume and not of the OS: a macOS volume can
 * be formatted case-sensitive, and a Linux one can be mounted
 * case-insensitively. The explicit override is also the only way to check the
 * macOS behaviour from a machine that is not a Mac. The store passes its own
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
  const caseInsensitive = resolveCaseInsensitive(abs, options);
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
 * The bound is `MAX_DRAIN_ROUNDS` rounds, not a clock: a queue that keeps
 * re-arming cannot hold the exit forever, and reaching the limit returns
 * `MAX_ROUNDS` as a fact for the caller to report instead of throwing. What
 * this does *not* do is cancel the writes — they are still queued, and a quit
 * still waits for them (`flushBeforeQuit`).
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
 * The store the app uses.
 *
 * The app's store keys every entry by the folder it belongs to, so it has to
 * know whether the volume folds case — and that answer is asked of the volume,
 * per repository, instead of being guessed from the OS. Building it here rather
 * than in `main.js` keeps that wiring in one place a check can reach, which is
 * the whole point: the app used to build the store with the platform's answer
 * and nothing noticed.
 *
 * `options.detect` replaces the volume probe, which is how the behaviour can
 * be checked from a machine whose volume happens to answer the other way.
 *
 * `main.js` builds this at module load, before Electron is ready, so it must
 * stay I/O-free: the constructor only closes over the path, the JSON file is
 * first touched by a read or a write, and the volume probe is lazy (run once
 * per repository, on first use, then cached). Startup therefore never blocks
 * on the store — not on a slow disk, not on a network mount — and the order in
 * which `main.js` runs relative to `app.whenReady()` cannot matter.
 */
function createAppStore(file, options = {}) {
  const detect = options.detect || createCaseDetector(options);
  return createStore(file, { ...options, detect });
}

/**
 * The evidence store for one profile directory.
 *
 * `options` carries the volume's answer about case and is passed straight to
 * `normalizeRepo`: `options.caseInsensitive` is an explicit answer, and
 * `options.detect` is asked about each repository's own path. The store keys
 * every entry by the folder it belongs to, so a volume that folds case and a
 * volume that does not are two different worlds — and the store has to read,
 * write and delete the same way in each. Leaving both out keeps the
 * platform's answer, which is what the app used to do; the seam exists because
 * the platform's answer is a guess (a macOS volume can be formatted
 * case-sensitive, a Linux one can be mounted case-insensitively), and because
 * it is the only way to check the macOS behaviour from a machine that is not a
 * Mac — the same reason `normalizeRepo` takes the option.
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
   * The key the *earlier* build used: the platform's answer rather than the
   * volume's. Kept for the upgrade window only, not as a second rule.
   *
   * Where the two answers agree this is the same key and nothing changes.
   * Where they do not — a macOS volume formatted case-sensitive — the earlier
   * build lower-cased the folder and this one keeps its case, so the old
   * entry would become invisible and the session it belongs to would look
   * clean again. The platform's answer is the earlier build's answer, so it is
   * the one to look under as well.
   *
   * Exit condition: the first build that files entries under the volume's
   * answer is the one after 0.1.13 (every earlier build filed them under the
   * platform's). Delete `legacyKey`/`keysFor`'s second key — and the
   * `legacy === exact` branch with it — once installs older than that build
   * are no longer supported, i.e. once the in-app updater has had one release
   * cycle to move them across. Until then this costs one extra read per
   * lookup and is the only thing that keeps an old entry visible.
   */
  const legacyOptions = { platformCaseInsensitive: options.platformCaseInsensitive };
  const legacyKey = (repo, sessionId) => `${normalizeRepo(repo, legacyOptions)}\u0000${sessionId || ""}`;

  /**
   * The keys an entry may be filed under.
   *
   * The volume's answer is the one entries are written with; the earlier
   * build's answer is the one some of them were written with, and both are
   * looked for. An entry written by this build is only ever filed under the
   * first, so the second cannot answer for a different folder.
   */
  function keysFor(repo, sessionId) {
    const exact = key(repo, sessionId);
    const legacy = legacyKey(repo, sessionId);
    return legacy === exact ? [exact] : [exact, legacy];
  }

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

      const wanted = keysFor(repo, sessionId);
      const entries = readAll().filter((e) => !wanted.includes(key(e.repo, e.session_id)));
      // Stored canonical, so the file does not accumulate one entry per
      // spelling — and canonical *in this store's terms*: the same answer the
      // key uses, so a volume that folds case stores one spelling of a folder
      // rather than one per way of typing it.
      entries.push({ repo: normalizeRepo(repo, options), session_id: sessionId, warnings, budget_exceeded: budget });
      // Insertion order is the age order; keeping the tail drops the oldest and
      // keeps the newest, without a timestamp that can tie inside one millisecond.
      return (await writeAll(entries.slice(-MAX_ENTRIES))) ? OK_WRITTEN : IO_ERROR;
    });
  }

  function read(repo, sessionId) {
    if (!sessionId) return null;
    const wanted = keysFor(repo, sessionId);
    const found = readAll().find((e) => wanted.includes(key(e.repo, e.session_id)));
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
      const wanted = keysFor(repo, sessionId);
      const kept = entries.filter((e) => !wanted.includes(key(e.repo, e.session_id)));
      if (kept.length === entries.length) return OK_WITHOUT_WRITING;
      return (await writeAll(kept)) ? OK_WRITTEN : IO_ERROR;
    });
  }

  return { record, read, readSettled, remove, drain };
}

/**
 * Wait for a promise of an outcome, but not forever.
 *
 * The bound is `WRITE_TIMEOUT_MS` (2s), the same one the run-exit path uses.
 * Past it this resolves with `TIMEOUT` rather than rejecting or throwing: the
 * caller has to keep going (the exit signal, the quit), and the write itself is
 * untouched — it stays queued and still lands. `DRAIN_FAILED` is the other
 * answer that is not a store outcome, and neither of them may be reported as
 * one.
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
 * The bound is `WRITE_TIMEOUT_MS` (2s) by default. Past it the answer is
 * `TIMEOUT` — a value, not a throw — and the write is *not* abandoned: it stays
 * queued, so a quit still waits for it, and its real outcome arrives through
 * `onLate` once, only if the bound was actually hit. Returning a value rather
 * than throwing is what lets `settleRunExit` send the exit either way.
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
 * The channel the renderer listens on for "the run is over".
 *
 * It is spelled here and nowhere else in the main process. `main.js` does not
 * name it, so it cannot send it by accident; the only code that sends it is
 * `settleRunExit`, which lands the evidence first.
 */
const RUN_EXIT_CHANNEL = "run:exit";

/**
 * Opening the door is deliberately not part of what a caller can reach: the
 * symbol below is module-private, so only `settleRunExit` can open a door.
 * That is what turns "the record first, the signal after" from an ordering
 * somebody has to keep into a fact nobody can break from the outside.
 */
const OPEN_EXIT_DOOR = Symbol("run-exit.open");

/**
 * The one door out of a *run*.
 *
 * A door is closed when it is made, so sending through it before `settleRunExit`
 * opens it is refused rather than delivered. And it opens at most once: a run
 * that ended says so once, because a second exit signal would tell the renderer
 * the run ended twice.
 *
 * "At most once" is per *door*, so the door has to be per *run* — that is the
 * caller's side of this contract, and it used to be nobody's: `settleRunExit`
 * made a fresh door on every call, so the `sent` guard below could never fire.
 * A second `settleRunExit` for the same run (a service that reported its
 * outcome twice, a retry added later) would have sent a second exit and told
 * the renderer the run had ended twice. So whoever starts a run makes one door
 * (`main.js`, in the handler that starts the CLI) and hands it to
 * `settleRunExit`, which is still the only thing that can open it and the only
 * thing that sends. `tools/run-diagnostics-smoke.mjs` holds one door across two
 * settles and asserts the second one says nothing.
 *
 * The channel name lives in this closure, so the sender never has to know it.
 */
function createRunExitDoor(send) {
  let open = false;
  let sent = false;
  return {
    channel: RUN_EXIT_CHANNEL,
    isOpen: () => open,
    hasSent: () => sent,
    /**
     * Say that the run is over. Refused unless the door was opened by
     * `settleRunExit` — which is the whole point of the door.
     */
    signal(payload) {
      if (!open) {
        throw new Error(`${RUN_EXIT_CHANNEL} 只能由 settleRunExit 发出：证据必须先落盘`);
      }
      if (sent) {
        throw new Error(`${RUN_EXIT_CHANNEL} 一次运行只能发一次`);
      }
      sent = true;
      send(RUN_EXIT_CHANNEL, payload);
    },
    [OPEN_EXIT_DOOR]() {
      open = true;
    },
  };
}

/**
 * Record the evidence, then say that the run is over — in that order.
 *
 * The signature used to take a `signal` callback, i.e. the caller made the
 * promise "this is called after the record landed" and the function only
 * trusted it. That is the wrong side of the contract: it made the ordering a
 * property of the caller's discipline, and the one caller that mattered
 * (`main.js`) had already got it wrong once. The parameters are `send` +
 * `payload` now: the caller says *how* to send and *what* to send, and
 * `settleRunExit` keeps *when*. The order is then the shape of this function
 * instead of a promise somebody else has to keep.
 *
 * The renderer refreshes the history as soon as it hears the exit signal, and a
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
 *
 * The exit channel itself is not the caller's business: `settleRunExit` sends
 * it through a door it opens itself, so "the renderer was told the run is over"
 * and "the evidence had already landed" are the same statement. The caller
 * gives a door (`exit`, made where the run was started), a `payload`, and — for
 * callers that have no run of their own — a `send`; it does not get to say when.
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
  // The door belongs to the run, not to this call: a caller that started the run
  // hands over the one door it made there, so a second settle for the same run
  // meets a door that has already said its one word. A caller with no run of its
  // own (`send` only) still gets a door here, because losing the exit is the
  // worse mistake — a run that ends without an exit is a spinner that never
  // stops.
  const door = opts.exit || (typeof opts.send === "function" ? createRunExitDoor(opts.send) : null);
  if (!door) return outcome;
  // Already said. Nothing to report: a repeat is not news, and reporting it as
  // `signal-failed` would put a line about the screen in the log for a screen
  // that was told correctly the first time.
  if (door.hasSent()) return outcome;
  door[OPEN_EXIT_DOOR]();
  try {
    door.signal(typeof opts.payload === "function" ? opts.payload(outcome) : outcome);
  } catch (_) {
    // The signal is the last thing that happens for this run, so a throw here
    // used to be the one path `settleRunExit` left uncovered: the exit is
    // answered with `send()`, which throws when the window is already gone,
    // and the rejected promise was swallowed by a `.catch(() => {})`
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
  createAppStore,
  normalizeRepo,
  CASE_INSENSITIVE_PATHS,
  detectCaseInsensitive,
  createCaseDetector,
  resolveCaseInsensitive,
  MAX_ENTRIES,
  LIMIT_WARNING,
  WRITE_TIMEOUT_MS,
  MAX_DRAIN_ROUNDS,
  drainQueue,
  drainBounded,
  outcomeMessage,
  outcomeLogMessage,
  signalFailedMessage,
  settleFailedMessage,
  // Exported so the renderer's drawer rule (`TROUBLE_LINE` in
  // `src/lib/format.ts`) can be checked against *every* wording in both tables
  // rather than against the ones a check happens to remember. A new outcome
  // added to either table is then a red check until it is classified.
  OUTCOME_MESSAGES,
  LATE_OUTCOME_MESSAGES,
  reportOutcome,
  recordBounded,
  settleRunExit,
  createRunExitDoor,
  SIGNAL_FAILED,
  SETTLE_FAILED,
  flushNow,
  flushBeforeQuit,
};
