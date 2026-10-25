// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * Exercises the exit flush inside a real Electron process.
 *
 * The evidence of a truncated run is written asynchronously, and the app can be
 * closed right after the run finishes — the write is still in flight. Electron
 * does not wait for pending promises when the main process exits, so without a
 * flush the evidence is simply gone and the reopened session looks clean again.
 *
 * Whether the quit really waits is the one property that cannot be checked
 * outside Electron, so it is checked here: the write is issued, the app is told
 * to quit, and the file is inspected *after* the process is gone.
 *
 * argv[2] = directory to keep the evidence file in.
 */
const path = require("path");
const { app } = require("electron");
const { createStore, flushBeforeQuit } = require("../run-diagnostics");

const dir = process.argv[2];
const store = createStore(path.join(dir, "run-diagnostics.json"));

// Slow the drain down on purpose. The flush has to wait for it, so the quit
// cannot complete before the store says it is done; without the flush the app
// quits the moment it is told to, and the pending write is simply dropped.
// Waiting for a real write to finish would not prove anything here — on a fast
// disk it lands before the process dies either way.
const realDrain = store.drain.bind(store);
store.drain = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return realDrain();
};

// The same wiring the app uses; the flush is shared code on purpose, so this
// harness cannot pass while the app behaves differently.
flushBeforeQuit(app, store);

app.whenReady().then(() => {
  // Issued and deliberately not awaited: only the flush can make it land.
  store.record("/repo", "exit-session", {
    warnings: [{ type: "review_limit_reached", file: "a.go", message: "not persisted" }],
    summary: { budget_exceeded: false },
  });
  app.quit();
});
