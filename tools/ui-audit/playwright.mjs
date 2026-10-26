// Playwright is intentionally *not* a project dependency: installing it pulls a
// browser toolchain the app itself never needs, and these harnesses drive the
// system Edge/Chrome instead of a downloaded Chromium. So resolve it from
// wherever it happens to live, in order of least surprise:
//
//   1. PLAYWRIGHT_MODULE — an explicit path, for CI or a custom checkout.
//   2. The project's own node_modules, for anyone who ran `npm i -D playwright`.
//   3. The npm global root, for `npm i -g playwright`.
//   4. NODE_PATH.
//
// If none of them work we say exactly what to run rather than throwing a bare
// MODULE_NOT_FOUND from three frames deep.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The npm global root, so a `npm i -g playwright` is enough to run these
// harnesses. Without it the only auto-discovered path was the project's own
// node_modules, which by design does not carry Playwright — and the resolver
// silently fell through to "not installed" on any machine that had it globally,
// which is how the whole visual suite came to be unrun while the layout drifted.
function globalModuleRoot() {
  if (process.platform === "win32") return process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : "";
  try {
    return execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch (_) {
    return "";
  }
}

const CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE,
  path.resolve(import.meta.dirname, "../../node_modules/"),
  globalModuleRoot(),
  process.env.NODE_PATH,
].filter(Boolean);

export async function loadPlaywright() {
  const tried = [];
  for (const base of CANDIDATES) {
    try {
      const require = createRequire(path.join(base, "noop.js"));
      const mod = require("playwright");
      if (mod?.chromium) return mod;
    } catch (err) {
      tried.push(`${base} (${err.code || err.message})`);
    }
  }
  console.error(
    [
      "Cannot load Playwright, which these harnesses need to drive a browser.",
      "",
      "Install it into the project:   npm i -D playwright",
      "or point at an existing copy:  PLAYWRIGHT_MODULE=/path/to/node_modules/ npm run audit:ui",
      "",
      "Searched:",
      ...tried.map((t) => `  - ${t}`),
    ].join("\n")
  );
  process.exit(2);
}

// Which browser binary to drive. The system channel avoids a ~150MB Chromium
// download; override with PW_CHANNEL if the machine has a different one.
export const CHANNEL = process.env.PW_CHANNEL || "msedge";

export function describeChannel() {
  return CHANNEL === "msedge" || CHANNEL === "chrome"
    ? `system ${CHANNEL}`
    : `bundled/${CHANNEL}`;
}

// Newest mtime under a file or a directory, so a build can be compared with the
// sources it claims to be built from. `skip` holds absolute paths of run
// artefacts — `tools/ui-audit/shots/` is written *by* a run, so counting it would
// make the run after any audit refuse the bundle that audit just went green on.
function newestMtime(target, skip = new Set()) {
  if (skip.has(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(path.join(target, entry.name), skip));
  }
  return newest;
}

// Everything a green UI audit is a statement about. `src/` is the renderer;
// `tools/ui-audit/` is the fixtures and assertions that read it — an edited
// fixture audited against the previous bundle is exactly the blind spot this
// check exists to close, and it opened when the build moved out of these
// harnesses' own command lines; `vite.config.mjs` decides how `src/` is bundled.
function auditedSources(root) {
  return [
    { label: "src/", path: path.join(root, "src") },
    { label: "tools/ui-audit/", path: path.join(root, "tools/ui-audit") },
    { label: "vite.config.mjs", path: path.join(root, "vite.config.mjs") },
  ].filter((source) => fs.existsSync(source.path));
}

// Guard against a silently empty page: every harness should assert it actually
// rendered something before reporting success.
//
// It also refuses a bundle older than the sources above. `npm run audit` now
// builds once and hands that build to four harnesses instead of rebuilding in
// each of them, so the failure mode the old prefixes ruled out by construction is
// now this check's job: a UI audit run against the previous edit's bundle reports
// the layout of code that no longer exists, and reports it green. The build
// writes `out/index.html`, so its mtime is the fact to compare.
export function requireBuilt() {
  const root = path.resolve(import.meta.dirname, "../..");
  const index = path.join(root, "out/index.html");
  if (!fs.existsSync(index)) {
    console.error(`No build found at ${index}. Run \`npm run build\` first (\`npm run audit\` builds once for all of them).`);
    process.exit(2);
  }
  const builtAt = fs.statSync(index).mtimeMs;
  const skip = new Set([path.join(root, "tools/ui-audit/shots")]);
  let newest = { label: "sources", mtime: 0 };
  for (const source of auditedSources(root)) {
    const mtime = newestMtime(source.path, skip);
    if (mtime > newest.mtime) newest = { label: source.label, mtime };
  }
  if (newest.mtime > builtAt) {
    console.error(
      [
        `out/ is older than ${newest.label} — this harness would audit the previous build and report it green.`,
        `  build:     ${new Date(builtAt).toISOString()}`,
        `  ${newest.label.padEnd(10)} ${new Date(newest.mtime).toISOString()}`,
        "Run `npm run build` first, or `npm run audit`, which builds once for every harness.",
      ].join("\n")
    );
    process.exit(2);
  }
  return index;
}
