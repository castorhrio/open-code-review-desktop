// Pins the three answers `screenAfter` can give, because the end-to-end report
// reads them as different failures.
//
// The end-to-end flow waits for text on screen and, when the wait ends, quotes
// the screen. Two failures must not share a sentence: "the wait timed out" (slow
// CLI, or the spec never reached it) and "the wait rejected for another reason"
// (a dead renderer, an execution error) and "the wait resolved but the text was
// not there" (the screen is real, the assertion is simply false). `screenAfter`
// is the pure decision between those, and until this file it had no test — it
// lived inline in `e2e-flow.cjs`, which needs Electron and a real CLI.
//
// Run with `npm run audit:e2e-screen`.
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { timeoutError, screenAfter, neverAppeared } = require(path.join(ROOT, "tools", "e2e-screen.cjs"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- the marker is what separates a timeout from every other failure ---- */
{
  const marked = timeoutError("timed out waiting for a.go");
  check(
    "timeoutError keeps the sentence and marks the error as a timeout",
    marked instanceof Error && marked.message === "timed out waiting for a.go" && marked.__timeout === true,
    JSON.stringify({ message: marked.message, timeout: marked.__timeout })
  );
  check(
    "...and an ordinary error is not a timeout by accident",
    new Error("timed out waiting for a.go").__timeout !== true,
    "the message text must not decide the verdict"
  );
}

/* ---- resolved: the screen is the wait's answer, no reader, no timeout ---- */
{
  let reads = 0;
  const answer = await screenAfter(Promise.resolve("a.go is listed"), () => {
    reads += 1;
    return "a later screen";
  }, { timeoutMs: 60000 });
  check(
    "resolved: the screen is the wait's answer, timedOut is false, the budget is echoed",
    answer.screen === "a.go is listed" && answer.timedOut === false && answer.timeoutMs === 60000,
    JSON.stringify({ screen: answer.screen, timedOut: answer.timedOut, timeoutMs: answer.timeoutMs })
  );
  check(
    "...and the screen is not read a second time",
    reads === 0,
    `reader called ${reads} time(s); reading after success would replace the answer with a later frame`
  );
  check(
    "...and no error is attached, so a resolved wait cannot be reported as a failure",
    !("error" in answer),
    JSON.stringify(Object.keys(answer))
  );

  // An empty screen is a real answer, not a timeout. The distinction is the
  // whole point: a blank screen that was waited for is a judged screen.
  const empty = await screenAfter(Promise.resolve(""), () => Promise.reject(new Error("unused")), { timeoutMs: 5 });
  check(
    "resolved with an empty screen: still not a timeout",
    empty.screen === "" && empty.timedOut === false && empty.timeoutMs === 5,
    JSON.stringify({ screen: empty.screen, timedOut: empty.timedOut })
  );
}

/* ---- rejected with the marker: the screen is read, the reason is a timeout ---- */
{
  const waiting = Promise.reject(timeoutError("timed out waiting for the preview"));
  let reads = 0;
  // A distinctive string, so "the reported screen" cannot be confused with a
  // later frame that happens to look the same.
  const readBack = "the form, no preview [read at the deadline]";
  const answer = await screenAfter(waiting, async () => {
    reads += 1;
    return readBack;
  }, { timeoutMs: 60000 });
  check(
    "timed out: the screen is read and the verdict is a timeout",
    answer.screen === readBack && answer.timedOut === true && answer.timeoutMs === 60000,
    JSON.stringify({ screen: answer.screen, timedOut: answer.timedOut, timeoutMs: answer.timeoutMs })
  );
  check(
    "...and the screen is read exactly once, not once per branch",
    reads === 1,
    `reader called ${reads} time(s)`
  );
  check(
    "...and the reported screen is that one read's value, unchanged",
    answer.screen === readBack,
    JSON.stringify({ reported: answer.screen, read: readBack })
  );
  check(
    "...and the original error is kept for the report",
    answer.error instanceof Error && answer.error.message === "timed out waiting for the preview",
    answer.error ? answer.error.message : "no error attached"
  );

  // The reader may throw or reject: the report loses the screen quote, not the
  // verdict. Losing the verdict would turn a timeout into "the flow completed:
  // false", which names no link and is the failure this module exists to stop.
  const deadWindow = await screenAfter(Promise.reject(timeoutError("timed out")), () => {
    throw new Error("no window left");
  }, { timeoutMs: 1000 });
  check(
    "timed out with an unreadable screen: empty screen, timeout verdict survives",
    deadWindow.screen === "" && deadWindow.timedOut === true && deadWindow.timeoutMs === 1000,
    JSON.stringify({ screen: deadWindow.screen, timedOut: deadWindow.timedOut })
  );
  const rejectedReader = await screenAfter(
    Promise.reject(timeoutError("timed out")),
    () => Promise.reject(new Error("executeJavaScript rejected")),
    { timeoutMs: 1000 }
  );
  check(
    "...and a rejecting reader is treated like a throwing one",
    rejectedReader.screen === "" && rejectedReader.timedOut === true,
    JSON.stringify({ screen: rejectedReader.screen, timedOut: rejectedReader.timedOut })
  );
}

/* ---- rejected without the marker: read the screen, but do not call it slow ---- */
{
  const answer = await screenAfter(Promise.reject(new Error("executeJavaScript failed")), async () => "the form", {
    timeoutMs: 5000,
  });
  check(
    "other failure: the screen is read, but timedOut stays false",
    answer.screen === "the form" && answer.timedOut === false && answer.timeoutMs === 5000,
    JSON.stringify({ screen: answer.screen, timedOut: answer.timedOut })
  );
  check(
    "...and the reason is the error that actually happened",
    answer.error instanceof Error &&
      answer.error.message === "executeJavaScript failed" &&
      answer.error.__timeout !== true,
    answer.error ? answer.error.message : "no error attached"
  );
}

/* ---- the sentence names both the subject and the budget ---- */
{
  // Two named budgets rather than two literals: the assertion below is about the
  // sentence naming whichever budget it was given, and a reader should not have
  // to checksum digits in two call sites to agree that they differ.
  const budgetA = 60000;
  const budgetB = 20000;
  const sentence = neverAppeared("the preview", budgetA);
  check(
    "neverAppeared names what was awaited and the budget it did not fit in",
    sentence.includes("the preview") && sentence.includes(String(budgetA)) && sentence.includes("not judged"),
    sentence
  );
  check(
    "...and two different budgets produce two different sentences",
    neverAppeared("the preview", budgetA) !== neverAppeared("the preview", budgetB),
    JSON.stringify([neverAppeared("the preview", budgetA), neverAppeared("the preview", budgetB)])
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all e2e-screen checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
