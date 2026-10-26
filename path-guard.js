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
// Two things were wrong with the old spelling and both are fixed here on purpose:
//
//  1. **String prefixes, not whole segments.** `/repo` vs `/repo2`, and a UNC
//     root that `resolve` hands back with a trailing separator
//     (`\\server\share\`), are the shapes a prefix test gets wrong while looking
//     right for the case the author had in mind.
//  2. **An implicit case rule.** The first fix of the Windows bug leaned on the
//     fact that `path.win32.relative` lower-cases both sides itself; the
//     `caseInsensitive` flag was therefore decorative — the answer was the same
//     with the flag off. A flag nobody can turn off is not a rule, it is a
//     comment, and the next person to switch away from `relative` would have
//     silently turned the Windows bug back on.
//
// So the rule is stated here, in full, and the platform only supplies path
// syntax:
//
//   resolve both sides → (if the platform folds case) lower-case both sides →
//   compare whole segments from the first one on.
//
// That is the entire rule. It does not go through `path.relative` (whose case
// behaviour is an internal of the path module, not our rule) and it does not go
// through a string prefix. `tools/path-guard-smoke.mjs` pins the three
// consequences that can regress separately: the flag off means case-sensitive,
// the answer is the same whether or not a `pathApi.relative` exists at all, and
// the UNC / `\\?\` long-path shapes still answer correctly.
//
// `resolve` is called before the split so `..` and `.` are already gone, and the
// segment list drops empty ones so a leading or trailing separator (a share
// root's, a `/` root's) cannot decide the answer.
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
  // Empty segments are separators, not names: `\\server\share\` (what `resolve`
  // returns for a share root) and `\\server\share` have to compare equal, and so
  // do `/` and `//`.
  const segmentsOf = (value) => {
    const resolved = pathApi.resolve(value);
    const folded = caseInsensitive ? resolved.toLowerCase() : resolved;
    return folded.split(pathApi.sep).filter((segment) => segment !== "");
  };
  const rootSegments = segmentsOf(root);
  const candidateSegments = segmentsOf(candidate);
  // A candidate deeper than the root cannot be inside it; a root that is itself
  // a filesystem root (no segments) contains everything under it.
  if (candidateSegments.length < rootSegments.length) return false;
  // Whole-segment prefix compare. A different Windows drive, a different UNC
  // host or share, and a sibling whose name merely starts with the root's name
  // all differ at some segment, so none of them needs a special case here.
  return rootSegments.every((segment, index) => candidateSegments[index] === segment);
}

module.exports = { isInside };
