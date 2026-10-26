// One command to cut a release: bump, gate, package, key-scan.
//
//   node tools/release.mjs 0.1.12
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
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";

import { relocateDistOutput } from "./release-dist.mjs";
import { executeRelease, planRelease } from "./release-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: node tools/release.mjs <x.y.z>");
  process.exit(2);
}

// The two runners `executeRelease` calls. Everything the release *decides* lives
// in `release-guard.mjs`; what is left here is the part that can only happen on
// this machine — spawning the commands and, for packaging, retrying into a fresh
// output dir when electron-builder cannot rename into the locked one.
const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\nrelease aborted: \`${cmd}\` exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
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
  const command = step.command;
  console.log(`\n$ ${command}`);
  const dist = spawnSync(command, { shell: true, cwd: ROOT, stdio: "inherit" });
  if (dist.status === 0) return;
  const alt = `release-${version}`;
  console.log(`\ndist:win failed; retrying into ${alt}/ to sidestep a locked win-unpacked.tmp`);
  run(`npx electron-builder --win -c.directories.output=${alt}`);
  // The move itself lives in `release-dist.mjs`, where `audit:release` can drive
  // it against a fake disk: the order (stale dir out, then the new one in, then
  // the rest of the files, then the fallback dir last) is the whole point of this
  // path, and it is not something this script can be asked to prove.
  const landed = relocateDistOutput({ from: path.join(ROOT, alt), to: path.join(ROOT, "release") });
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
executeRelease(plan, { run: (step) => run(step.command), runDist });

console.log(`\nrelease ${version} packaged under release/`);
console.log("remaining, both human acts: git push, then publish a GitHub Release if you want installed clients to update.");
