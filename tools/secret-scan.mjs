// The API key must never reach a commit or a package.
//
// The CLI keeps its key in `~/.opencodereview/config.json`, outside the
// repository, so the normal path is safe. The risk is the abnormal one: a
// pasted key in a fixture, a debug dump, a copied config, a `.env` that gets
// force-added. Those are exactly the files nobody looks at again.
//
// So this reads the *live* key out of the CLI's own config and looks for that
// exact string in (a) the working tree, which is what would be pushed, and
// (b) the packaged app, which is what would be downloaded. Matching one exact
// 35-character string rather than a `sk-…` pattern is deliberate: the pattern
// matches `mask-image` in tailwind-merge, Skia symbols in Electron and Go
// runtime strings in the CLI binary, and a check that cries wolf gets ignored.
//
// The key is never passed on a command line — it is read and compared in memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = path.join(os.homedir(), ".opencodereview", "config.json");

const passed = [];
const failed = [];
const check = (name, ok, detail) => {
  (ok ? passed : failed).push(name);
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
};

if (!fs.existsSync(CONFIG)) {
  // Not a pass and not a failure: there is nothing to look for, and saying so
  // is the honest outcome. (A check that reports "0 problems" without saying
  // what it examined manufactures confidence rather than providing it.)
  console.log("note: no ~/.opencodereview/config.json on this machine, so there is no live key to search for");
  console.log("\n0 ok, 0 failed  (nothing to scan)");
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const secrets = [];
for (const [provider, cfg] of Object.entries(config.providers || {})) {
  if (cfg && typeof cfg.api_key === "string" && cfg.api_key.length >= 12) {
    secrets.push({ provider, value: cfg.api_key });
  }
}
check("found at least one provider key to search for", secrets.length > 0, secrets.length ? secrets.map((s) => s.provider).join(", ") : "config.json has providers but no api_key");

// Anything larger than this is a binary we still want to scan, but a stray
// multi-gigabyte file would make the check useless as a gate.
const MAX = 256 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "out", "release-build", "release-verify"]);

function scanTree(dir, hits) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(d, e.name));
        continue;
      }
      const p = path.join(d, e.name);
      let buf;
      try {
        const st = fs.statSync(p);
        if (st.size > MAX) continue;
        buf = fs.readFileSync(p);
      } catch {
        continue;
      }
      files++;
      bytes += buf.length;
      const text = buf.toString("latin1");
      for (const s of secrets) {
        if (text.includes(s.value)) hits.push({ file: path.relative(ROOT, p), provider: s.provider });
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

// (a) What would be pushed.
const treeHits = [];
const tree = scanTree(ROOT, treeHits);
check(
  "the working tree contains no live API key",
  treeHits.length === 0,
  treeHits.length ? treeHits.map((h) => `${h.provider} key in ${h.file}`).join("; ") : `scanned ${tree.files} files`
);

// (b) What would be downloaded. The packaged app is the thing a user actually
// runs, and it is built from the tree above — so this is the belt to that
// check's braces, and it is the one that would have caught a key baked into the
// bundle by a build step.
const releaseDir = path.join(ROOT, "release");
if (fs.existsSync(releaseDir)) {
  const pkgHits = [];
  const pkg = scanTree(releaseDir, pkgHits);
  // The installers themselves are compressed, so scan the loose artifacts and
  // the unpacked app; a key inside the app payload cannot be compressed away.
  for (const f of fs.readdirSync(releaseDir)) {
    if (!/\.(exe|yml)$/.test(f)) continue;
    const p = path.join(releaseDir, f);
    let buf;
    try {
      if (fs.statSync(p).size > MAX) continue;
      buf = fs.readFileSync(p);
    } catch {
      continue;
    }
    const text = buf.toString("latin1");
    for (const s of secrets) if (text.includes(s.value)) pkgHits.push({ file: `release/${f}`, provider: s.provider });
  }
  check(
    "the built packages contain no live API key",
    pkgHits.length === 0,
    pkgHits.length ? pkgHits.map((h) => `${h.provider} key in ${h.file}`).join("; ") : `scanned ${pkg.files} files under release/`
  );
} else {
  console.log("note: release/ does not exist, so only the tree was scanned");
}

console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) {
  console.error(`\nsecret scan failed: ${failed.join(", ")}`);
  process.exit(1);
}
