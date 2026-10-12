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

// Guard against a silently empty page: every harness should assert it actually
// rendered something before reporting success.
export function requireBuilt() {
  const index = path.resolve(import.meta.dirname, "../../out/index.html");
  if (!fs.existsSync(index)) {
    console.error(`No build found at ${index}. Run \`npm run build\` first.`);
    process.exit(2);
  }
  return index;
}
