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

function formatAppInfo({
  binary,
  versionStdout = "",
  versionStderr = "",
  configPath = "",
  docsUrl = "",
  appVersion = "",
  platform = "",
  installInfo = {},
} = {}) {
  const binaryPath = binary && binary.path ? binary.path : null;
  return {
    binary: binaryPath,
    // "not found" has one answer here: no path, no source. Copying a stale
    // `source` next to a null `path` would let the page say "package" while
    // also saying it could not find the package.
    binarySource: binaryPath ? (binary && binary.source) || null : null,
    version: readVersion(binaryPath, versionStdout, versionStderr),
    configPath,
    docsUrl,
    appVersion,
    platform,
    ...(installInfo || {}),
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
 * called as `exec(args, { timeoutMs })` and may throw; a throw is folded into
 * "said nothing" rather than propagated, because a rejected `app:info` blanks the
 * very page this function exists to keep readable.
 */
const VERSION_PROBE_MS = 5000;
const VERSION_PROBE_GRACE_MS = 500;

const saidNothing = (timedOut) => ({ versionStdout: "", versionStderr: "", timedOut });

async function readVersionOutput({
  binary,
  exec,
  timeoutMs = VERSION_PROBE_MS,
  graceMs = VERSION_PROBE_GRACE_MS,
} = {}) {
  const binaryPath = binary && binary.path ? binary.path : null;
  // No binary, no question: asking one that is not there is how a stale version
  // ends up attached to "not found".
  if (!binaryPath || typeof exec !== "function") return saidNothing(false);
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : VERSION_PROBE_MS;
  // Never wait less than the budget the child was given: answering "timed out"
  // while the child is still inside its own budget would report a failure that
  // has not happened yet.
  const wait = budget + (Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : VERSION_PROBE_GRACE_MS);
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
    // shape would surface as `undefined` output rather than as silence.
    .catch(() => ({ stdout: "", stderr: "", timedOut: false }));
  const answer = await Promise.race([probe, deadline]);
  clearTimeout(timer);
  // `late` wins even when both settled in the same tick: a service that ignores
  // its budget has no chance to set `timedOut` itself, and "we stopped waiting"
  // is what the caller needs to know.
  if (late || !answer) return saidNothing(true);
  return {
    versionStdout: answer.stdout,
    versionStderr: answer.stderr,
    timedOut: answer.timedOut === true,
  };
}

module.exports = { formatAppInfo, readVersionOutput, VERSION_PROBE_MS, VERSION_PROBE_GRACE_MS };
