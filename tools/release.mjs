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

// A release commit on top of uncommitted work would ship someone's half-finished
// tree, and the gate afterwards would be testing a mix neither of us can name.
if (capture("git status --porcelain").trim()) {
  console.error("release aborted: the working tree is not clean — commit or stash first");
  process.exit(2);
}

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
