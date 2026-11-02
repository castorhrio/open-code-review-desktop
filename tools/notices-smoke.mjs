// Pins the two pure functions that decide what may enter the notice bar, and the
// one call site that joins them.
//
// Why this file exists: `src/lib/notices.ts` documents six invariants in prose —
// an empty run id is no run, a non-string run id is no run, a payload that is
// not an object is no run, a bare marker answers with the line itself, the
// sentence is trimmed, and a line filed under a run is never a notice. Until now
// every one of them was a comment: the only executable check was inside
// `tools/ui-audit/fixtures.mjs`, which asserts three premises before the first
// screenshot and then spends a full browser run on them. A rule can be weakened
// between those two ends and the browser run still goes green as long as the
// fixture's three premises survive.
//
// So the checks here are call by call, and every one of them comes with the wrong
// implementation it is meant to catch — because a boundary assertion that also
// passes for the bug it describes is a comment with a console.log attached:
//
//   1. `logSource`: which shapes mean "this line is some run's transcript";
//   2. `noticeText`: `null` for run lines, the marker stripped and trimmed for
//      the app's, and the line itself when there is nothing behind the marker;
//   3. the call site in `src/store.tsx`: both halves are handed in, exactly once,
//      so "the prefix is enough" cannot come back without a type error or a red
//      here;
//   4. the two answers the audit's notice shots rest on, so a change here says
//      which shot is about to move.
//
// No Electron, no browser, no build: `src/lib/notices.ts` is imported directly
// (Node >= 22.18 strips the types). Run with `npm run audit:notices`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");

// Node announces type stripping once per process — a MODULE_TYPELESS_PACKAGE_JSON
// warning about this repo's extensionless `package.json`, not about the import
// below — and that would be the first thing in the output of a suite whose whole
// point is that its output is readable. Every other warning still gets through.
const defaultWarningPrinters = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code !== "MODULE_TYPELESS_PACKAGE_JSON") defaultWarningPrinters.forEach((print) => print(w));
});

const notices = await import("../src/lib/notices.ts").catch((err) => {
  console.error(
    `src/lib/notices.ts could not be imported — it needs Node >= 22.18 to strip the types (this is ${process.version}): ${err.message}`
  );
  process.exit(2);
});
const { NOTICE_MARK, logSource, noticeText } = notices;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/* ---- 1. the two functions exist and the marker is the one the wire carries ---- */
{
  check(
    "the module exports the marker and the two functions the renderer calls",
    NOTICE_MARK === "[notice]" && typeof logSource === "function" && typeof noticeText === "function",
    JSON.stringify({ NOTICE_MARK, logSource: typeof logSource, noticeText: typeof noticeText })
  );

  // `main-wiring.js` writes the marker; this side reads it. Transcribing it in one
  // place and changing it in the other would leave a bar that never appears, so
  // the producer is asked rather than copied.
  const require = createRequire(path.join(ROOT, "package.json"));
  const wiring = require(path.join(ROOT, "main-wiring.js"));
  const produced = [];
  const send = (_channel, payload) => produced.push(payload.line);
  wiring.reportSenderLoss({ lost: 1, limit: 200, send });
  wiring.reportProbeError({ message: "Error: spawn ocr ENOENT", send });
  check(
    "both sentences main-wiring.js writes begin with that exact marker",
    produced.length === 2 && produced.every((line) => line.startsWith(NOTICE_MARK)),
    JSON.stringify(produced)
  );
}

/* ---- 2. logSource: whose line is this? ---- */
{
  // "run" is answered only for a run id that could actually file a line. Every
  // other shape means "the app wrote this about itself", which is the direction
  // that must not be over-answered: an id that is merely truthy (`123`, `[]`,
  // `{}`) would file the app's own sentences under a run that never existed.
  const cases = [
    [{ id: "run-1" }, "run", "a run id is that run's transcript"],
    [{ id: "0" }, "run", "the id is a string; \"0\" is a run like any other"],
    [{ id: "" }, "app", "an empty id is no run at all"],
    [{ id: "   " }, "run", "an id of spaces is a string and non-empty — the id is not trimmed here, only the sentence is"],
    [{ id: 123 }, "app", "a non-string id is no run"],
    [{ id: 0 }, "app", "a numeric zero id is no run"],
    [{ id: null }, "app", "a null id is no run"],
    [{ id: true }, "app", "a boolean id is no run"],
    [{ id: [] }, "app", "an empty array id is not a string, so it is no run"],
    [{ id: {} }, "app", "an object id is no run"],
    [{}, "app", "a payload without an id is the app's own sentence"],
    [null, "app", "no payload at all is the app's own sentence"],
    [undefined, "app", "an absent payload is the app's own sentence"],
    ["run-1", "app", "a payload that is not an object has no id to file under"],
  ];
  for (const [payload, want, why] of cases) {
    const got = logSource(payload);
    check(`logSource(${JSON.stringify(payload)}) === "${want}"`, got === want, `${why} — got ${JSON.stringify(got)}`);
  }

  // The implementation this list exists to reject: `payload?.id ? …`, i.e. the
  // shape that answers "run" for `123`, for `{}`, and for anything else truthy.
  // Without this the seven "app" rows above could be passing for a rule that only
  // happens to see falsy ids in the fixtures.
  const truthyId = (payload) => (payload?.id ? "run" : "app");
  const survivors = cases.filter(([payload, want]) => truthyId(payload) === want && logSource(payload) !== want);
  check(
    "...and a truthiness test on the id would answer differently for the shapes this table pins",
    survivors.length === 0,
    JSON.stringify(survivors.map(([payload]) => payload))
  );
}

/* ---- 3. noticeText: what may be lifted onto the bar ---- */
{
  const cases = [
    // The app said it: the marker is not part of the sentence.
    [`${NOTICE_MARK} 窗口就绪前有 3 条事件超出缓冲上限（200 条）`, "app", "窗口就绪前有 3 条事件超出缓冲上限（200 条）"],
    [`${NOTICE_MARK} x`, "app", "x"],
    // The marker with nothing behind it is a sender bug. The honest rendering of
    // a bug is the line as it arrived, not a silent drop — a dropped line is a
    // sentence the app wrote and nobody saw, which is what the bar exists to end.
    [NOTICE_MARK, "app", NOTICE_MARK],
    [`${NOTICE_MARK}   `, "app", NOTICE_MARK],
    // Trimmed on both sides, once: the same sentence arriving with stray spaces
    // must be the same row, or a repeat becomes a second row.
    [`  ${NOTICE_MARK}  x  `, "app", "x"],
    [`${NOTICE_MARK}  x`, "app", "x"],
    // A line without the marker is a progress line and stays in the drawer.
    [`[ui] 窗口就绪前有 3 条事件超出缓冲上限（200 条）`, "app", null],
    [`[noticex] 长得像但不是`, "app", null],
    // The whole reason this takes a second argument: a CLI line that begins with
    // the marker is some run's transcript, whatever it says.
    [`${NOTICE_MARK} 这一行是 CLI 的原文，不是本程序说的话`, "run", null],
    [`${NOTICE_MARK} x`, "run", null],
    // Nothing at all is not a notice either.
    ["", "app", null],
    ["   ", "app", null],
  ];
  for (const [line, source, want] of cases) {
    const got = noticeText(line, source);
    check(
      `noticeText(${JSON.stringify(line)}, "${source}") === ${JSON.stringify(want)}`,
      got === want,
      `got ${JSON.stringify(got)}`
    );
  }

  // Two mutations, one per half of the rule. The first is the rule this repo had
  // before the run id was consulted (the audit serves it as a bundle too); the
  // second is the sentence with its marker left on, which would show `[notice]`
  // to the reader and break the dedupe against a properly stripped copy.
  const prefixOnly = (line) => {
    const text = String(line ?? "").trim();
    return text.startsWith(NOTICE_MARK) ? text.slice(NOTICE_MARK.length).trim() || text : null;
  };
  const keepsMarker = (line, source) => {
    if (source !== "app") return null;
    const text = String(line ?? "").trim();
    return text.startsWith(NOTICE_MARK) ? text : null;
  };
  const runLine = `${NOTICE_MARK} 这一行是 CLI 的原文，不是本程序说的话`;
  check(
    "...and a prefix-only rule would lift a run's marked line, which this table would catch",
    prefixOnly(runLine) !== null && noticeText(runLine, "run") === null,
    JSON.stringify({ prefixOnly: prefixOnly(runLine) })
  );
  check(
    "...and a rule that forgets to strip the marker would show `[notice]` to the reader, which this table would catch",
    keepsMarker(`${NOTICE_MARK} x`, "app") === `${NOTICE_MARK} x` &&
      noticeText(`${NOTICE_MARK} x`, "app") === "x",
    JSON.stringify({ keepsMarker: keepsMarker(`${NOTICE_MARK} x`, "app") })
  );
}

/* ---- 4. the call site: both halves, once, in the file the bundle is built from ---- */
{
  const store = stripComments(fs.readFileSync(path.join(ROOT, "src/store.tsx"), "utf8"));
  const joined = [...store.matchAll(/noticeText\(\s*line\s*,\s*logSource\(\s*payload\s*\)\s*\)/g)].length;
  check(
    "src/store.tsx derives the source from the payload it received, and hands both to noticeText",
    joined === 1,
    `${joined} occurrence(s) of noticeText(line, logSource(payload))`
  );

  // The two ways back to the old bug: ask noticeText with a constant "app"
  // (which is what the weakened bundle in the audit simulates), or drop the
  // second argument entirely.
  const constantSource = [...store.matchAll(/noticeText\(\s*line\s*,\s*"(?:app|run)"\s*\)/g)].length;
  const oneArgument = [...store.matchAll(/noticeText\(\s*line\s*\)/g)].length;
  check(
    "...and neither a constant source nor a one-argument call is in the file",
    constantSource === 0 && oneArgument === 0,
    JSON.stringify({ constantSource, oneArgument })
  );
}

/* ---- 5. the two answers the browser audit rests on ---- */
{
  // `tools/ui-audit/fixtures.mjs` builds its expectations from the producer's
  // text and refuses to start if these two facts change. Asserted here too, and
  // in the same direction, so a change to the rule says *which* shot is about to
  // move before the browser run gets to say it less precisely.
  check(
    "the app's own sentence carries no run id, so it is a notice",
    logSource({ line: `${NOTICE_MARK} x` }) === "app",
    JSON.stringify(logSource({ line: `${NOTICE_MARK} x` }))
  );
  check(
    "...and the same sentence filed under a run is not, so ?notice=1 still has its reverse control",
    logSource({ id: "run-1", line: `${NOTICE_MARK} x` }) === "run",
    JSON.stringify(logSource({ id: "run-1", line: `${NOTICE_MARK} x` }))
  );
}

if (failures.length) {
  console.error(`\n${failures.length} notice assertion(s) failed.`);
  process.exit(1);
}
console.log("\nall notice assertions passed");
