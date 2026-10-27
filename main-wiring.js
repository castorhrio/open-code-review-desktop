// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * The two sentences `main.js` says out loud about work it could not do, as
 * functions with the sender injected.
 *
 * Both were already behaviours, but they lived in the registration — the one
 * module no test can `require`, because requiring it opens an Electron window.
 * So the checks read `main.js` as text instead: "is there a `lost > 0` within
 * 600 characters of a `send("run:log", { line: … })`". An assertion like that
 * is green for a branch that is never reached, green for a branch that says the
 * count on the wrong channel as long as the text still matches, and red when
 * somebody moves the same branch one function away. Reading the source was the
 * only thing available; it is not the same question as "does a zero loss stay
 * quiet, and does a real one leave once with the number in it".
 *
 * Moving them here changes what can be asked: `main.js` now calls
 * `reportSenderLoss({ ...windowSender.markReady(), limit: windowSender.limit,
 * send })` and `reportProbeError({ message, send })`, and everything those two
 * sentences promise — one call, the `run:log` channel, the `{ line }` payload,
 * the count and the bound in the text, silence at zero — is checked by calling
 * them (`tools/main-wiring-smoke.mjs`).
 *
 * Why these two and not every `send()` in the app: these are the two lines
 * whose whole purpose is to say that something was lost or that a probe broke.
 * A bug in either one is silent by construction — nothing else in the app reads
 * the same fact — so they are the pair that needs a caller test rather than a
 * source-level one. The uninstall warning (`uninstall-handler.js`) is wired the
 * same way but its behaviour is already exercised through the handler it is
 * injected into, so it stays where it is.
 *
 * Both functions answer `true` when a line was handed to `send`. The answer is
 * for tests and diagnostics; callers are not meant to branch on it.
 *
 * Both also refuse to throw. They run on two paths that must survive their own
 * logging: `did-finish-load` (a throw there is an unhandled error in the main
 * process, and the window has just become usable) and `app:info`'s sink (a
 * throw would reject the settings page). A missing `send` is a wiring mistake,
 * but the answer to a wiring mistake is not to take the caller down — in a
 * packaged app there is no second place to read a stack trace from.
 */

const RUN_LOG = "run:log";

const isSender = (send) => typeof send === "function";

/** The bound as a sentence fragment, or `null` when it is not a usable number.
 *  `windowSender.limit` is always a positive integer, but the sentence must not
 *  turn into "（undefined 条）" if a future wiring passes something else. */
const boundOf = (limit) => (Number.isSafeInteger(limit) && limit > 0 ? limit : null);

/**
 * Says that the bounded queue dropped lines before the renderer was ready.
 *
 * `lost` is read from `markReady()` and is per-ready, not a running total. Zero
 * is the ordinary case and must stay completely quiet: a log line on every
 * launch saying "0 lines were lost" is noise that teaches the reader to skip
 * the drawer, which is exactly what this sentence cannot afford.
 *
 * @param {object} options
 * @param {number} options.lost    lines the bound dropped since the last ready
 * @param {number} [options.limit] the bound, so the reader can judge the loss
 * @param {(channel: string, payload: object) => unknown} options.send
 * @returns {boolean} whether a line was handed to `send`
 */
const reportSenderLoss = (options) => {
  const opts = options || {};
  const lost = opts.lost;
  if (!Number.isSafeInteger(lost) || lost <= 0) return false;
  if (!isSender(opts.send)) return false;
  const bound = boundOf(opts.limit);
  const line =
    bound === null
      ? `[ui] 窗口就绪前有 ${lost} 条事件超出缓冲上限，已丢弃最早的那些`
      : `[ui] 窗口就绪前有 ${lost} 条事件超出缓冲上限（${bound} 条），已丢弃最早的那些`;
  opts.send(RUN_LOG, { line });
  return true;
};

/**
 * Says that the version probe threw, so the settings page's empty version is
 * not the whole story.
 *
 * The payload is `{ line }` and nothing else: the drawer reads `line`, and a
 * structured `{ id }` here would be a second thing for it to learn. The
 * sentence carries the message `describeProbeError` produced, unchanged —
 * `app-info.js` already decided how much of the exception to show.
 *
 * @param {object} options
 * @param {string} options.message the sentence the probe produced
 * @param {(channel: string, payload: object) => unknown} options.send
 * @returns {boolean} whether a line was handed to `send`
 */
const reportProbeError = (options) => {
  const opts = options || {};
  if (!isSender(opts.send)) return false;
  // An empty message would make the line say "版本探测失败：" and nothing else,
  // which reads as a bug in the logger rather than as a failed probe.
  const detail = typeof opts.message === "string" && opts.message.trim() ? opts.message : "未知错误";
  opts.send(RUN_LOG, { line: `[app:info] 版本探测失败：${detail}` });
  return true;
};

module.exports = { reportSenderLoss, reportProbeError };
