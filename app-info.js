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

module.exports = { formatAppInfo };
