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
// moved into release/ by hand — copying never touches the locked directory.
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { releasePrecheck } from "./release-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: node tools/release.mjs <x.y.z>");
  process.exit(2);
}

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
// from the moment it is made. The decisions live in `release-guard.mjs`, where
// `tools/release-guard-smoke.mjs` can feed them one fixture at a time; this is
// the call, and it happens before anything is written.
const pre = releasePrecheck(capture);
if (!pre.ok) {
  console.error(`release aborted: ${pre.error}`);
  process.exit(2);
}
console.log(`releasing ${version} from ${pre.branch}`);

run(`npm version ${version} --no-git-tag-version`);
run(`git add package.json package-lock.json && git commit -m "chore(release): ${version}"`);
run("npm run audit");

const dist = spawnSync("npm run dist:win", { shell: true, cwd: ROOT, stdio: "inherit" });
if (dist.status !== 0) {
  const alt = `release-${version}`;
  console.log(`\ndist:win failed; retrying into ${alt}/ to sidestep a locked win-unpacked.tmp`);
  run(`npx electron-builder --win -c.directories.output=${alt}`);
  const from = path.join(ROOT, alt);
  const to = path.join(ROOT, "release");
  const stale = path.join(to, "win-unpacked");
  if (fs.existsSync(stale)) fs.rmSync(stale, { recursive: true, force: true });
  fs.renameSync(path.join(from, "win-unpacked"), stale);
  for (const f of fs.readdirSync(from)) {
    if (f === "win-unpacked" || f === "builder-debug.yml") continue;
    fs.renameSync(path.join(from, f), path.join(to, f));
  }
  fs.rmSync(from, { recursive: true, force: true });
}

// The packages just rebuilt are the thing the scan has to look at, so it runs
// after packaging, not before.
run("npm run audit:secrets");

console.log(`\nrelease ${version} packaged under release/`);
console.log("remaining, both human acts: git push, then publish a GitHub Release if you want installed clients to update.");
