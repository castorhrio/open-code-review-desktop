// SPDX-License-Identifier: Apache-2.0
"use strict";
/*
 * Keep only the ocr binary the target actually runs.
 *
 * `build/fetch-binaries.cjs` puts all six platform binaries under
 * `node_modules/@alibaba-group/ocr-*` so a single machine can package for any
 * OS. electron-builder then copies *all* of node_modules into every package,
 * which would add ~270 MB of binaries a given build can never execute.
 *
 * This hook runs after the app is assembled in `appOutDir` and before the
 * installer/dmg/AppImage is produced, so the pruning is what actually ships.
 * asar is disabled, so the app tree is plain files at `resources/app`.
 */

const fs = require("fs");
const path = require("path");

// builder-util's Arch enum
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function keepFor(electronPlatformName, arch) {
  if (electronPlatformName === "darwin") {
    // A universal build must keep both slices.
    return arch === "universal" ? ["darwin-x64", "darwin-arm64"] : [`darwin-${arch}`];
  }
  if (electronPlatformName === "linux") return [`linux-${arch}`];
  if (electronPlatformName === "win32") return [`win32-${arch}`];
  return null;
}

module.exports = async function afterPack(context) {
  const arch = ARCH_NAMES[context.arch] || process.arch;
  const keep = keepFor(context.electronPlatformName, arch);
  if (!keep) return;

  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const scope = path.join(resourcesDir, "app", "node_modules", "@alibaba-group");
  if (!fs.existsSync(scope)) {
    console.log(`[after-pack] no @alibaba-group scope at ${scope}, nothing to prune`);
    return;
  }

  const removed = [];
  for (const entry of fs.readdirSync(scope)) {
    if (!entry.startsWith("ocr-")) continue;
    const key = entry.slice("ocr-".length);
    if (keep.includes(key)) continue;
    fs.rmSync(path.join(scope, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  console.log(
    `[after-pack] ${context.electronPlatformName}/${arch}: kept ${keep.join(", ")}` +
      (removed.length ? `, removed ${removed.join(", ")}` : "")
  );
};

// electron-builder accepts either a bare function or a `default` export.
module.exports.default = module.exports;
