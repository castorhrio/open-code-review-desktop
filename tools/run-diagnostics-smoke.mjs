// The session stream is the CLI's, but the truncation evidence is not: warnings
// are never persisted, so the desktop records the few fields a reopened session
// needs. This drives that store directly — no Electron, no CLI — because a
// silent failure here is exactly the one that makes a truncated run look clean
// again after a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createStore,
  normalizeRepo,
  MAX_ENTRIES,
  LIMIT_WARNING,
  RECORD_TIMEOUT_MS,
  MAX_DRAIN_ROUNDS,
  drainQueue,
  reportOutcome,
  recordBounded,
  flushNow,
} = require("../run-diagnostics.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-run-diagnostics-"));
const file = path.join(dir, "nested", "run-diagnostics.json");
const store = createStore(file);
const repo = "/home/x/work/payments-api";
const otherRepo = "/home/x/work/other";
const session = "9f2c41d0a7b34e58b1c6d7e8f9a0b1c2";
const other = "1a7b9c3d5e6f708192a3b4c5d6e7f809";

const passed = [];
const failed = [];
const check = (name, ok, detail) => {
  (ok ? passed : failed).push(name);
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
};

const limitResult = {
  warnings: [
    { type: LIMIT_WARNING, file: "internal/service/auth/login.go", message: "secret provider text" },
    { type: "subtask_error", file: "x.go", message: "not persisted" },
  ],
  summary: { budget_exceeded: false },
};

await store.record(repo, session, limitResult);
const got = store.read(repo, session);
check("a round-limit warning survives the round trip", got?.warnings?.length === 1 && got.warnings[0].type === LIMIT_WARNING);
check("the warning keeps the file it touched", got?.warnings?.[0]?.file === "internal/service/auth/login.go");
check("other warning types are not persisted", !JSON.stringify(got?.warnings).includes("subtask_error"));
check("warning messages are not persisted", !fs.readFileSync(file, "utf8").includes("secret provider text"));
check("a warning-only run is not reported as a budget stop", got?.budget_exceeded === false);

await store.record(repo, other, { summary: { budget_exceeded: true } });
const budget = store.read(repo, other);
check("a budget stop is recorded without any warning", budget?.budget_exceeded === true && budget?.warnings?.length === 0);

const cleanSession = "c3d4e5f60718293a4b5c6d7e8f901234";
await store.record(repo, cleanSession, { status: "complete", warnings: [], summary: { budget_exceeded: false } });
check("a clean run leaves no entry", store.read(repo, cleanSession) === null);

await store.record(otherRepo, session, limitResult);
check("the same session id in another repository is isolated", store.read(otherRepo, session)?.warnings?.length === 1 && store.read("/home/x/work/a-third", session) === null);

// The repository key has to be the *folder*, not the spelling. The renderer
// sends what the picker handed it (`.../payments-api/`), while a session load
// sends what the CLI echoes (`.../payments-api`); a spec built from a nested
// path can carry `..`. Recorded under one spelling and read under another, the
// entry used to be invisible — and the entry is the truncation evidence that
// makes a reopened session honest. All of these are the same folder.
await store.record(`${repo}/`, "slash-session", limitResult);
check("a trailing separator does not create a second repository", store.read(repo, "slash-session")?.warnings?.length === 1);
check("an entry recorded without a separator is found when read with one", store.read(`${repo}/`, session)?.warnings?.length === 1);
await store.record(`${repo}/../payments-api`, "dotdot-session", limitResult);
check("a path spelled with .. resolves to the same repository", store.read(repo, "dotdot-session")?.warnings?.length === 1);
check("normalizeRepo resolves a relative spelling", normalizeRepo(path.relative(process.cwd(), repo)) === normalizeRepo(repo));
const rawSlash = JSON.parse(fs.readFileSync(file, "utf8"));
check("the stored key is canonical, not the caller's spelling", rawSlash.entries.filter((e) => e.repo === repo).length >= 1 && rawSlash.entries.every((e) => e.repo === normalizeRepo(e.repo)));
// Windows compares paths case-insensitively, so the same folder can arrive with
// a different drive letter or folder casing; elsewhere a path is a byte string
// and a different casing is a different folder, which must stay isolated.
await store.record(repo, "case-session", limitResult);
if (process.platform === "win32") {
  check("a differently-cased path is the same repository", store.read(repo.toUpperCase(), "case-session")?.warnings?.length === 1);
} else {
  check("elsewhere, casing is part of the path", store.read(repo.toUpperCase(), "case-session") === null);
}

await store.remove(repo, session);
check("deleting a session deletes its entry", store.read(repo, session) === null);
check("deleting one entry leaves the others", store.read(repo, other)?.budget_exceeded === true);

fs.writeFileSync(file, "{ not json", "utf8");
check("a corrupt file reads as no evidence instead of throwing", store.read(repo, other) === null);
await store.record(repo, session, limitResult);
check("recording recovers from a corrupt file", store.read(repo, session)?.warnings?.length === 1);

fs.writeFileSync(
  file,
  JSON.stringify({
    version: 1,
    entries: [
      {
        repo,
        session_id: "legacy",
        warnings: [{ type: LIMIT_WARNING, file: "a.go", message: "should not escape" }, { type: "subtask_error", file: "b.go" }],
        budget_exceeded: true,
      },
    ],
  }),
  "utf8"
);
const legacy = store.read(repo, "legacy");
check("a hand-edited record is normalised to type + file", legacy?.warnings?.length === 1 && !JSON.stringify(legacy).includes("should not escape"));

for (let i = 0; i < MAX_ENTRIES + 5; i++) {
  await store.record(repo, `session-${String(i).padStart(3, "0")}`, limitResult);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
check("the file is capped", raw.entries.length === MAX_ENTRIES, `${raw.entries.length} entries`);
check("the cap drops the oldest, not the newest", raw.entries.some((e) => e.session_id === `session-${String(MAX_ENTRIES + 4).padStart(3, "0")}`) && !raw.entries.some((e) => e.session_id === "session-000"));
check("every entry fits the small schema", raw.entries.every((e) => typeof e.repo === "string" && typeof e.session_id === "string" && Array.isArray(e.warnings) && typeof e.budget_exceeded === "boolean"));

/* ---- two writes must not lose each other ----
 * Every write is a whole-file read-modify-write, and it now awaits a real disk
 * write in the middle of it. Two runs finishing close together (one per window,
 * or a record landing while another session is deleted) would otherwise both
 * read the same list, both append their own entry, and the rename that lands
 * second would drop the other one — silently, and only for the evidence this
 * store exists to keep. The two writes below are issued without awaiting the
 * first, exactly as two IPC handlers finishing together would.
 */
const raceStore = createStore(path.join(dir, "race", "run-diagnostics.json"));
const raceA = "aaaabbbbccccddddeeeeffff00001111";
const raceB = "11110000ffffeeeeddddccccbbbbaaaa";
const [raceLeft, raceRight] = await Promise.all([
  raceStore.record(repo, raceA, limitResult),
  raceStore.record(otherRepo, raceB, { summary: { budget_exceeded: true } }),
]);
check("two writes issued together both land", raceStore.read(repo, raceA)?.warnings?.length === 1, JSON.stringify(raceStore.read(repo, raceA)));
check("the second one is not lost either", raceStore.read(otherRepo, raceB)?.budget_exceeded === true, JSON.stringify(raceStore.read(otherRepo, raceB)));
check("and both report that they wrote", raceLeft?.reason === "written" && raceRight?.reason === "written", `${raceLeft?.reason} / ${raceRight?.reason}`);

/* ---- the store has to say whether it wrote ----
 * Every write here is best-effort by design, and `main.js` used to call it as a
 * statement: a full disk or a read-only profile wrote nothing, said nothing, and
 * the reopened session looked clean again — the exact failure the store exists
 * to prevent. `record()` now answers, so a caller can at least log it.
 */
const unwritableDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-run-diagnostics-ro-"));
const blocker = path.join(unwritableDir, "blocker");
fs.writeFileSync(blocker, "not a directory", "utf8");
// A file where a directory would have to be, so mkdir fails on every platform —
// chmod is not a portable way to make a path unwritable (root ignores it, and
// Windows has no mode bits that mean this).
const unwritable = createStore(path.join(blocker, "nested", "run-diagnostics.json"));
let threw = null;
let wrote = null;
try {
  wrote = await unwritable.record(repo, session, limitResult);
} catch (e) {
  threw = e;
}
check("a write that cannot land says so", wrote?.ok === false, JSON.stringify(wrote));
// `main.js` warns on this one only: the evidence existed, the disk refused it,
// and the reopened session will read as clean even though this run was truncated.
check("and names the disk as the reason", wrote?.reason === "io-error", JSON.stringify(wrote));
check("and does not throw", threw === null, threw && String(threw));
check("with nothing silently readable afterwards", unwritable.read(repo, session) === null);
// A clean run has nothing to write and is not a failure, or every healthy run
// would log a warning.
const cleanOutcome = await store.record(repo, "clean-again", { status: "complete", warnings: [] });
check("a clean run reports success without writing", cleanOutcome.ok === true && cleanOutcome.reason === "clean", JSON.stringify(cleanOutcome));
// No session id is a *different* outcome: there is no session to reopen, so
// nothing can be lost — the caller has to stay quiet about it rather than warn.
const noSession = await store.record(repo, "", limitResult);
check("evidence with no session id is reported, not swallowed", noSession.ok === false && noSession.reason === "no-session", JSON.stringify(noSession));
const written = await store.record(repo, "reported", limitResult);
check("a recorded run reports success", written.ok === true && written.reason === "written", JSON.stringify(written));
check("and its evidence is there to read", store.read(repo, "reported")?.warnings?.length === 1);
/* ---- the exit has to wait for the write ----
 * The evidence is written asynchronously, and the app can be closed right after
 * a run finishes — the write is still in flight. Electron does not wait for
 * pending promises when the main process exits, so the app holds the quit
 * until the store says it is done; `drain()` is the word it waits on.
 *
 * The writes below are issued and deliberately *not* awaited: only the drain
 * can make them land.
 */
const drainStore = createStore(path.join(dir, "drain", "run-diagnostics.json"));
const order = [];
const queued = drainStore.record(repo, "drain-session", limitResult).then(() => order.push("record"));
await drainStore.drain();
order.push("drain");
check("drain() resolves after the queued write", order.join(",") === "record,drain", order.join(","));
check("and the evidence is on disk when it does", drainStore.read(repo, "drain-session")?.warnings?.length === 1);
await queued;
await drainStore.drain();
check("a drain with nothing pending changes nothing", drainStore.read(repo, "drain-session")?.warnings?.length === 1);

/* A run can finish exactly as the window closes, so a write may be queued
 * while the drain is already waiting — the drain has to notice it. */
const lateStore = createStore(path.join(dir, "drain-late", "run-diagnostics.json"));
const lateFirst = lateStore.record(repo, "first", limitResult);
const lateDraining = lateStore.drain();
const lateSecond = lateStore.record(repo, "second", limitResult);
await lateDraining;
check("a write queued during the wait is not missed", lateStore.read(repo, "second")?.warnings?.length === 1);
await Promise.all([lateFirst, lateSecond]);

/* ---- the end of a run must not wait on a slow disk ----
 * `run:exit` waits for the record so the renderer cannot read a session before
 * its evidence landed. The file lives in the profile directory, which can be a
 * network mount, so that wait needs an upper bound: a store whose write never
 * settles stands in for the slow disk here. Without the bound this check hangs
 * (and `npm run audit:diagnostics` with it), which is the failure it is for.
 */
const hungStore = { record: () => new Promise(() => {}) };
const startedAt = Date.now();
const timedOut = await recordBounded(hungStore, repo, "slow-session", limitResult, 120);
const waited = Date.now() - startedAt;
check(
  "a record that never settles gives up instead of holding run:exit",
  timedOut?.reason === "timeout" && waited < 1500,
  `reason=${timedOut?.reason} waited=${waited}ms`
);

// The bound must not swallow a real write: the same call still writes and
// reports, which is what the run-exit path acts on.
const quick = await recordBounded(store, repo, "bounded-session", limitResult, 2000);
check("a fast record still reports what it wrote", quick?.reason === "written", JSON.stringify(quick));
check("and its evidence is readable", store.read(repo, "bounded-session")?.warnings?.length === 1);

/* ---- a queue that never stops has to say so ----
 * `drain()` used to stop after 100 rounds and return nothing, which made a
 * queue that kept re-arming — a run finishing exactly as the window closes, or
 * a remove racing a record — indistinguishable from an empty one. The app then
 * quit (or started the uninstaller) while a write was still pending, and no
 * line in the log said the truncation evidence might be gone. The bound is
 * still there; reaching it is now a fact the caller can log.
 */
let rounds = 0;
const churning = () => {
  rounds += 1;
  // A fresh promise every time, so the tail never repeats: this is a queue that
  // always has one more write behind it, the shape no real disk can produce on
  // demand and the only shape the limit exists for.
  return Promise.resolve();
};
const stuck = await drainQueue(churning);
check("a queue that keeps moving reports max-rounds instead of draining", stuck?.ok === false && stuck?.reason === "max-rounds", JSON.stringify(stuck));
check("and it stops at the round limit", rounds === MAX_DRAIN_ROUNDS * 2, `${rounds} rounds for ${MAX_DRAIN_ROUNDS} rounds`);
const stuckLog = [];
reportOutcome(stuck, (line) => stuckLog.push(line));
check("and the caller logs exactly one line about it", stuckLog.length === 1 && stuckLog[0].startsWith("[run-diagnostics]"), JSON.stringify(stuckLog));
check("reaching the bound is not reported as success", reportOutcome({ ok: true, reason: "drained" }) === "");

// The same answer has to survive the caller's own timeout wrapper: `flushNow`
// is what `before-quit` and the uninstall path actually await.
const stuckFlush = await flushNow({ drain: () => drainQueue(churning) }, 2000);
check("the exit flush passes max-rounds through", stuckFlush?.reason === "max-rounds", JSON.stringify(stuckFlush));
const slowFlush = await flushNow({ drain: () => new Promise(() => {}) }, 60);
check("and a drain that never answers is reported as a timeout", slowFlush?.reason === "timeout", JSON.stringify(slowFlush));

/* ---- a write that finishes after the bound must still be heard ----
 * `recordBounded` gives up so `run:exit` is not held by a slow disk, but the
 * write is still queued and it is the only thing that knows whether the
 * evidence landed. Its real outcome has to reach the log — once — or a full
 * disk under a slow profile directory loses the evidence in silence.
 */
const lateOutcomes = [];
const slowLateStore = {
  record: () =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "io-error" }), 120)),
};
const boundedFirst = await recordBounded(slowLateStore, repo, "late-session", limitResult, 40, (outcome) =>
  lateOutcomes.push(outcome)
);
check("the run-exit path is not held by the slow write", boundedFirst?.reason === "timeout", JSON.stringify(boundedFirst));
check("nothing is claimed about the write before it settles", lateOutcomes.length === 0, JSON.stringify(lateOutcomes));
// The write lands after the bound, so its outcome can only arrive later — which
// is the whole point: the caller has already sent `run:exit` by then.
await new Promise((resolve) => setTimeout(resolve, 250));
check("but a write that lands after the bound is still reported", lateOutcomes.length === 1 && lateOutcomes[0]?.reason === "io-error", JSON.stringify(lateOutcomes));
const lateLog = [];
reportOutcome(lateOutcomes[0], (line) => lateLog.push(line), { late: true });
check("and it reaches the log the caller actually writes to", lateLog.length === 1 && lateLog[0].startsWith("[run-diagnostics]"), JSON.stringify(lateLog));
check("and it is delivered exactly once", lateOutcomes.length === 1, `${lateOutcomes.length} calls`);

// A write that beats the bound must not fire the late listener: a healthy run
// would otherwise log twice about a fact it got right.
let lateCalls = 0;
const quickAgain = await recordBounded(store, repo, "bounded-no-late", limitResult, 2000, () => {
  lateCalls += 1;
});
check("a write that beats the bound does not fire the late listener", quickAgain?.reason === "written" && lateCalls === 0, `${quickAgain?.reason} / ${lateCalls}`);
check("the default bound is the one the run-exit path uses", RECORD_TIMEOUT_MS > 0 && Number.isFinite(RECORD_TIMEOUT_MS));

fs.rmSync(unwritableDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) process.exit(1);
