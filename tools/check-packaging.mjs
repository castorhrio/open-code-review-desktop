// Verifies that every file the packaged app needs is actually in the
// electron-builder `files` allowlist.
//
// `files` is an allowlist, so a new main-process module is silently omitted
// unless someone remembers to add it. The failure only appears in a packaged
// build, where `require("./security")` throws at startup and the app dies
// before it can draw a window — invisible in `npm run dev` and invisible to
// every other check here. `npm run audit:packaging`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = createRequire(path.join(ROOT, "package.json"))("./package.json");
const patterns = pkg.build?.files || [];

const positives = patterns.filter((p) => !p.startsWith("!"));
const negatives = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));

/** Minimal glob matcher — the list only uses exact names and `dir/**`. */
function matches(file, pattern) {
  const norm = (s) => s.replace(/\\/g, "/").replace(/^\.\//, "");
  const f = norm(file);
  const p = norm(pattern);
  if (p.endsWith("/**")) return f === p.slice(0, -3) || f.startsWith(p.slice(0, -2));
  return f === p;
}

function isPackaged(rel) {
  if (negatives.some((n) => matches(rel, n))) return false;
  return positives.some((p) => matches(rel, p));
}

// Walk the main-process entry graph, following relative requires.
const problems = [];
const seen = new Set();
const missingPatterns = [];

function walk(rel) {
  if (seen.has(rel)) return;
  seen.add(rel);

  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`${rel} does not exist`);
    return;
  }
  if (!isPackaged(rel)) problems.push(`${rel} is required at runtime but not matched by build.files`);

  const src = fs.readFileSync(abs, "utf8");
  const re = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    let target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1].replace(/\\/g, "/")));
    if (!path.extname(target)) {
      if (fs.existsSync(path.join(ROOT, target + ".js"))) target += ".js";
      else if (fs.existsSync(path.join(ROOT, target, "index.js"))) target += "/index.js";
      else continue; // a JSON or asset require; the existence check above covers it
    }
    walk(target);
  }
}

for (const entry of ["main.js", "preload.js"]) walk(entry);

// Also flag allowlist entries that match nothing, which usually means a typo or
// a file that was renamed away.
for (const p of positives) {
  if (p.endsWith("/**")) continue;
  if (!fs.existsSync(path.join(ROOT, p))) missingPatterns.push(p);
}

const entryCount = seen.size;
if (missingPatterns.length) problems.push(...missingPatterns.map((p) => `build.files lists "${p}" but it does not exist`));

console.log(`checked ${entryCount} main-process modules against ${positives.length} allowlist patterns`);
for (const rel of [...seen].sort()) {
  console.log(`  ${isPackaged(rel) ? "packaged" : "MISSING "}  ${rel}`);
}

if (problems.length) {
  console.error(`\n${problems.length} packaging problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\npackaging allowlist is complete");
