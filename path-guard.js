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
// comparing string prefixes.
//
// The case fold below is written out on purpose, but it is *not* what makes the
// Windows answer right: `path.win32.relative` already lower-cases both sides
// itself (asserted in `tools/path-guard-smoke.mjs`, together with the fact that
// the answer is the same with the flag off). What fixed the bug was dropping the
// string prefix, then, not a case rule. The fold stays because it states the
// rule in this module rather than in an undocumented internal of the path
// module; if that internal ever changed, this line is the one that would still
// fold. Don't read it as "the flag is what makes Windows work".
//
// The path API and the case rule are injectable so the Windows answer can be
// checked on Linux with `path.win32` — otherwise the one platform the bug
// happened on would be the one platform a smoke test cannot run on.
//
// `caseInsensitive` therefore defaults to `process.platform` **as it was when
// this module loaded**, not to a read inside `isInside`:
//   - whether the filesystem folds case is a property of the machine the app is
//     running on, and it does not change while the process lives, so re-reading
//     `process.platform` per call would be a global read on every path
//     comparison for no new information;
//   - the default is what production gets; the parameter is what a caller (and
//     `tools/path-guard-smoke.mjs`) can override. The smoke test must pass it
//     explicitly together with `pathApi: path.win32` — a Windows answer asserted
//     without it would be asserting the host's rule, i.e. the Linux answer while
//     running on Linux, and the case bug would be back in the untested column.
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
