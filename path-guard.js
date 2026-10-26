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
const CASE_INSENSITIVE_PLATFORM = process.platform === "win32";

// The one normalisation both functions below are built on: absolute, and split
// into named parts. Empty parts are separators, not names — `\\server\share\`
// (what `resolve` returns for a share root) and `\\server\share` have to compare
// equal, and so do `/` and `//`.
const segmentsOf = (value, pathApi, caseInsensitive) => {
  const resolved = pathApi.resolve(value);
  const folded = caseInsensitive ? resolved.toLowerCase() : resolved;
  return folded.split(pathApi.sep).filter((segment) => segment !== "");
};

const usable = (value) => typeof value === "string" && value !== "";

function isInside(root, candidate, { pathApi = path, caseInsensitive = CASE_INSENSITIVE_PLATFORM } = {}) {
  if (!usable(root) || !usable(candidate)) return false;
  const rootSegments = segmentsOf(root, pathApi, caseInsensitive);
  const candidateSegments = segmentsOf(candidate, pathApi, caseInsensitive);
  // A candidate deeper than the root cannot be inside it; a root that is itself
  // a filesystem root (no segments) contains everything under it.
  if (candidateSegments.length < rootSegments.length) return false;
  // Whole-segment prefix compare. A different Windows drive, a different UNC
  // host or share, and a sibling whose name merely starts with the root's name
  // all differ at some segment, so none of them needs a special case here.
  return rootSegments.every((segment, index) => candidateSegments[index] === segment);
}

// `relativeInside` is the *other* question the same callers ask — not "may I
// read this?" but "what is this, relative to the root, in the spelling the rest
// of the app uses?". `repo:pickInside` used to answer it by hand:
//
//   path.relative(root, picked).split(path.sep).join("/") || ""
//
// after an `isInside` guard. Three separate answers were therefore being kept
// in step by hand: whether it is inside, what the relative path is, and which
// of them gets reported when it is not. Only the first had any test behind it
// (`tools/path-guard-smoke.mjs`), which is why this one shape was worth pulling
// out — the same rule, the same caller, one spelling.
//
// The contract, and the reason it is a `null` rather than an empty string:
//
//   root itself            → ""        (empty relPath = "the whole repo"; the
//                                       picker offers that as 留空)
//   an inside subdirectory → "src/a"   (forward slashes on every platform: this
//                                       string is handed to the CLI as `--path`
//                                       and shown in the UI, so a Windows
//                                       backslash here would be a second spelling
//                                       of the same path)
//   anything outside       → null      (the refusal, and it must be
//                                       distinguishable from "" — collapsing the
//                                       two would turn "you picked something
//                                       outside the repo" into "you picked the
//                                       whole repo", silently widening the scan)
//
// The answer is sliced from the **unfolded** segments, so on Windows a user who
// picked `c:\repo\Src\Sub` gets `Src/Sub` and not `src/sub`: the case fold is
// the comparison's business (`isInside`), not the answer's. Segment counts are
// the same folded or not, so the slice indexes line up.
function relativeInside(
  root,
  candidate,
  { pathApi = path, caseInsensitive = CASE_INSENSITIVE_PLATFORM } = {}
) {
  if (!isInside(root, candidate, { pathApi, caseInsensitive })) return null;
  const rootSegments = segmentsOf(root, pathApi, false);
  const candidateSegments = segmentsOf(candidate, pathApi, false);
  return candidateSegments.slice(rootSegments.length).join("/");
}

// The picker's *answer* is one more translation on top of `relativeInside`, and
// it used to live in `main.js` as an `if`/`return` chain. Three answers came out
// of it —
//
//   dialog cancelled      → {}
//   pick outside the repo → { error: "所选目录不在该仓库内" }
//   pick inside           → { relPath }   ("" = the repo itself)
//
// — and only the third was ever exercised by a test. The shapes are what the
// renderer reads (`pickScanDir` in `preload.js`), so "which key is present" is
// the contract; a picker that answered `{ relPath: null }` for an outside
// directory, or `{}` for it, would look like 留空 (the whole repo) instead of a
// refusal. The translation is therefore a pure value here, and
// `tools/path-guard-smoke.mjs` pins all three shapes plus which one must not
// carry the other's key.
//
// `no-repo` is not a pick outcome: the dialog is not opened at all when the app
// has no repository yet. It is here anyway so `main.js` has one place to send
// every branch and neither message is spelled in the registration.
const PICK_INSIDE_KINDS = Object.freeze({
  noRepo: "no-repo",
  cancelled: "cancelled",
  outside: "outside",
  inside: "inside",
});

// The kinds are named once, in the object above, because `pickInsideAnswer`
// decides one and `pickInsidePayload` switches on it — and the two used to spell
// the four strings separately. A typo in either half did not fail: the answer
// came out `{ error: undefined }`, which the renderer reads as "cancelled" (see
// `pickScanDir`), so the 选目录 button looked like it did nothing while the code
// said it had answered. One object makes a misspelt kind a `TypeError` the moment
// the module loads, and `tools/path-guard-smoke.mjs` pins both halves against it.
const PICK_INSIDE_MESSAGES = Object.freeze({
  [PICK_INSIDE_KINDS.noRepo]: "请先选择仓库",
  [PICK_INSIDE_KINDS.outside]: "所选目录不在该仓库内",
});

// "Is this a repository the picker can start in?" — non-empty and absolute.
//
// A relative path cannot come from the folder dialog; it comes from a renderer
// bug (a stale `last-repo` in `localStorage`, a wrong variable), and it matters
// because two things then go wrong at once: `showOpenDialog` would open at the
// process's working directory rather than the user's repo, and `relativeInside`
// would compare a relative root against an absolute pick, so a directory *inside*
// the repo would be refused as 所选目录不在该仓库内. Both are silent product
// behaviour, so the question is asked before the dialog — `main.js` asks it to
// decide whether to open the dialog at all, and `pickInsideAnswer` asks it again
// for direct callers — and `tools/path-guard-smoke.mjs` pins that order.
//
// `path.isAbsolute` is used as the platform's answer on purpose: this is "did the
// renderer hand over a path the OS would open as-is", not a second path rule.
const repoIsPickable = (repo) => usable(repo) && path.isAbsolute(repo);

function pickInsideAnswer(repo, picked, { relativeInside: relative } = {}) {
  if (!repoIsPickable(repo)) {
    return { kind: PICK_INSIDE_KINDS.noRepo, error: PICK_INSIDE_MESSAGES[PICK_INSIDE_KINDS.noRepo] };
  }
  // A cancelled dialog hands over no path (or an empty one), which is not the
  // same as the repo itself: `""` is the inside answer, and answering `{}` here
  // keeps 留空 from being confused with "the user changed their mind".
  if (!usable(picked)) return { kind: PICK_INSIDE_KINDS.cancelled };
  const relPath = (relative || relativeInside)(repo, picked);
  // Reuse the refusal `relativeInside` already documents, rather than re-asking
  // `isInside`: one comparison, one answer, and the injection point above is
  // what proves this function does not re-derive the path itself.
  if (relPath === null) {
    return { kind: PICK_INSIDE_KINDS.outside, error: PICK_INSIDE_MESSAGES[PICK_INSIDE_KINDS.outside] };
  }
  return { kind: PICK_INSIDE_KINDS.inside, relPath };
}

// The IPC shape, kept separate from the decision so the renderer-facing keys are
// pinned as a value. `inside` is the only kind that carries `relPath`; the two
// refusals are the only kinds that carry `error`; a cancelled pick carries
// neither. That mapping is the contract `tools/path-guard-smoke.mjs` reads.
//
// The `default` branch throws instead of falling through to `{ error }`. An
// unknown kind is a programming error — a kind added to the decision and not to
// this switch — and the fall-through used to turn it into `{ error: undefined }`,
// i.e. an answer the renderer reads as "cancelled": a future kind would ship as a
// silent no-op. A pure function can afford to be loud; `tools/path-guard-smoke.mjs`
// pins the throw (and that it names the kind) so the loudness cannot be softened
// back into a fall-through by accident.
function pickInsidePayload(answer) {
  switch (answer && answer.kind) {
    case PICK_INSIDE_KINDS.cancelled:
      return {};
    case PICK_INSIDE_KINDS.inside:
      // Same reasoning one step smaller: `{ kind: "inside" }` without a string
      // relPath would reach the renderer as `{ relPath: undefined }`, which its
      // if-chain reads as a cancel. The decision above never produces that, so
      // meeting it here means the pair has drifted apart.
      if (typeof answer.relPath !== "string") {
        throw new TypeError(
          `pickInsidePayload: an inside answer needs a relPath string, got ${JSON.stringify(answer.relPath)}`
        );
      }
      return { relPath: answer.relPath };
    case PICK_INSIDE_KINDS.outside:
    case PICK_INSIDE_KINDS.noRepo:
      if (typeof answer.error !== "string" || answer.error === "") {
        throw new TypeError(
          `pickInsidePayload: a ${answer.kind} answer needs an error string, got ${JSON.stringify(answer.error)}`
        );
      }
      return { error: answer.error };
    default:
      throw new TypeError(
        `pickInsidePayload: unknown pick kind ${JSON.stringify(answer && answer.kind)}`
      );
  }
}

/* ---------------- the other picker's options ---------------- */

// `repo:pickFile` is the only picker whose *options* carried a decision, and it
// carried them inline in `main.js`:
//
//   title:   (opts && opts.title) || "选择文件"
//   filters: (opts && opts.filters) || [{ name: "所有文件", extensions: ["*"] }]
//
// which meant the answer to "what does a picker with no options open as?" could
// only be read out of a registration. Three of that answer's edges are the
// reason it is a value here, and each of them is a picker the user cannot use:
//
//  - **`filters: []` is not "no filters".** `showOpenDialog` given an empty list
//    shows a picker with no file-type entry, and on Windows one that lists
//    nothing at all — a dialog in which the file the user came to pick cannot be
//    selected. A renderer that builds its list from a variable can hand over an
//    empty array, so empty means 所有文件 instead of being passed through.
//  - **An entry the dialog cannot honour makes the picker throw** from inside a
//    click handler, where nobody is looking. Entries without a name or without
//    any extension are dropped; if nothing survives, the fallback applies.
//  - **Electron documents extensions without the dot** (`md`, not `.md`), so a
//    dot-prefixed name is normalised once here rather than becoming a filter
//    that looks right and matches nothing. `*` stays `*`.
//
// The returned object is what `main.js` spreads into `showOpenDialog`, minus
// `properties` (which is "a file", not a decision). It is a fresh copy on every
// call: a shared frozen literal handed to two callers is one mutation away from
// changing the default for everyone.
const PICK_FILE_DEFAULTS = Object.freeze({
  title: "选择文件",
  buttonLabel: "选择此文件",
  filter: Object.freeze({ name: "所有文件", extensions: Object.freeze(["*"]) }),
});

// Normalised once, then deduplicated: `["md", ".md", " md "]` is one entry, and a
// list repeated by a renderer building it from a variable is the same filter the
// dialog would have been given twice. Exact duplicates only — `MD` and `md` are
// two entries on a case-sensitive filesystem, and folding them would be a rule
// about the user's file names, not about the dialog.
const extensionsOf = (value) => {
  if (!Array.isArray(value)) return [];
  const extensions = value
    .filter((extension) => typeof extension === "string")
    .map((extension) => extension.trim().replace(/^\.+/, ""))
    .filter((extension) => extension !== "");
  return [...new Set(extensions)];
};

const filterOf = (entry) => {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const extensions = extensionsOf(entry.extensions);
  if (name === "" || extensions.length === 0) return null;
  return { name, extensions };
};

const defaultFilter = () => ({
  name: PICK_FILE_DEFAULTS.filter.name,
  extensions: [...PICK_FILE_DEFAULTS.filter.extensions],
});

function pickFileOptions(opts) {
  const asked = opts && typeof opts === "object" ? opts : {};
  const title =
    typeof asked.title === "string" && asked.title.trim() !== ""
      ? asked.title.trim()
      : PICK_FILE_DEFAULTS.title;
  const filters = Array.isArray(asked.filters) ? asked.filters.map(filterOf).filter(Boolean) : [];
  return {
    title,
    buttonLabel: PICK_FILE_DEFAULTS.buttonLabel,
    filters: filters.length ? filters : [defaultFilter()],
  };
}

module.exports = {
  isInside,
  relativeInside,
  repoIsPickable,
  pickInsideAnswer,
  pickInsidePayload,
  pickFileOptions,
  PICK_INSIDE_KINDS,
  PICK_INSIDE_MESSAGES,
  PICK_FILE_DEFAULTS,
};
