// One command to cut a release: bump, gate, package, key-scan.
//
//   node tools/release.mjs 0.1.12
//
// WINDOWS ONLY, ON PURPOSE
// Every command below packages a Windows build — `npm run dist:win`, then
// `electron-builder --win` into a fresh dir when the locked `win-unpacked.tmp`
// cannot be renamed — and the fallback moves `win-unpacked` and the two Windows
// artefacts into `release/`. macOS and Linux releases are cut by
// `npm run dist:mac` / `npm run dist:linux` on a machine of that kind. So the
// script refuses a non-Windows machine up front (`parsePlatform`) instead of
// growing a `process.platform` switch that would still move `win-unpacked`.
//
// WHAT THIS DOES NOT DO, ON PURPOSE
// - It does not push. The release commit stays local until a human pushes it;
//   publishing commits and publishing GitHub Releases are shared-state acts.
// - It does not publish a GitHub Release. The auto-update feed reads
//   releases/latest, so installed clients see nothing until a Release exists —
//   which is a separate, explicitly authorized step.
//
// WHY THE FALLBACK EXISTS
// electron-builder assembles the app in <output>/win-unpacked.tmp and renames it
// into place. On this machine that rename has failed with EPERM/EBUSY on a single
// file inside the tmp dir, held by an unidentified external handle (an antivirus
// scan is the likeliest owner; no process in the list admits it). Building to a
// fresh output dir sidesteps the locked path entirely, and the artefacts are then
// moved into release/ by `relocateDistOutput` — a rename out of the temp dir never
// touches the locked path.
//
// What is left in this file is only what can happen nowhere else: spawning the
// commands, and turning their exit status into this process's exit status. What
// the release *decides* (`parseVersion`, `planRelease`, `executeRelease`) and the
// one path that rearranges the disk (`retryDistIntoFallback`) live in modules,
// because a script that starts packaging the moment it is imported cannot be
// called by a check.
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";

import { fallbackOutputDir, retryDistIntoFallback } from "./release-dist.mjs";
import { parsePlatform, parseVersion, planRelease, runRelease, stepFailure } from "./release-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// The machine comes first: a wrong version is a typo that the next run fixes,
// while a wrong machine means not one command below can produce the artefacts
// this path exists to produce. Refused with the two commands that do work there,
// before the precheck and before anything on disk changes.
const platform = parsePlatform(process.platform);
if (!platform.ok) {
  console.error(platform.error);
  process.exit(2);
}

// The version decides the commit message, the output dir and every artefact's
// name, so it is refused here rather than three steps later by `npm version`.
const parsed = parseVersion(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(2);
}
const version = parsed.version;

// The two runners `executeRelease` calls. Everything the release *decides* lives
// in `release-guard.mjs`; what is left here is the part that can only happen on
// this machine — spawning the commands and, for packaging, retrying into a fresh
// output dir when electron-builder cannot rename into the locked one.
//
// A failed command is a *throw* carrying its exit status, not an exit here. The
// throw is the only thing that carries "how far the release got" out of the
// sequence — which steps were already bumped, committed and built — and
// `runRelease` turns it into the one answer this file acts on, below. A runner
// that exited instead would take that record with it, leaving the log to say
// "`npm run audit` exited 1" and nothing about what it had already changed.
const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) throw stepFailure(cmd, r.status);
};
const capture = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" });

// Two states a release must not start from, and both of them fail silently:
// a clean-tree check on a dirty tree ships someone's half-finished work, and a
// detached HEAD gives every step below a place to succeed — the bump, the
// commit, the build — that no branch points at, so the release is unreachable
// from the moment it is made. The decision, and the ordered steps that follow
// it, live in `release-guard.mjs`, where `tools/release-guard-smoke.mjs` can
// call them one fixture at a time. This script only executes the plan — and the
// precheck has refused before a single command is built.
const plan = planRelease({ version, capture });
if (!plan.ok) {
  console.error(`release aborted: ${plan.error}`);
  process.exit(2);
}
console.log(`releasing ${version} from ${plan.branch}`);

const runDist = (step) => {
  console.log(`\n$ ${step.command}`);
  const dist = spawnSync(step.command, { shell: true, cwd: ROOT, stdio: "inherit" });
  if (dist.status === 0) return;
  console.log(`\ndist:win failed; retrying into ${fallbackOutputDir(version)}/ to sidestep a locked win-unpacked.tmp`);
  // Clear, retry, move — in that order, and the order is the whole point: a
  // same-version retry otherwise builds on top of the previous attempt's output
  // and the move then meets names it cannot rename over. That sequence lives in
  // `release-dist.mjs` so `audit:release` can drive it against a fake disk and
  // against a real temp root; a failing retried build throws out of `run` (which
  // the move never reaches), so nothing is moved for a build that produced
  // nothing.
  const { cleared, landed } = retryDistIntoFallback({ version, root: ROOT, run });
  // "top-level" is not padding: a stale `win-unpacked` is one entry and several
  // hundred files, and the number here is entries (`clearStaleDistOutput`'s
  // answer), not everything that was deleted.
  if (cleared.removed.length) {
    console.log(`\ncleared ${cleared.removed.length} stale top-level entr${cleared.removed.length === 1 ? "y" : "ies"} from ${cleared.dir}/`);
  }
  console.log(
    `\nrelocated ${landed.moved.length + 1} into release/` +
      ` (left behind: ${landed.skipped.join(", ") || "nothing"})` +
      (landed.replaced ? ", previous win-unpacked replaced" : "")
  );
};

// The order is the plan's, not this file's. `executeRelease` walks the steps the
// guard built and calls the runner each one needs; the key scan is last because
// it reads the packages the step before it produced. Nothing here re-spells a
// step, so a command cannot drift from the one `audit:release` exercises.
//
// The plan's steps carry a name and a command; the runners below take the
// command, so the adapter is spelled out here rather than making `run` accept a
// shape it does not otherwise know.
//
// `runRelease` never throws: a step that failed comes back as "which steps ran,
// which one failed, and with what exit status", so the release's status is
// decided in exactly one place — here — instead of inside whichever runner
// happened to fail.
const outcome = runRelease(plan, { run: (step) => run(step.command), runDist });
if (!outcome.ok) {
  console.error(`\n${outcome.error}`);
  process.exit(outcome.code ?? 1);
}

console.log(`\nrelease ${version} packaged under release/`);
console.log("remaining, both human acts: git push, then publish a GitHub Release if you want installed clients to update.");
