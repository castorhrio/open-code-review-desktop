// Pins the two lines `main.js` says out loud about work it could not do — the
// count of lines the sender's bound dropped, and a version probe that threw.
//
// Why this file exists: both sentences were behaviours that lived only in
// `main.js`, and `main.js` cannot be `require`d by a test (requiring it opens
// an Electron window). The checks therefore read it as text: an `if (lost > 0)`
// within 600 characters of `send("run:log", { line: … })`. That question is
// green for a branch that never runs, green for a branch that says the count on
// the wrong channel as long as the same text is present, and red when the same
// branch is moved one function away. Reading source was the only option; it was
// never the same question as "does a zero loss stay quiet, and does a real one
// leave once, on `run:log`, with the number in it".
//
// So the two sentences moved into `main-wiring.js` with `send` injected. The
// suite is in two halves, and the second is what makes the first trustworthy:
//   1. the two functions, called: silence at zero, one call on a real loss, the
//      channel, the payload key, the count and the bound in the text, and a
//      missing or throwing-style sender that does not take the caller down;
//   2. the same questions asked of hand-written wrong reports — wrong channel,
//      wrong payload key, count ignored, `if (lost)` instead of `lost > 0`, a
//      terminal instead of `run:log` — which must all *fail* the property, or
//      the property is not about anything.
//
// Then one more pair: the wiring in `main.js` (does it hand `markReady()`'s
// answer to `reportSenderLoss`, and the probe's message to `reportProbeError`,
// with the app's own `send`) and the same question asked of constructed
// registrations that inline the old branch, forget `send`, or pick the message
// apart themselves.
//
// No Electron, no window, no filesystem beyond this repo's own sources.
// Run with `npm run audit:wiring`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { reportSenderLoss, reportProbeError } = require(path.join(ROOT, "main-wiring.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/* ---- 1. the shape of the module itself ---- */
{
  check(
    "the module exports the two reports main.js needs",
    typeof reportSenderLoss === "function" && typeof reportProbeError === "function",
    JSON.stringify({ reportSenderLoss: typeof reportSenderLoss, reportProbeError: typeof reportProbeError })
  );
}

/* ---- 2. a loss that is zero says nothing ---- */
{
  const sent = [];
  const send = (channel, payload) => sent.push({ channel, payload });

  // The ordinary case, and the one that must never become a log line: a fixed
  // "0 lines were lost" on every launch is noise, and noise in the drawer is
  // exactly what teaches a reader to skip the line that matters.
  for (const lost of [0, -1, -200, "3", 1.5, null, undefined, NaN]) {
    const told = reportSenderLoss({ lost, limit: 200, send });
    check(
      `a loss of ${JSON.stringify(lost)} stays quiet`,
      told === false && sent.length === 0,
      JSON.stringify({ told, sent: sent.length })
    );
  }

  // ...and those shapes are exactly the ones a truthiness branch would send
  // on: `if (lost)` says a line for -1 and for "3", so the quietness asserted
  // above is the difference between this function and that one. Without this
  // half, the check would also pass for `if (lost)` on the one value that made
  // it to the test.
  const truthyReport = ({ lost = 0, limit = 200, send } = {}) => {
    if (!lost) return false;
    send("run:log", { line: `[ui] 窗口就绪前有 ${lost} 条事件超出缓冲上限（${limit} 条）` });
    return true;
  };
  const truthySent = [-1, "3"].map((lost) => {
    const sent = [];
    truthyReport({ lost, send: (channel, payload) => sent.push({ channel, payload }) });
    return sent.length;
  });
  check(
    "...and a report that branches on truthiness would be caught: it sends on the negative and string shapes",
    JSON.stringify(truthySent) === JSON.stringify([1, 1]),
    JSON.stringify(truthySent)
  );
}

/* ---- 3. a real loss leaves once, on the one readable channel ---- */
{
  const sent = [];
  const told = reportSenderLoss({ lost: 3, limit: 200, send: (channel, payload) => sent.push({ channel, payload }) });
  check(
    "a real loss is said exactly once",
    told === true && sent.length === 1,
    JSON.stringify({ told, calls: sent.length })
  );
  check(
    "...on run:log, the channel a packaged app can read",
    sent[0]?.channel === "run:log",
    JSON.stringify(sent.map(({ channel }) => channel))
  );
  check(
    "...with `line` as the only payload key, because that is the one the drawer reads",
    JSON.stringify(Object.keys(sent[0]?.payload ?? {})) === JSON.stringify(["line"]),
    JSON.stringify(Object.keys(sent[0]?.payload ?? {}))
  );
  check(
    "...and the sentence names the count and the bound, so the reader can judge the loss",
    typeof sent[0]?.payload?.line === "string" &&
      sent[0].payload.line.includes("3") &&
      sent[0].payload.line.includes("200"),
    JSON.stringify(sent[0]?.payload?.line)
  );

  // The bound is handed in from `windowSender.limit`. If a future wiring passes
  // something that is not a positive integer, the sentence must stay readable
  // rather than printing "（undefined 条）".
  const fallback = [];
  const toldFallback = reportSenderLoss({
    lost: 2,
    limit: undefined,
    send: (channel, payload) => fallback.push({ channel, payload }),
  });
  check(
    "a bound that is not a positive integer still leaves a readable sentence with the count",
    toldFallback === true &&
      fallback.length === 1 &&
      fallback[0].payload.line.includes("2") &&
      !/undefined|null|NaN/.test(fallback[0].payload.line),
    JSON.stringify(fallback[0]?.payload?.line)
  );

  // 0 and -5 are the two shapes a `Number.isInteger` check would let through
  // without `> 0`, and the sentence would then read "（0 条）" or "（-5 条）" —
  // a bound that cannot exist. The count is still what matters; the bound is
  // simply left out of the sentence.
  const omitsUnusableBound = (report, limit) => {
    const sent = [];
    const told = report({
      lost: 2,
      limit,
      send: (channel, payload) => sent.push({ channel, payload }),
    });
    const line = sent[0]?.payload?.line ?? "";
    return (
      told === true &&
      sent.length === 1 &&
      line.includes("2") &&
      !line.includes("（") &&
      !/undefined|null|NaN|-5/.test(line)
    );
  };
  check(
    "a bound of 0 or -5 is left out of the sentence rather than printed as a bound that cannot exist",
    [0, -5].every((limit) => omitsUnusableBound(reportSenderLoss, limit)),
    JSON.stringify([0, -5].map((limit) => omitsUnusableBound(reportSenderLoss, limit)))
  );
  const relaxedBoundReport = ({ lost, limit, send }) => {
    const bound = Number.isSafeInteger(limit) ? limit : null;
    const line =
      bound === null
        ? `[ui] 窗口就绪前有 ${lost} 条事件超出缓冲上限，已丢弃最早的那些`
        : `[ui] 窗口就绪前有 ${lost} 条事件超出缓冲上限（${bound} 条），已丢弃最早的那些`;
    send("run:log", { line });
    return true;
  };
  check(
    "...and a bound check without `> 0` would print the zero and the negative, which this assertion catches",
    !omitsUnusableBound(relaxedBoundReport, 0) && !omitsUnusableBound(relaxedBoundReport, -5),
    JSON.stringify({
      zero: omitsUnusableBound(relaxedBoundReport, 0),
      negative: omitsUnusableBound(relaxedBoundReport, -5),
    })
  );

  // A wiring mistake (no sender) must not take the load handler down with it:
  // this runs inside `did-finish-load`, where a throw is an unhandled error in
  // the main process and the window has just become usable.
  let escaped = null;
  let toldMissing = null;
  try {
    toldMissing = reportSenderLoss({ lost: 3, limit: 200 });
  } catch (err) {
    escaped = err;
  }
  check(
    "a missing sender is refused instead of throwing out of the load handler",
    escaped === null && toldMissing === false,
    escaped ? escaped.message : JSON.stringify({ toldMissing })
  );
}

/* ---- 4. a probe that threw leaves one sentence, with the message intact ---- */
{
  const sent = [];
  const told = reportProbeError({
    message: "spawn ENOTDIR",
    send: (channel, payload) => sent.push({ channel, payload }),
  });
  check(
    "a probe exception is said exactly once",
    told === true && sent.length === 1,
    JSON.stringify({ told, calls: sent.length })
  );
  check(
    "...on run:log, with `line` as the only payload key",
    sent[0]?.channel === "run:log" &&
      JSON.stringify(Object.keys(sent[0]?.payload ?? {})) === JSON.stringify(["line"]),
    JSON.stringify(sent[0])
  );
  check(
    "...and the sentence carries the probe's own message, not a rewritten one",
    typeof sent[0]?.payload?.line === "string" && sent[0].payload.line.includes("spawn ENOTDIR"),
    JSON.stringify(sent[0]?.payload?.line)
  );

  // `describeProbeError` always answers with a non-empty string, but the line
  // must not degrade into "版本探测失败：" with nothing after it if it ever does
  // not — that reads as a broken logger, not as a failed probe.
  const empty = [];
  reportProbeError({ message: "   ", send: (channel, payload) => empty.push({ channel, payload }) });
  check(
    "...and an empty message still produces a sentence that says something",
    empty.length === 1 &&
      typeof empty[0].payload.line === "string" &&
      empty[0].payload.line.trim().endsWith("：未知错误"),
    JSON.stringify(empty[0]?.payload?.line)
  );

  // The sink is handed whatever the caller has. `describeProbeError` answers
  // with a string today, but `undefined` or a number here must not become
  // "版本探测失败：undefined" / "版本探测失败：42" — an interpolation is not a
  // fallback.
  const saysUnknown = (report, message) => {
    const sent = [];
    const told = report({ message, send: (channel, payload) => sent.push({ channel, payload }) });
    const line = sent[0]?.payload?.line ?? "";
    return (
      told === true &&
      sent.length === 1 &&
      typeof line === "string" &&
      line.trim().endsWith("：未知错误")
    );
  };
  check(
    "an undefined or non-string message falls back to 未知错误",
    [undefined, 42].every((message) => saysUnknown(reportProbeError, message)),
    JSON.stringify([undefined, 42].map((message) => saysUnknown(reportProbeError, message)))
  );
  const uncheckedMessageReport = ({ message, send }) => {
    send("run:log", { line: `[app:info] 版本探测失败：${message}` });
    return true;
  };
  check(
    "...and a report that interpolates the message unchecked would print both, which this assertion catches",
    !saysUnknown(uncheckedMessageReport, undefined) && !saysUnknown(uncheckedMessageReport, 42),
    JSON.stringify({
      undefined: saysUnknown(uncheckedMessageReport, undefined),
      number: saysUnknown(uncheckedMessageReport, 42),
    })
  );

  let escaped = null;
  let toldMissing = null;
  try {
    toldMissing = reportProbeError({ message: "boom" });
  } catch (err) {
    escaped = err;
  }
  check(
    "a missing sender is refused instead of rejecting app:info",
    escaped === null && toldMissing === false,
    escaped ? escaped.message : JSON.stringify({ toldMissing })
  );
}

/* ---- 5. the same questions asked of wrong reports ----
 * `saysLoss` / `saysProbeError` are the properties, written once and applied to
 * the real functions and to hand-written wrong ones. Every wrong one has to
 * fail for its own reason; otherwise this suite would also be satisfied by a
 * report that says the count on `update:state`, or forgets the count.
 */
const lossWasReported = (report) => {
  const sent = [];
  report({ lost: 3, limit: 200, send: (channel, payload) => sent.push({ channel, payload }) });
  return (
    sent.length === 1 &&
    sent[0].channel === "run:log" &&
    JSON.stringify(Object.keys(sent[0].payload ?? {})) === JSON.stringify(["line"]) &&
    sent[0].payload.line.includes("3")
  );
};

const probeErrorWasReported = (report) => {
  const sent = [];
  report({ message: "spawn ENOTDIR", send: (channel, payload) => sent.push({ channel, payload }) });
  return (
    sent.length === 1 &&
    sent[0].channel === "run:log" &&
    JSON.stringify(Object.keys(sent[0].payload ?? {})) === JSON.stringify(["line"]) &&
    sent[0].payload.line.includes("spawn ENOTDIR")
  );
};

check(
  "the real reports pass the property they are supposed to have",
  lossWasReported(reportSenderLoss) && probeErrorWasReported(reportProbeError),
  JSON.stringify({ loss: lossWasReported(reportSenderLoss), probe: probeErrorWasReported(reportProbeError) })
);

const wrongLossChannel = ({ lost, limit, send }) =>
  send("update:state", { line: `[ui] 窗口就绪前有 ${lost} 条事件超出缓冲上限（${limit} 条）` });
const wrongLossKey = ({ lost, send }) => send("run:log", { id: lost });
const ignoresLoss = ({ send }) => send("run:log", { line: "[ui] 窗口就绪前有事件超出缓冲上限" });
check(
  "...and a loss said on another channel, with another key, or without the count is refused",
  !lossWasReported(wrongLossChannel) && !lossWasReported(wrongLossKey) && !lossWasReported(ignoresLoss),
  JSON.stringify({
    channel: lossWasReported(wrongLossChannel),
    key: lossWasReported(wrongLossKey),
    ignores: lossWasReported(ignoresLoss),
  })
);

// The "terminal instead of run:log" wrong report is exercised for real, so its
// `console.warn` is captured rather than printed: the suite's own output is read
// by a person scanning for red, and a label-less line there is noise.
const realWarn = console.warn;
const warned = [];
console.warn = (...args) => warned.push(args.join(" "));
const terminalProbeError = ({ message }) => console.warn(message);
const probeErrorOnAnotherChannel = ({ message, send }) => send("app:info", { line: message });
const stripsTheMessage = ({ send }) => send("run:log", { line: "[app:info] 版本探测失败" });
// Answered once each, because both the condition and the detail want them and
// one of the wrong reports is a real `console.warn` call.
const terminalRefused = probeErrorWasReported(terminalProbeError);
const anotherChannelRefused = probeErrorWasReported(probeErrorOnAnotherChannel);
const strippedRefused = probeErrorWasReported(stripsTheMessage);
check(
  "...and a probe error sent to a terminal, to another channel, or with its message dropped is refused",
  !terminalRefused && !anotherChannelRefused && !strippedRefused,
  JSON.stringify({ terminal: terminalRefused, channel: anotherChannelRefused, stripped: strippedRefused })
);
console.warn = realWarn;
check(
  "...and the terminal report really did run, so the refusal above is about the channel it chose",
  warned.length === 1 && warned[0] === "spawn ENOTDIR",
  JSON.stringify(warned)
);

/* ---- 6. main.js only wires them ----
 * `main-wiring.js` can be perfect while `main.js` still inlines the old branch,
 * forgets to hand over `send`, or picks the probe's fields apart itself. Those
 * are static facts about the registration, so they are read from the source
 * with the comments stripped (the registration explains this in prose, and a
 * check that also forbade the words would make the comment the thing to delete).
 */
{
  const mainSrc = stripComments(fs.readFileSync(path.join(ROOT, "main.js"), "utf8"));

  // The loss: read from `markReady()`, handed to `reportSenderLoss` together
  // with the bound and the app's one door. No branch of its own — `if (lost >
  // 0)` here means a second copy of a sentence that is tested elsewhere.
  const wiresLoss = (source) =>
    /reportSenderLoss\(\s*\{[^}]*\.\.\.windowSender\.markReady\(\)[^}]*\}/.test(source) &&
    /reportSenderLoss\(\s*\{[^}]*\blimit\s*:\s*windowSender\.limit\b[^}]*\}/.test(source) &&
    /reportSenderLoss\(\s*\{[^}]*\bsend\s*[,}][^}]*\}/.test(source) &&
    !/buf[\s\S]{0,40}上限/.test(source) &&
    !/if\s*\(\s*lost\s*>\s*0\s*\)/.test(source);
  check(
    "main.js hands markReady's answer, the bound and its own send to reportSenderLoss",
    wiresLoss(mainSrc),
    "main.js does not route the dropped count through reportSenderLoss"
  );
  // ...and the question really asks it: the old inline branch, a call without
  // the bound, and a call without `send` must all answer no.
  const inlineLoss =
    'const { lost } = windowSender.markReady(); if (lost > 0) { send("run:log", { line: `有 ${lost} 条超出缓冲上限` }); }';
  const lossWithoutBound = 'reportSenderLoss({ ...windowSender.markReady(), send });';
  const lossWithoutSend = 'reportSenderLoss({ ...windowSender.markReady(), limit: windowSender.limit });';
  check(
    "...and an inline branch, a missing bound or a missing send is refused",
    !wiresLoss(inlineLoss) && !wiresLoss(lossWithoutBound) && !wiresLoss(lossWithoutSend),
    JSON.stringify({
      inline: wiresLoss(inlineLoss),
      bound: wiresLoss(lossWithoutBound),
      send: wiresLoss(lossWithoutSend),
    })
  );

  // The probe: `handleAppInfo` offers `onProbeError(message)`, and the wiring
  // hands that message to `reportProbeError` with the same door. No `run:log`
  // literal here either — the sentence's channel is a fact of the tested
  // module, and a second copy is how the two would drift.
  const wiresProbeError = (source) =>
    /onProbeError\s*:/.test(source) &&
    /reportProbeError\(\s*\{(?=[^}]*\bmessage\b)(?=[^}]*\bsend\b)[^}]*\}\s*\)/.test(source) &&
    !/版本探测失败/.test(source) &&
    !/console\.warn\(/.test(source);
  check(
    "main.js hands the probe's message and its own send to reportProbeError",
    wiresProbeError(mainSrc),
    "main.js does not route onProbeError through reportProbeError"
  );
  const inlineProbeError =
    'onProbeError: (message) => send("run:log", { line: `[app:info] 版本探测失败：${message}` }),';
  const probeErrorWithoutSend = 'onProbeError: (message) => reportProbeError({ message }),';
  const probeErrorToTerminal =
    'onProbeError: (message) => reportProbeError({ message, send: (line) => console.warn(line) }),';
  check(
    "...and an inline sink, a missing send or a terminal in its place is refused",
    !wiresProbeError(inlineProbeError) &&
      !wiresProbeError(probeErrorWithoutSend) &&
      !wiresProbeError(probeErrorToTerminal),
    JSON.stringify({
      inline: wiresProbeError(inlineProbeError),
      send: wiresProbeError(probeErrorWithoutSend),
      terminal: wiresProbeError(probeErrorToTerminal),
    })
  );

  // One door: the module is only the sentence. Everything it says has to leave
  // by the `send` it was given — a module that reached for a window itself
  // would work in `main.js` and nowhere else, and nothing above would notice.
  const wiringSrc = stripComments(fs.readFileSync(path.join(ROOT, "main-wiring.js"), "utf8"));
  check(
    "main-wiring.js owns no door of its own: it only ever calls the send it was handed",
    !/require\(|webContents|BrowserWindow|ipcMain/.test(wiringSrc) &&
      (wiringSrc.match(/opts\.send\(/g) || []).length === 2,
    JSON.stringify({ requires: /require\(/.test(wiringSrc), webContents: /webContents/.test(wiringSrc) })
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all main-wiring checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
