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
const path = require("path");

const VERSION = 1;
const MAX_ENTRIES = 200;
const LIMIT_WARNING = "review_limit_reached";

function createStore(file) {
  const key = (repo, sessionId) => `${repo || ""}\u0000${sessionId || ""}`;

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || raw.version !== VERSION || !Array.isArray(raw.entries)) return [];
      return raw.entries.filter((e) => e && typeof e.session_id === "string" && e.session_id);
    } catch (_) {
      return [];
    }
  }

  function writeAll(entries) {
    const data = JSON.stringify({ version: VERSION, entries });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, data, "utf8");
      try {
        fs.renameSync(tmp, file);
      } catch (_) {
        // Windows refuses to rename over an existing file; writing in place is
        // still better than losing the record.
        fs.writeFileSync(file, data, "utf8");
        try {
          fs.unlinkSync(tmp);
        } catch (_) {}
      }
    } catch (_) {}
  }

  /** Record only when the run has truncation evidence; clean runs are not kept. */
  function record(repo, sessionId, result) {
    if (!sessionId || !result || typeof result !== "object") return;
    const warnings = Array.isArray(result.warnings)
      ? result.warnings
          .filter((w) => w && w.type === LIMIT_WARNING)
          .map((w) => ({ type: LIMIT_WARNING, ...(w.file ? { file: String(w.file) } : {}) }))
      : [];
    const budget = Boolean(result.summary && result.summary.budget_exceeded);
    if (!warnings.length && !budget) return;

    const entries = readAll().filter((e) => key(e.repo, e.session_id) !== key(repo, sessionId));
    entries.push({ repo: repo || "", session_id: sessionId, warnings, budget_exceeded: budget });
    // Insertion order is the age order; keeping the tail drops the oldest and
    // keeps the newest, without a timestamp that can tie inside one millisecond.
    writeAll(entries.slice(-MAX_ENTRIES));
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

  function remove(repo, sessionId) {
    if (!sessionId) return;
    const entries = readAll();
    const kept = entries.filter((e) => key(e.repo, e.session_id) !== key(repo, sessionId));
    if (kept.length !== entries.length) writeAll(kept);
  }

  return { record, read, remove };
}

module.exports = { createStore, MAX_ENTRIES, LIMIT_WARNING };
