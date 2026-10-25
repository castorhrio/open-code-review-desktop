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
 * `record()` / `remove()` answer with an outcome instead of a bare boolean.
 *
 * - `clean`      nothing needed writing (a run with no evidence, or a delete
 *                that found nothing) — success, and silent
 * - `written`    the evidence landed where a reopened session will look
 * - `no-session` there was evidence but no session id to file it under
 * - `io-error`   there was something to write and the disk refused it
 *
 * The two failures used to share one `false`, so `main.js` could only warn
 * about both or neither. They are not the same news: an `io-error` means the
 * truncation warning is gone after a restart *and nobody chose that*, which is
 * worth a line in the log; `no-session` (scan runs, or a CLI that printed no
 * session id) is a known shape and warning about it every run is noise.
 */
const OK_WITHOUT_WRITING = { ok: true, reason: "clean" };
const OK_WRITTEN = { ok: true, reason: "written" };
const NO_SESSION = { ok: false, reason: "no-session" };
const IO_ERROR = { ok: false, reason: "io-error" };

/**
 * The same repository, however the caller spelled it.
 *
 * The renderer sends the folder the user picked, and that spelling is not
 * stable: the picker hands back `/repo/` with a trailing separator, the CLI
 * echoes `/repo`, a spec built from a nested path carries `..`, and on Windows
 * the same folder can arrive with different casing. Keys used to be the raw
 * string, so a run recorded under one spelling was invisible under another —
 * and the entry it lost is the truncation evidence a reopened session exists
 * to keep. Resolving (and lower-casing on Windows, where paths compare
 * case-insensitively) makes the key about the folder rather than the typing.
 *
 * Reading normalises as well, so entries written by an earlier build — which
 * stored the raw string — still answer for any spelling of the same folder.
 */
function normalizeRepo(repo) {
  const raw = String(repo || "");
  if (!raw) return "";
  let abs;
  try {
    abs = path.resolve(raw);
  } catch (_) {
    return raw;
  }
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function createStore(file) {
  const key = (repo, sessionId) => `${normalizeRepo(repo)}\u0000${sessionId || ""}`;

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

  return { record, read, remove };
}

module.exports = { createStore, normalizeRepo, MAX_ENTRIES, LIMIT_WARNING };
