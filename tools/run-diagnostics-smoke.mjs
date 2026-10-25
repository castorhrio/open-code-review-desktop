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
const { createStore, normalizeRepo, MAX_ENTRIES, LIMIT_WARNING } = require("../run-diagnostics.js");

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
fs.rmSync(unwritableDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) process.exit(1);
