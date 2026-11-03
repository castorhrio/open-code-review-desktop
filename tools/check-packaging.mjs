// Verifies that every file the packaged app needs is actually in the
// electron-builder `files` allowlist.
//
// Two ways to fall outside it, and both are silent in `npm run dev`:
//
//   1. a module that *is* required at runtime; `main.js` says
//      `require("./security")` and the packaged app dies before it can draw a
//      window, because `security.js` was never added to `files`;
//   2. a module that is loaded by a path no static `require` spells — a
//      `path.join(__dirname, …)` handed to a child process, or a brand-new root
//      module nothing requires yet. The require graph below cannot see it, so it
//      would be shipped as "not needed" and only fail the day something starts
//      using it.
//
// So the answer is two questions, not one: scan the entry graph from
// `main.js` / `preload.js` and check every module it reaches, *and* require every
// root-level `*.js` to be in the allowlist regardless of whether anything
// requires it. A root `.js` that is genuinely not runtime belongs under
// `tools/`, and the failure says so.
//
// "Scan" is the accurate word, and the difference matters: the require edges
// are found by a regular expression over the source text — not by an AST, and
// not by running anything. So a module loaded by a *computed* path
// (`require(`./x`)`, `require("./" + "x")`) is invisible to it: the file never
// enters the graph, so it is not "required at runtime" as far as the gate
// knows. That hole is written down as an assertion instead of a comment —
// `tools/check-packaging-smoke.mjs` pins both halves of it (a literal require
// *is* followed, a computed one is not), so the day somebody teaches the scan
// to follow computed requires, the two facts change together with the
// mitigation they imply. The mitigation that exists today: a computed require
// of a *root-level* module is still caught by the root sweep (with its own
// wording), while a computed require of a module in a subdirectory is not
// caught at all. Hence: runtime requires stay literal.
//
// The very same function is what `tools/check-packaging-smoke.mjs` points at a
// fixture with one allowlist line removed, so "this gate can go red" is asserted
// rather than assumed. `npm run audit:packaging`.
//
// The second question this file answers is not about `build.files` at all but
// about the same worry one layer down — "will the packaged app find its files" —
// and it is asked of `package-lock.json`: the six platform binaries the wrapped
// CLI ships as optional dependencies each need a resolved entry. See
// `findLockfilePlatformProblems` for the failure that put it here.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

// The packaged entry points. `preload.js` is not `require`d by `main.js` (it is
// named in a `webPreferences` object), which is why it is listed here by hand.
export const DEFAULT_ENTRIES = Object.freeze(["main.js", "preload.js"]);

/** Minimal glob matcher — the list only uses exact names and `dir/**`. */
export const matchesPattern = (file, pattern) => {
  const norm = (s) => s.replace(/\\/g, "/").replace(/^\.\//, "");
  const f = norm(file);
  const p = norm(pattern);
  if (p.endsWith("/**")) return f === p.slice(0, -3) || f.startsWith(p.slice(0, -2));
  return f === p;
};

/** `build.files` as one predicate: positives, minus the `!` exclusions. */
export const allowlistMatcher = (patterns) => {
  const positives = patterns.filter((p) => !p.startsWith("!"));
  const negatives = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return (rel) =>
    !negatives.some((n) => matchesPattern(rel, n)) && positives.some((p) => matchesPattern(rel, p));
};

// The whole answer: which modules are reached, which root modules exist, and
// every problem found. `root` is a parameter so the smoke test can hand in a
// fixture directory instead of this repository.
export const findPackagingProblems = ({ root = ROOT, patterns, entries = DEFAULT_ENTRIES }) => {
  const isPackaged = allowlistMatcher(patterns);
  const problems = [];
  const seen = new Set();

  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);

    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      problems.push(`${rel} does not exist`);
      return;
    }
    if (!isPackaged(rel)) problems.push(`${rel} is required at runtime but not matched by build.files`);

    const src = fs.readFileSync(abs, "utf8");
    const re = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      let target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), m[1].replace(/\\/g, "/"))
      );
      if (!path.extname(target)) {
        if (fs.existsSync(path.join(root, target + ".js"))) target += ".js";
        else if (fs.existsSync(path.join(root, target, "index.js"))) target += "/index.js";
        else continue; // a JSON or asset require; the existence check above covers it
      }
      walk(target);
    }
  };

  for (const entry of entries) walk(entry);

  // Every root-level `*.js` has to be in the allowlist, whether or not the walk
  // reached it. Reachable-and-missing was already reported (with a message that
  // names the require), so this one is about the module the walk cannot see.
  const rootModules = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort();
  for (const rel of rootModules) {
    if (seen.has(rel) || isPackaged(rel)) continue;
    problems.push(
      `root module ${rel} is in neither the require graph nor build.files — add it to build.files ` +
        `(it is loaded by a path the walk cannot follow), or move it under tools/ if it is not runtime`
    );
  }

  // Allowlist entries that match nothing, which usually means a typo or a file
  // that was renamed away.
  for (const p of patterns.filter((entry) => !entry.startsWith("!"))) {
    if (p.endsWith("/**")) continue;
    if (!fs.existsSync(path.join(root, p))) {
      problems.push(`build.files lists "${p}" but it does not exist`);
    }
  }

  return { problems, checked: [...seen].sort(), rootModules };
};

// ---- the other half of "the packaged app finds its files": the platform binaries
//
// `@alibaba-group/open-code-review` ships its `ocr` binary as six optional
// platform packages (`ocr-darwin-arm64` … `ocr-win32-x64`), and npm installs only
// the one matching the host — which is why `build/fetch-binaries.cjs` exists for
// cross-platform builds. What is checked here is the *lockfile* half: the parent
// entry declares all six in `optionalDependencies`, so every one of them must
// have a resolved entry of its own.
//
// The failure this was written for is real and silent. Regenerating
// `package-lock.json` for the v1.13.5 bump on this machine dropped
// `ocr-darwin-x64`: the declaration stayed, the resolution did not. Nothing in
// the repository noticed, because the host is linux/x64 and that package is not
// installed here anyway — it would have surfaced as `npm ci` failing on a macOS
// x64 machine, i.e. on the one platform nobody has ever built. A hole that only
// opens on an unbuilt platform is exactly the kind that stays open, so it is
// asserted from the declaration side instead of from the host side.
export const OCR_PACKAGE = "@alibaba-group/open-code-review";

export const findLockfilePlatformProblems = ({ lock, parent = OCR_PACKAGE }) => {
  const problems = [];
  const parentEntry = lock?.packages?.[`node_modules/${parent}`];
  if (!parentEntry) return [`package-lock.json has no entry for ${parent}`];

  const declared = parentEntry.optionalDependencies || {};
  const names = Object.keys(declared).sort();
  if (names.length === 0) {
    // Vacuous-green guard: with nothing declared, the loop below would report
    // "no problems" while reading nothing at all.
    problems.push(
      `${parent} declares no optionalDependencies in package-lock.json — the platform binaries are ` +
        `resolved from that list, so an empty one leaves this check reading nothing`
    );
    return problems;
  }

  for (const name of names) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) {
      problems.push(
        `package-lock.json declares ${name}@${declared[name]} as an optional dependency of ${parent} ` +
          `but has no resolved entry for it — \`npm ci\` on that platform installs nothing and the ` +
          `packaged app finds no binary`
      );
      continue;
    }
    if (entry.version !== declared[name]) {
      problems.push(
        `${name} is declared at ${declared[name]} but resolved at ${entry.version} — the lockfile ` +
          `would install a binary the parent did not ask for`
      );
    }
    if (!entry.resolved || !entry.integrity) {
      problems.push(
        `${name} has no ${entry.resolved ? "integrity" : "resolved"} in package-lock.json — an entry ` +
          `without both cannot be installed reproducibly`
      );
    }
  }

  return problems;
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  const pkg = createRequire(path.join(ROOT, "package.json"))("./package.json");
  const patterns = pkg.build?.files || [];
  const positives = patterns.filter((p) => !p.startsWith("!"));
  const { problems, checked, rootModules } = findPackagingProblems({ patterns });
  const isPackaged = allowlistMatcher(patterns);

  console.log(
    `checked ${checked.length} main-process modules and ${rootModules.length} root *.js files ` +
      `against ${positives.length} allowlist patterns`
  );
  for (const rel of checked) {
    console.log(`  ${isPackaged(rel) ? "packaged" : "MISSING "}  ${rel}`);
  }

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const platformProblems = findLockfilePlatformProblems({ lock });
  const declaredPlatforms = Object.keys(
    lock.packages?.[`node_modules/${OCR_PACKAGE}`]?.optionalDependencies || {}
  ).sort();
  console.log(
    `checked ${declaredPlatforms.length} platform binaries declared by ${OCR_PACKAGE} in package-lock.json`
  );
  for (const name of declaredPlatforms) {
    const entry = lock.packages?.[`node_modules/${name}`];
    console.log(`  ${entry ? "resolved" : "MISSING "}  ${name}${entry ? `@${entry.version}` : ""}`);
  }

  const all = [...problems, ...platformProblems];
  if (all.length) {
    console.error(`\n${all.length} packaging problem(s):`);
    for (const p of all) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\npackaging allowlist is complete, and every platform binary is resolved");
}
