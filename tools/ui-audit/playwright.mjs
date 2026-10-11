// Playwright is intentionally *not* a project dependency: installing it pulls a
// browser toolchain the app itself never needs, and these harnesses drive the
// system Edge/Chrome instead of a downloaded Chromium. So resolve it from
// wherever it happens to live, in order of least surprise:
//
//   1. PLAYWRIGHT_MODULE — an explicit path, for CI or a custom checkout.
//   2. The project's own node_modules, for anyone who ran `npm i -D playwright`.
//   3. A global install, via NODE_PATH.
//
// If none of them work we say exactly what to run rather than throwing a bare
// MODULE_NOT_FOUND from three frames deep.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE,
  path.resolve(import.meta.dirname, "../../node_modules/"),
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
