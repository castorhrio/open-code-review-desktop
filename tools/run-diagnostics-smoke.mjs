// The session stream is the CLI's, but the truncation evidence is not: warnings
// are never persisted, so the desktop records the few fields a reopened session
// needs. This drives that store directly — no Electron, no CLI — because a
// silent failure here is exactly the one that makes a truncated run look clean
// again after a restart.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const {
  createStore,
  createAppStore,
  normalizeRepo,
  CASE_INSENSITIVE_PATHS,
  detectCaseInsensitive,
  createCaseDetector,
  resolveCaseInsensitive,
  MAX_ENTRIES,
  LIMIT_WARNING,
  WRITE_TIMEOUT_MS,
  MAX_DRAIN_ROUNDS,
  drainQueue,
  drainBounded,
  outcomeMessage,
  outcomeLogMessage,
  signalFailedMessage,
  OUTCOME_MESSAGES,
  LATE_OUTCOME_MESSAGES,
  reportOutcome,
  recordBounded,
  settleRunExit,
  SIGNAL_FAILED,
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
// Two assertions, not one `a && b`: chained, the second condition is only
// reached when the first holds, so a failure of the second says nothing about
// which of the two broke.
check("the stored key is the repository the caller asked for", rawSlash.entries.filter((e) => e.repo === repo).length >= 1);
check("and every stored key is canonical", rawSlash.entries.every((e) => e.repo === normalizeRepo(e.repo)));
// Windows and macOS compare paths case-insensitively (NTFS, and APFS/HFS+ by
// default), so the same folder can arrive with a different drive letter or
// folder casing; on Linux a path is a byte string and a different casing is a
// different folder, which must stay isolated.
await store.record(repo, "case-session", limitResult);
if (process.platform === "win32" || process.platform === "darwin") {
  check("a differently-cased path is the same repository", store.read(repo.toUpperCase(), "case-session")?.warnings?.length === 1);
} else {
  check("elsewhere, casing is part of the path", store.read(repo.toUpperCase(), "case-session") === null);
}
// The macOS answer cannot be checked on a Linux box by running the macOS
// branch, so the case-sensitivity is a property of the key rather than of the
// OS, and both answers are checked on every platform. This is the assertion
// that would have caught the macOS gap: the key was byte-compared there, so a
// run recorded under one spelling of the folder was invisible under another —
// and the entry it lost is the truncation evidence a reopened session exists to
// keep.
const caseRepo = "/home/x/work/Payments-API";
check(
  "a case-insensitive volume folds two spellings of one folder together",
  normalizeRepo(`${caseRepo}/`, { caseInsensitive: true }) === normalizeRepo(caseRepo.toLowerCase(), { caseInsensitive: true }),
  `${normalizeRepo(caseRepo, { caseInsensitive: true })} != ${normalizeRepo(caseRepo.toLowerCase(), { caseInsensitive: true })}`
);
check(
  "a case-sensitive volume keeps two spellings apart",
  normalizeRepo(caseRepo, { caseInsensitive: false }) !== normalizeRepo(caseRepo.toLowerCase(), { caseInsensitive: false })
);
// Two explicit assertions, not one `a === b === c`. Chained `===` evaluates left
// to right, so it folds the first comparison into a boolean and then asks
// whether *that* equals the platform flag — a check that happens to pass today
// and would keep passing whatever the store did, which is the opposite of what
// it exists for (this is the assertion that catches a macOS regression).
const foldedHere = normalizeRepo(caseRepo) === normalizeRepo(caseRepo.toLowerCase());
const platformFoldsCasing = process.platform === "win32" || process.platform === "darwin";
check(
  "the store folds casing on Windows and macOS, and nowhere else",
  CASE_INSENSITIVE_PATHS === platformFoldsCasing,
  `flag=${CASE_INSENSITIVE_PATHS} platform=${process.platform}`
);
check(
  "and normalizeRepo uses exactly that answer",
  foldedHere === CASE_INSENSITIVE_PATHS,
  `folded=${foldedHere} flag=${CASE_INSENSITIVE_PATHS}`
);

/* ---- a volume that folds case and a volume that does not are two worlds ----
 * The store keys every entry by the folder it belongs to, and a folder is
 * spelled by whoever typed it. Which spellings are the same folder is a
 * property of the *volume*, not of the OS — a macOS volume can be formatted
 * case-sensitive, a Linux one can be mounted case-insensitively — so the
 * store takes the volume's answer and reads, writes and deletes the same way
 * in each. The default is the platform's answer, which is what the app uses.
 *
 * Both answers are checked on every platform, because otherwise this file
 * would only ever assert the behaviour of the machine it runs on: on a
 * case-folding platform the two spellings must share one entry, on a
 * case-sensitive one they must stay apart — and the delete has to follow the
 * same rule in both, or it would either miss the entry it was asked to
 * remove or take one that belongs to a different folder.
 */
const foldingStore = createStore(path.join(dir, "folding", "run-diagnostics.json"), { caseInsensitive: true });
const sensitiveStore = createStore(path.join(dir, "sensitive", "run-diagnostics.json"), { caseInsensitive: false });
const casedRepo = "/home/x/work/Payments-API";
await foldingStore.record(casedRepo, "folded-session", limitResult);
check("a volume that folds case keeps two spellings of one folder together", foldingStore.read(casedRepo.toLowerCase(), "folded-session")?.warnings?.length === 1);
await foldingStore.remove(casedRepo.toLowerCase(), "folded-session");
check("and a delete by the other spelling still removes it", foldingStore.read(casedRepo, "folded-session") === null);
await sensitiveStore.record(casedRepo, "split-session", limitResult);
check("a volume that keeps case keeps two folders apart", sensitiveStore.read(casedRepo.toLowerCase(), "split-session") === null);
await sensitiveStore.remove(casedRepo.toLowerCase(), "split-session");
check("and a delete of one of them leaves the other alone", sensitiveStore.read(casedRepo, "split-session")?.warnings?.length === 1);

/* ---- the volume is asked, not the OS ----
 * Whether two spellings of one folder are the same folder is a property of
 * the volume that folder is on: a macOS volume can be formatted case-sensitive,
 * and a Linux one can be mounted case-insensitively. The platform's default is
 * a guess, and it is wrong in both directions — so the app asks the volume,
 * of the repository's own path (that is the path the key is about; the
 * profile directory's volume would answer a different question), and without
 * writing anything into the user's working tree.
 *
 * A case-folding filesystem is not something a test can mount, so the volume
 * is *modelled* here: the probe is handed a `stat` that behaves the way such
 * a volume behaves. That is still a real assertion — the probe has to ask the
 * right question and read the answer the right way round — and the volume the
 * check really runs on is compared with the probe's own answer further down.
 */
const enoent = (target) => {
  const err = new Error(`ENOENT: no such file or directory, stat '${target}'`);
  err.code = "ENOENT";
  return err;
};
// A volume that folds case: every spelling of a name is the same entry.
const foldingStat = (name, ino = 42) => (target) => {
  const base = path.basename(target);
  if (base.toLowerCase() !== name.toLowerCase()) throw enoent(target);
  return { dev: 1, ino };
};
// A volume that keeps case: only the exact spelling is there.
const sensitiveStat = (name, ino = 42) => (target) => {
  const base = path.basename(target);
  if (base !== name) throw enoent(target);
  return { dev: 1, ino };
};
/* The parent directory's own names, as `readdir` hands them back. The probe asks
 * the parent *after* `stat` answered ENOENT for the other spelling, because
 * ENOENT alone does not say which of two worlds the path is in: a volume that
 * keeps case, or a folding volume where that name is not there at all. Names
 * are the listing only — the checks never touch the disk for this. */
const listingOf = (...names) => () => names;
const volumeRepo = "/home/x/work/Payments-API";
check(
  "a volume that folds case is recognised",
  detectCaseInsensitive(volumeRepo, { stat: foldingStat("Payments-API") }) === true
);
check(
  "a volume that keeps case is recognised",
  detectCaseInsensitive(volumeRepo, {
    stat: sensitiveStat("Payments-API"),
    readdir: listingOf("Payments-API"),
  }) === false
);
/* `stat` answering ENOENT for the other spelling is the *before* image of two
 * different volumes: one that keeps case, and one that folds it but where the
 * name being doubled is simply not there (a path typed wrong, a repository
 * that moved, a spelled segment that never existed). The old probe called both
 * of them "keeps case" — a wrong certainty that skipped the platform's
 * fallback and split one folder into two keys on the very volume that folds
 * case. Hence the listing: only "the spelled name is there and nothing answers
 * to the other" is evidence about the volume. */
check(
  "a folding volume asked about a name that is not there cannot be judged",
  detectCaseInsensitive(volumeRepo, {
    stat: (target) => {
      const base = path.basename(target);
      if (base === "Payments-API") return { dev: 1, ino: 42 };
      throw enoent(target);
    },
    // The folder is on disk under another casing, which is what a folding
    // volume does; the listing therefore cannot tell it from "keeps case".
    readdir: listingOf("PAYMENTS-API"),
  }) === null
);
check(
  "a parent directory that cannot be listed leaves the question open",
  detectCaseInsensitive(volumeRepo, {
    stat: sensitiveStat("Payments-API"),
    readdir: () => {
      throw new Error("EACCES: permission denied");
    },
  }) === null
);
check(
  "a stat failure that is not ENOENT is no answer either",
  detectCaseInsensitive(volumeRepo, {
    stat: (target) => {
      if (path.basename(target) === "Payments-API") return { dev: 1, ino: 42 };
      const err = new Error("EIO");
      err.code = "EIO";
      throw err;
    },
    readdir: listingOf("Payments-API"),
  }) === null
);
/* Two entries whose names differ in case are two folders on a volume that keeps
 * case, and the answer there is "keeps case". The names are flipped by the
 * probe itself (`flipCase`), so this models `Repo` / `rEPO` — an earlier version
 * of this check compared `Payments-API` with `PAYMENTS-API`, which is *not* the
 * other spelling the probe asks about: it only ever reached the ENOENT branch,
 * so it stayed green while asserting nothing. */
check(
  "two folders whose names differ in case are two folders",
  detectCaseInsensitive("/home/x/work/Repo", {
    stat: (target) => {
      const base = path.basename(target);
      if (base === "Repo") return { dev: 1, ino: 42 };
      if (base === "rEPO") return { dev: 1, ino: 43 };
      throw enoent(target);
    },
  }) === false
);
check(
  "a path that is not there cannot be judged",
  detectCaseInsensitive(volumeRepo, { stat: sensitiveStat("Somewhere-Else") }) === null
);
check(
  "a volume with no identity to compare cannot be judged",
  detectCaseInsensitive(volumeRepo, { stat: () => ({ dev: 1, ino: 0 }) }) === null
);
/* The probe spells the deepest segment that carries letters, so a path whose
 * own leaf is a number still gets an answer from its nearest named ancestor:
 * a repository at `/home/x/2024/10/26` is asked about `x`, not about `26`.
 * Without the walk, the answer would be `null` ("cannot tell") and every such
 * repository would fall back to the platform's guess. */
const datedRepo = "/home/x/2024/10/26";
check(
  "a path whose leaf is a number is asked about its nearest named ancestor",
  detectCaseInsensitive(datedRepo, { stat: foldingStat("x") }) === true
);
check(
  "and the same walk reads a case-keeping volume the right way round",
  detectCaseInsensitive(datedRepo, { stat: sensitiveStat("x"), readdir: listingOf("x") }) === false
);
/* The walk is bounded (MAX_LETTER_WALK, 8): it looks for a name with letters
 * and stops even if it has not found one. Ten numeric segments below the named
 * ancestor is two past the bound, so the probe must answer `null` ("cannot
 * tell", and the caller falls back to the platform) rather than reach `/home/x`
 * and answer — or throw. The stat here would happily answer `true`, so this
 * assertion fails if the bound is ever raised without the caller's fallback
 * being reconsidered. (Nine numeric segments is the last path that still
 * answers, which is what pins the number to 8 rather than "some limit".) */
const pastTheWalk = "/home/x/2024/10/26/01/02/03/04/05/06/07";
const withinTheWalk = "/home/x/2024/10/26/01/02/03/04/05/06";
check(
  "a path whose nearest name is past the walk says it cannot tell",
  detectCaseInsensitive(pastTheWalk, { stat: foldingStat("x") }) === null
);
check(
  "and one whose nearest name is inside the walk still answers",
  detectCaseInsensitive(withinTheWalk, { stat: foldingStat("x") }) === true
);
// The volume is asked once per path: a file with a hundred entries would
// otherwise ask a hundred times, and the repository under review is often on a
// network mount.
let probes = 0;
const counting = createCaseDetector({
  stat: (target) => {
    // Only the path as spelled counts: the probe also asks about the other
    // spelling, which is a second question, not a second probe.
    if (path.basename(target) === "Payments-API") probes += 1;
    return sensitiveStat("Payments-API")(target);
  },
});
counting(volumeRepo);
counting(volumeRepo);
check("the volume is asked once per path", probes === 1, `${probes} probes`);
/* What counts as "the same path" is the *resolved* one, and that is the whole
 * reason the cache exists: the renderer sends the folder it was handed, and the
 * same folder arrives with a trailing separator, or with `..` in a spec built
 * from a nested path. Resolve first, then ask — otherwise each spelling is
 * another pair of stats on a disk that may be a network mount.
 *
 * The key is deliberately *not* case-folded: whether case folds is the answer
 * being asked for, so folding the key first would be assuming the answer. Two
 * casings of one folder therefore cost two probes — bounded, and correct. */
const resolvedSame = [`${volumeRepo}/`, `${volumeRepo}/../Payments-API`];
for (const spelling of resolvedSame) counting(spelling);
check(
  "spellings that resolve to one folder ask the volume once",
  probes === 1,
  `${probes} probes for ${[volumeRepo, ...resolvedSame].join(" ")}`
);

/* The answer the store keys by: an explicit answer wins, the volume's answer
 * is used when there is none, and a volume that cannot tell falls back to the
 * platform's answer — which is right on Windows and on a default macOS
 * volume, and no reason to second-guess when the volume said nothing.
 *
 * The platform's answer is injected here, because on the machine this runs on
 * it happens to be the one that makes the difference invisible: a probe that
 * could not answer would be read as "case-sensitive", which is the same as the
 * platform's answer on Linux and the opposite of it on macOS. */
check("an explicit answer wins over the volume's", resolveCaseInsensitive("/x", { caseInsensitive: true, detect: () => false }) === true);
check("the volume's answer is used when there is no explicit one", resolveCaseInsensitive("/x", { detect: () => true }) === true);
check(
  "a volume that cannot answer falls back to the platform's",
  resolveCaseInsensitive("/x", { detect: () => null, platformCaseInsensitive: true }) === true
);
check(
  "and a store with no detector at all uses the platform's answer too",
  resolveCaseInsensitive("/x", { platformCaseInsensitive: true }) === true
);
check(
  "while a platform that keeps case is believed just as much",
  resolveCaseInsensitive("/x", { detect: () => null, platformCaseInsensitive: false }) === false
);

/* The real filesystem, compared with the probe's own answer: the probe writes
 * a file with a mixed-case name and asks whether the other spelling resolves
 * to the same file, which is the ground truth the probe is compared against.
 * The two use different means — the probe flips a sibling's spelling, this
 * writes a file — so they can disagree if the probe is wrong. */
const volumeTarget = path.join(dir, "Volume-Probe");
fs.mkdirSync(volumeTarget, { recursive: true });
const probeFile = path.join(volumeTarget, "MixedCase-Name");
fs.writeFileSync(probeFile, "", "utf8");
let volumeFolds = false;
try {
  const here = fs.statSync(probeFile);
  const there = fs.statSync(path.join(volumeTarget, "mixedcase-name"));
  volumeFolds = here.dev === there.dev && here.ino === there.ino;
} catch (_) {
  volumeFolds = false;
}
const probed = detectCaseInsensitive(volumeTarget);
check("the probe agrees with the volume it ran on", probed === volumeFolds, `probe=${probed} volume=${volumeFolds}`);
check("and it leaves nothing behind", !fs.existsSync(path.join(volumeTarget, "PROBE")) && fs.readdirSync(volumeTarget).length === 1);

/* The store takes the volume's answer, so the app's store is not the only
 * place the two worlds differ. */
const detectedStore = createStore(path.join(dir, "detected", "run-diagnostics.json"), { detect: () => true });
await detectedStore.record(casedRepo, "detected-session", limitResult);
check("a store that asked the volume keeps two spellings of one folder together", detectedStore.read(casedRepo.toLowerCase(), "detected-session")?.warnings?.length === 1);
const detectedRaw = JSON.parse(fs.readFileSync(path.join(dir, "detected", "run-diagnostics.json"), "utf8"));
check("and it stores the spelling its key uses", detectedRaw.entries.every((e) => e.repo === e.repo.toLowerCase()));
const unknownStore = createStore(path.join(dir, "unknown", "run-diagnostics.json"), { detect: () => null, platformCaseInsensitive: true });
await unknownStore.record(casedRepo, "unknown-session", limitResult);
check(
  "a volume that cannot answer falls back to the platform's answer",
  unknownStore.read(casedRepo.toLowerCase(), "unknown-session")?.warnings?.length === 1
);

/* A volume that keeps case, on a platform that folds: the earlier build
 * lower-cased the folder, so its entry is filed under the lower-cased key.
 * The new build keeps the case, and has to look under both — or the session
 * that entry belongs to would look clean again after the upgrade. */
const legacyStore = createStore(path.join(dir, "legacy", "run-diagnostics.json"), {
  detect: () => false,
  platformCaseInsensitive: true,
});
await legacyStore.record(casedRepo.toLowerCase(), "legacy-session", limitResult);
check("an entry filed by the earlier build is still found", legacyStore.read(casedRepo, "legacy-session")?.warnings?.length === 1);
await legacyStore.remove(casedRepo, "legacy-session");
check("and it can still be deleted", legacyStore.read(casedRepo, "legacy-session") === null);

/* ---- the app's own store ----
 * The app used to build the store with the platform's answer, and nothing
 * noticed: the volume was never asked. The wiring now lives in
 * `createAppStore`, so it can be checked here — and this check makes sure
 * `main.js` goes through it rather than building a store of its own.
 *
 * The volume is modelled rather than injected as an answer: handing the store
 * a ready-made answer would prove nothing about the wiring, because the
 * wiring is exactly what builds that answer. So the *filesystem* is modelled
 * instead, and the store has to go and ask it.
 */
const appStore = createAppStore(path.join(dir, "app", "run-diagnostics.json"), { stat: foldingStat("Payments-API") });
await appStore.record(casedRepo, "app-session", limitResult);
check("the app's store asks the volume about case", appStore.read(casedRepo.toLowerCase(), "app-session")?.warnings?.length === 1);
const appStoreSensitive = createAppStore(path.join(dir, "app-sensitive", "run-diagnostics.json"), {
  stat: sensitiveStat("Payments-API"),
  readdir: listingOf("Payments-API"),
});
await appStoreSensitive.record(casedRepo, "app-sensitive-session", limitResult);
check(
  "and keeps two folders apart when the volume does",
  appStoreSensitive.read(casedRepo.toLowerCase(), "app-sensitive-session") === null
);
const appStoreUnknown = createAppStore(path.join(dir, "app-unknown", "run-diagnostics.json"), { detect: () => null, platformCaseInsensitive: true });
await appStoreUnknown.record(casedRepo, "app-unknown-session", limitResult);
check(
  "and falls back to the platform's answer when the volume cannot say",
  appStoreUnknown.read(casedRepo.toLowerCase(), "app-unknown-session")?.warnings?.length === 1
);
/* Startup must not wait on a disk. `main.js` builds the app's store at module
 * load, before Electron is ready — and the repository under review is often on a
 * network mount, where one `stat` can be a round trip. So construction closes
 * over the path and nothing else: no file is read, no volume is asked. The first
 * question about a repository is the one that costs, and it happens on first use
 * (a run recording its evidence, a session reopening), not on launch. */
let startupProbes = 0;
const lazyStore = createAppStore(path.join(dir, "lazy", "run-diagnostics.json"), {
  stat: (target) => {
    if (path.basename(target) === "Payments-API") startupProbes += 1;
    return foldingStat("Payments-API")(target);
  },
});
check("building the app's store asks the volume nothing", startupProbes === 0, `${startupProbes} probes at startup`);
await lazyStore.record(casedRepo, "lazy-session", limitResult);
check("and the first use of a repository is where it costs", startupProbes === 1, `${startupProbes} probes after one record`);
check("while the answer it got is the one the entry is filed under", lazyStore.read(casedRepo.toLowerCase(), "lazy-session")?.warnings?.length === 1);

/* ---- construction is I/O-free, not merely probe-free ----
 * The check above pins "no volume probe at startup". That is one syscall out of
 * several a later change could slip in: a `statSync` to make the profile
 * directory, a `readFileSync` to warm a cache, a `spawn` to ask the CLI
 * something. Launching must never wait on a disk — the store's file can live on
 * a network mount, and `main.js` builds the store before Electron is ready — so
 * the check counts the calls themselves rather than trusting the wiring to stay
 * minimal. Every entry point the module could reach is wrapped, `createAppStore`
 * is called with no injected probe, and nothing may fire before the first use.
 *
 * The counters are proved live rather than assumed: the `record` below has to
 * move two of them, or a wrapper that counted nothing would look green.
 */
const ioCount = { stat: 0, statSync: 0, readFile: 0, readFileSync: 0, spawn: 0 };
const ioOriginals = {
  stat: fsp.stat,
  statSync: fs.statSync,
  readFile: fsp.readFile,
  readFileSync: fs.readFileSync,
  spawn: childProcess.spawn,
};
const wrapped = (fn, bump) => (...args) => {
  bump();
  return fn(...args);
};
let startupStore = null;
let startupIoAtConstruction = null;
let startupIoAfterUse = null;
try {
  fsp.stat = wrapped(ioOriginals.stat, () => { ioCount.stat += 1; });
  fs.statSync = wrapped(ioOriginals.statSync, () => { ioCount.statSync += 1; });
  fsp.readFile = wrapped(ioOriginals.readFile, () => { ioCount.readFile += 1; });
  fs.readFileSync = wrapped(ioOriginals.readFileSync, () => { ioCount.readFileSync += 1; });
  childProcess.spawn = wrapped(ioOriginals.spawn, () => { ioCount.spawn += 1; });

  startupStore = createAppStore(path.join(dir, "startup", "run-diagnostics.json"));
  startupIoAtConstruction = { ...ioCount };
  await startupStore.record(dir, "startup-session", limitResult);
  startupIoAfterUse = { ...ioCount };
} finally {
  fsp.stat = ioOriginals.stat;
  fs.statSync = ioOriginals.statSync;
  fsp.readFile = ioOriginals.readFile;
  fs.readFileSync = ioOriginals.readFileSync;
  childProcess.spawn = ioOriginals.spawn;
}
const ioTotal = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
check(
  "building the app's store touches no file and starts no process",
  ioTotal(startupIoAtConstruction) === 0,
  JSON.stringify(startupIoAtConstruction)
);
check(
  "and the first use is the one that reads the file and asks the volume",
  startupIoAfterUse.statSync > 0 && startupIoAfterUse.readFileSync > 0,
  JSON.stringify(startupIoAfterUse)
);
check(
  "while neither ever starts a process",
  startupIoAfterUse.spawn === 0,
  `${startupIoAfterUse.spawn} spawn calls`
);
check(
  "and the evidence it wrote is the evidence it reads back",
  startupStore.read(dir, "startup-session")?.warnings?.length === 1
);

const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const buildsItself = /createStore\(/.test(mainSrc);
check(
  "the app builds its store through the seam that asks the volume",
  /createAppStore\(/.test(mainSrc) && !buildsItself,
  buildsItself ? "main.js builds the store itself" : ""
);

await store.remove(repo, session);
check("deleting a session deletes its entry", store.read(repo, session) === null);
check("deleting one entry leaves the others", store.read(repo, other)?.budget_exceeded === true);
// A session id is not unique across repositories — the same id can exist under
// two folders, and a delete removes one *entry*, not one id. Matching on the id
// alone would take the other repository's truncation evidence with it, and
// that evidence is the only record that a run there was truncated.
check("deleting a session in one repository leaves the same session id in another", store.read(otherRepo, session)?.warnings?.length === 1);

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
/* The cap is per *file*, not per repository, and it trims on write in file
 * order: the oldest records go, so the sessions a user is most likely to
 * reopen are the ones that survive. What a trimmed session reads as matters as
 * much as the trim itself — `null`, the same answer a clean run gives. That is
 * the documented price of the cap (an unbounded file in the profile directory
 * is the alternative), and it must not silently look like anything else. */
check("a trimmed session reopens as no evidence, not as a failure", store.read(repo, "session-000") === null);
check("while the newest record is still readable", store.read(repo, `session-${String(MAX_ENTRIES + 4).padStart(3, "0")}`)?.warnings?.length === 1);
check(
  "the cap counts records, not repositories",
  raw.entries.filter((e) => e.repo === normalizeRepo(repo)).length === MAX_ENTRIES,
  `${raw.entries.length} entries for ${new Set(raw.entries.map((e) => e.repo)).size} repositories`
);

/* ---- the cap is one number for the whole file ----
 * The comment on MAX_ENTRIES says the cap is "across *all* repositories", and
 * the trim happens on the whole file in insertion order. From a single
 * repository that reads exactly like a per-repository cap — the file never
 * holds more than MAX_ENTRIES records either way — so only two repositories
 * can tell the two apart: under a per-repository cap the oldest record of the
 * first repository would survive while the second one filled the file, and
 * under the global one the oldest record of *either* repository goes.
 * Nothing asserted this, so the comment could drift away from the code without
 * any test going red.
 */
const capFile = path.join(dir, "cap", "run-diagnostics.json");
const capStore = createStore(capFile);
const capA = "/home/x/work/cap-a";
const capB = "/home/x/work/cap-b";
// MAX_ENTRIES + 1 records, alternating between the two repositories, so the
// first one written is also the first one eligible for eviction.
for (let i = 0; i < MAX_ENTRIES + 1; i++) {
  await capStore.record(i % 2 === 0 ? capA : capB, `cap-${String(i).padStart(3, "0")}`, limitResult);
}
const capRaw = JSON.parse(fs.readFileSync(capFile, "utf8"));
check("the cap is one number for the whole file", capRaw.entries.length === MAX_ENTRIES, `${capRaw.entries.length} entries`);
const capACount = capRaw.entries.filter((e) => e.repo === normalizeRepo(capA)).length;
const capBCount = capRaw.entries.filter((e) => e.repo === normalizeRepo(capB)).length;
check(
  "the two repositories share one budget",
  capACount + capBCount === MAX_ENTRIES && capACount < MAX_ENTRIES && capBCount < MAX_ENTRIES,
  `A=${capACount} B=${capBCount}`
);
check(
  "the oldest record of the first repository is gone",
  capStore.read(capA, "cap-000") === null,
  JSON.stringify(capStore.read(capA, "cap-000"))
);
check(
  "while the newest one is still there",
  capStore.read(capA, `cap-${String(MAX_ENTRIES).padStart(3, "0")}`)?.warnings?.length === 1,
  JSON.stringify(capStore.read(capA, `cap-${String(MAX_ENTRIES).padStart(3, "0")}`))
);
// The survivors are the global tail in the order they were written — not one
// repository's oldest kept and another's dropped, which is what a per-repository
// cap would produce.
check(
  "the survivors are the global tail, in the order they were written",
  capRaw.entries[0]?.session_id === "cap-001" &&
    capRaw.entries[capRaw.entries.length - 1]?.session_id === `cap-${String(MAX_ENTRIES).padStart(3, "0")}`,
  `${capRaw.entries[0]?.session_id} .. ${capRaw.entries[capRaw.entries.length - 1]?.session_id}`
);

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
// And the caller stays quiet about it: `no-session` means the CLI printed no
// session id at all — not "a scan run" (`ocr scan` publishes one). With no
// session there is nothing to reopen, so nothing can be lost and a line every
// run would only teach the reader to skip the one that matters.
check("and it says nothing in the log, because there is no session to reopen", outcomeMessage(noSession) === "", JSON.stringify(outcomeMessage(noSession)));
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
check("the default bound is the one the run-exit path uses", WRITE_TIMEOUT_MS > 0 && Number.isFinite(WRITE_TIMEOUT_MS));

/* ---- a reopened session must not look clean while its evidence is in flight ----
 * The run-exit path waits for the record, but only up to a bound: the store's file
 * lives in the profile directory, and a network mount can be slower than that
 * wait. A session reopened right after such a run was read straight from disk,
 * while its own evidence was still being written — and a truncated session
 * looked clean again, which is the one thing this store exists to prevent. The
 * read waits for the writes that are still in flight now.
 */
const pendingStore = createStore(path.join(dir, "pending", "run-diagnostics.json"));
const pendingWrite = pendingStore.record(repo, "pending-session", limitResult);
check("a plain read can miss a write that is still queued", pendingStore.read(repo, "pending-session") === null);
const settled = await pendingStore.readSettled(repo, "pending-session");
check("but a read that waits for the pending write sees it", settled?.warnings?.length === 1, JSON.stringify(settled));
await pendingWrite;
// The wait is bounded like every other one here: a disk that never answers must
// not keep the history from opening.
const stuckRead = await drainBounded(() => new Promise(() => {}), 60);
check("and that wait gives up instead of hanging", stuckRead?.reason === "timeout", JSON.stringify(stuckRead));
check("a settled read of a session that has no evidence is still null", (await pendingStore.readSettled(repo, "never-recorded")) === null);

/* ---- a read must not hang on a disk that never answers ----
 * `readSettled` waits for the writes still in flight, and that wait is bounded
 * like every other one here: the store's file lives in the profile directory,
 * which can be a network mount, and a history that never opens is worse than a
 * history that opens a moment late. The bound is the promise this store makes
 * to its caller, and it is the easiest thing in the file to lose — a plain
 * `drain().then(...)` would wait forever, and the test below would hang with
 * it rather than fail.
 *
 * The disk that never answers is a write that never settles: `fs/promises` is
 * patched to block exactly that one temporary file, so the queue behind it
 * never settles, and the read has to give up on the bound and answer with
 * whatever was already on disk — the evidence of an earlier run, which is
 * exactly what a reopened session is asking about.
 */
const stuckFile = path.join(dir, "stuck-read", "run-diagnostics.json");
const stuckStore = createStore(stuckFile);
await stuckStore.record(repo, "landed-session", limitResult);
const realWriteFile = fsp.writeFile;
let announceBlockedWrite;
const blockedWrite = new Promise((resolve) => {
  announceBlockedWrite = resolve;
});
fsp.writeFile = (target, ...rest) => {
  if (String(target) !== `${stuckFile}.tmp`) return realWriteFile(target, ...rest);
  announceBlockedWrite();
  return new Promise(() => {});
};
// Not awaited on purpose: this write never settles, and waiting for it is the
// very thing the read below must not do.
const neverLands = stuckStore.record(repo, "never-lands", limitResult);
const writeIsBlocked = await Promise.race([
  blockedWrite.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
]);
check("the write is blocked, so the queue behind it never settles", writeIsBlocked === true);
fsp.writeFile = realWriteFile;
const readStartedAt = Date.now();
const stale = await stuckStore.readSettled(repo, "landed-session");
const readWaited = Date.now() - readStartedAt;
check("a read that waits on a disk that never answers gives up instead of hanging", readWaited < WRITE_TIMEOUT_MS + 1500, `${readWaited}ms`);
check("and it gives up on the bound, not before it", readWaited >= WRITE_TIMEOUT_MS - 100, `${readWaited}ms`);
check("and it answers with the evidence that was already on disk", stale?.warnings?.length === 1, JSON.stringify(stale));
check("the session whose write never landed has no evidence to show", (await stuckStore.readSettled(repo, "never-lands", 60)) === null);

/* ---- the exit has to come after the evidence, and say how it went ----
 * The renderer refreshes the history as soon as it hears `run:exit`, and a record
 * that has not landed yet would make a truncated session look clean again. That
 * order used to live in a comment beside a promise chain, where moving one line
 * would have broken it in silence. `settleRunExit` owns it now: the signal comes
 * after the record settled, and it carries the outcome, so the app can say out
 * loud when the evidence did not make it to disk.
 */
const exitStore = createStore(path.join(dir, "exit", "run-diagnostics.json"));
const exitLog = [];
const exitSeen = [];
const exitOutcome = await settleRunExit({
  store: exitStore,
  repo,
  sessionId: "exit-session",
  result: limitResult,
  timeoutMs: 2000,
  warn: (line) => exitLog.push(line),
  signal: (outcome) => exitSeen.push({ outcome, onDisk: exitStore.read(repo, "exit-session")?.warnings?.length === 1 }),
});
check("the exit signal is sent only once the evidence is on disk", exitSeen.length === 1 && exitSeen[0].onDisk, JSON.stringify(exitSeen));
check("and it carries the outcome of the record", exitOutcome?.reason === "written" && exitSeen[0].outcome?.reason === "written", JSON.stringify(exitOutcome));
check("a healthy run has nothing to report", exitLog.length === 0, JSON.stringify(exitLog));

// The exit signal is what hands the screen back, so it goes out even if
// reporting the outcome failed — a run that ends without an exit is a spinner
// that never stops.
let signalAfterBadReport = 0;
await settleRunExit({
  store: exitStore,
  repo,
  sessionId: "exit-session",
  result: limitResult,
  timeoutMs: 2000,
  warn: () => {
    throw new Error("the log line could not be written");
  },
  signal: () => {
    signalAfterBadReport += 1;
  },
});
check("the exit signal goes out even when reporting the outcome fails", signalAfterBadReport === 1, `${signalAfterBadReport}`);

// The signal itself can fail, and that is not a corner case: `main.js` answers
// `run:exit` with `send()`, which throws once the window is gone — the exact
// shape of the app closing while a run ends. The run is over either way, so the
// throw must not undo the evidence (already on disk), must not keep the outcome
// from the caller, and must not pass in silence (the screen may still show the
// run as live).
const throwingSignalStore = createStore(path.join(dir, "throwing-signal", "run-diagnostics.json"));
const throwingSignalLog = [];
let signalSawEvidence = null;
let settleAfterThrowThrew = null;
let settleAfterThrow = null;
try {
  settleAfterThrow = await settleRunExit({
    store: throwingSignalStore,
    repo,
    sessionId: "throwing-signal",
    result: limitResult,
    timeoutMs: 2000,
    warn: (line) => throwingSignalLog.push(line),
    signal: () => {
      signalSawEvidence = throwingSignalStore.read(repo, "throwing-signal")?.warnings?.length === 1;
      throw new Error("the window was already gone");
    },
  });
} catch (err) {
  settleAfterThrowThrew = err;
}
check("a throwing exit signal does not reject the settle", settleAfterThrowThrew === null, settleAfterThrowThrew && String(settleAfterThrowThrew));
check("the evidence was on disk before the signal even ran", signalSawEvidence === true, `${signalSawEvidence}`);
check("and it is still there afterwards", throwingSignalStore.read(repo, "throwing-signal")?.warnings?.length === 1);
check("and the caller still gets the outcome of the record", settleAfterThrow?.reason === "written", JSON.stringify(settleAfterThrow));
check("the failed signal is reported exactly once", throwingSignalLog.length === 1 && throwingSignalLog[0].startsWith("[run-diagnostics]"), JSON.stringify(throwingSignalLog));
check(
  "with a wording the app can show, since the screen may still be busy",
  signalFailedMessage() === throwingSignalLog[0]?.replace("[run-diagnostics] ", "") && signalFailedMessage().includes("界面"),
  signalFailedMessage()
);
/* `signal-failed` is not a store outcome, so it must not answer a question
 * about the store. It used to share `OUTCOME_MESSAGES` with `io-error` and
 * `timeout`, which are facts about the file on disk; a caller asking
 * `outcomeMessage(SIGNAL_FAILED)` then got a sentence about a push, and the
 * next store outcome added to that table would have inherited the confusion. */
const signalMessage = signalFailedMessage();
const lostEvidenceMessage = outcomeMessage({ ok: false, reason: "io-error" });
check("a failed signal is not answered as a store outcome", outcomeMessage(SIGNAL_FAILED) === "", outcomeMessage(SIGNAL_FAILED));
check(
  "and its wording is not the same as the lost-evidence wording",
  lostEvidenceMessage !== "" && signalMessage !== "" && lostEvidenceMessage !== signalMessage,
  `${lostEvidenceMessage} | ${signalMessage}`
);
check(
  "the one log path still says both",
  outcomeLogMessage(SIGNAL_FAILED) === signalMessage && outcomeLogMessage({ ok: false, reason: "io-error" }) === lostEvidenceMessage
);

// A slow disk must not hold the run's exit — but the exit then has to say that
// the evidence is not there yet, or the app would treat a truncated run as clean.
const slowExitLog = [];
const slowExitSeen = [];
const slowExit = await settleRunExit({
  store: { record: () => new Promise(() => {}) },
  repo,
  sessionId: "slow-exit",
  result: limitResult,
  timeoutMs: 80,
  warn: (line) => slowExitLog.push(line),
  signal: (outcome) => slowExitSeen.push(outcome),
});
check("a slow disk does not hold the run's exit", slowExitSeen.length === 1 && slowExit?.reason === "timeout", JSON.stringify(slowExit));
check("and the exit says the evidence did not make it", outcomeMessage(slowExit) !== "", outcomeMessage(slowExit));

// The one outcome that really loses the evidence has to reach the app as
// something it can show: the log drawer opens itself on a line that reads like
// trouble, and a stderr line nobody opens is not the same as saying it.
const lostMessage = outcomeMessage({ ok: false, reason: "io-error" });
check("a lost evidence reports something the app can show", lostMessage.includes("失败"), lostMessage);

/* ---- the wording and the drawer's rule have to agree ----
 * `OUTCOME_MESSAGES` in `run-diagnostics.js` is what the app says about a
 * finished run; `TROUBLE_LINE` in `src/lib/format.ts` is when the run log's
 * drawer opens by itself. The two used to be tied together by a comment on the
 * main-process side only, and that comment was false: `signal-failed` ended on
 * 「界面可能仍显示运行中」, which the rule does not match, so the one line that
 * says *a finished run still looks like it is running* was written to a drawer
 * that stayed shut. That is the silent failure it was written to end.
 *
 * The rule is read out of the renderer's source rather than copied here on
 * purpose: a copy would be changed alongside the drawer and keep this green.
 */
const formatTs = fs.readFileSync(path.join(ROOT, "src/lib/format.ts"), "utf8");
const ruleSrc = /export const TROUBLE_LINE = (\/.*?\/[a-z]*);/.exec(formatTs);
let troubleLine = null;
try {
  troubleLine = ruleSrc ? new Function(`return ${ruleSrc[1]}`)() : null;
} catch (_) {
  troubleLine = null;
}
const opensDrawer = (message) => troubleLine instanceof RegExp && troubleLine.test(message);
check(
  "the drawer's own rule can be read from the renderer",
  troubleLine instanceof RegExp,
  ruleSrc ? ruleSrc[1] : "no `TROUBLE_LINE` in src/lib/format.ts"
);
/* Every wording in both tables, classified once.
 *
 * The checks above ask about the messages they remember — the shape that let
 * `signal-failed` stay unread for a round: the rule lives in the renderer, the
 * wording in the main process, and nothing forced the two to be looked at
 * together. So the tables themselves are the input now. Each reason is declared
 * `trouble` (the drawer must open itself, or the line is written and never read)
 * or `quiet` (`timeout` / `max-rounds` / `drain-failed` say "still writing",
 * which is news a user goes looking for on purpose; opening the drawer on every
 * slow disk is how the lines that matter get skimmed past).
 *
 * A new outcome added to either table arrives unclassified: it fails the first
 * check below and matches neither branch, so `audit:diagnostics` goes red until
 * someone decides which one it is. That is the point — the decision cannot be
 * skipped by not thinking about it.
 */
const DRAWER = {
  "io-error": "trouble",
  "signal-failed": "trouble",
  timeout: "quiet",
  "max-rounds": "quiet",
  "drain-failed": "quiet",
};
for (const [table, messages] of Object.entries({ OUTCOME_MESSAGES, LATE_OUTCOME_MESSAGES })) {
  for (const [reason, message] of Object.entries(messages)) {
    const want = DRAWER[reason];
    check(
      `「${table}.${reason}」 is classified for the log drawer`,
      want === "trouble" || want === "quiet",
      want ? `classified ${want}` : "no entry in this file's DRAWER table"
    );
    if (want === "trouble") {
      check(`「${table}.${reason}」 reads like trouble to the log drawer`, opensDrawer(message), message);
    } else if (want === "quiet") {
      check(`「${table}.${reason}」 is not dressed up as trouble`, !opensDrawer(message), message);
    }
  }
}
// The screen's own line is in neither table (`outcomeMessage` answers nothing
// for it), so it is checked by name — and it is the line this contract was
// written for: it used to end on 「运行中」, which matched nothing.
check("「signal-failed」 reads like trouble to the log drawer", opensDrawer(signalFailedMessage()), signalFailedMessage());
// And no stale declarations: everything classified above still has to be a
// reason one of the tables answers, or the classification outlives it wording.
for (const reason of Object.keys(DRAWER)) {
  if (reason === SIGNAL_FAILED.reason) continue;
  check(
    `the drawer classification has no stale 「${reason}」`,
    reason in OUTCOME_MESSAGES && reason in LATE_OUTCOME_MESSAGES,
    reason
  );
}
/* The other direction, and the one that would bite in daily use: a *healthy*
 * run has to say nothing at all. Both the drawer rule and this file's silence
 * rule rest on "no message means nothing happened" — the moment a normal
 * 「已保存」 line lands in the table, the drawer opens itself on every run and
 * the lines that matter get skimmed past. */
for (const reason of ["clean", "written", "drained"]) {
  const message = outcomeMessage({ ok: true, reason });
  check(`a healthy 「${reason}」 run logs nothing`, message === "" && !opensDrawer(message), JSON.stringify(message));
}

fs.rmSync(unwritableDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) process.exit(1);
