// SPDX-License-Identifier: Apache-2.0
"use strict";

const path = require("path");

// One answer to "is this path inside that root?" for every place that asks:
// the sub-directory picker (`repo:pickInside` in `main.js`) and the worktree
// file reader (`readFileWindow` in `git-service.js`). Both used to spell the
// rule out themselves, and the two spellings disagreed on Windows:
// `startsWith(root + path.sep)` is case-sensitive, so `C:\Repo` did not contain
// `c:\repo\sub` even though the filesystem says it does. That is a product bug,
// not a test gap — a user who typed a different case into the folder dialog (or
// a differently-cased drive path) was told the directory was outside the repo.
//
// `path.relative` already handles "..", sibling prefixes (`/repo` vs `/repo2`)
// and different Windows drives, so the rule is expressed through it instead of
// comparing string prefixes. On Windows the comparison is done on lower-cased
// absolute paths; the relative path handed back to callers is unaffected.
//
// The path API and the case rule are injectable so the Windows answer can be
// checked on Linux with `path.win32` — otherwise the one platform the bug
// happened on would be the one platform a smoke test cannot run on.
function isInside(
  root,
  candidate,
  { pathApi = path, caseInsensitive = process.platform === "win32" } = {}
) {
  if (typeof root !== "string" || typeof candidate !== "string" || root === "" || candidate === "") {
    return false;
  }
  const fold = (value) => {
    const resolved = pathApi.resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const rel = pathApi.relative(fold(root), fold(candidate));
  if (rel === "") return true;
  // `..foo` is a legal child name, so the escape test has to look at whole
  // segments rather than at the two-character prefix. A different drive on
  // Windows comes back absolute, which the last clause catches.
  return rel !== ".." && !rel.startsWith(".." + pathApi.sep) && !pathApi.isAbsolute(rel);
}

module.exports = { isInside };
