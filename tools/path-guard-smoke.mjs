// Pins the one rule both path callers now share.
//
// There used to be two spellings of "is this inside the repo?": the folder
// picker compared `picked.startsWith(root + sep)` and the worktree reader
// compared `abs.startsWith(root)`. Both are case-sensitive on Windows, so
// `C:\Repo` rejected `c:\repo\sub` — the same directory the filesystem would
// happily open. They also had to be kept in sync by hand, which is how the two
// answers drifted. `path-guard.js` is now the one implementation, and this
// suite asserts the four basic answers, the Windows case answer (via
// `path.win32`, so it runs on Linux), the two path shapes a hand-rolled prefix
// comparison gets wrong without anyone noticing — a UNC share root and the
// `\\?\` long-path prefix — and that both call sites actually use it.
//
// Round 64 adds the *other* question the same picker asks: not "is this inside?"
// but "what is this, relative to the root?". `relativeInside` answers it, and the
// block below pins its three-way contract — `""` for the repo itself, a
// forward-slash `relPath` for a subdirectory, `null` for anything outside —
// because collapsing the first and the third would silently turn "outside the
// repo" into "the whole repo".
//
// Run with `npm run audit:path`.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const {
  isInside,
  relativeInside,
  repoIsPickable,
  pickedRepoOrEmpty,
  pickInsideAnswer,
  pickInsidePayload,
  pickFileOptions,
  PICK_INSIDE_KINDS,
  PICK_INSIDE_MESSAGES,
  PICK_FILE_DEFAULTS,
} = require(path.join(ROOT, "path-guard.js"));
const gitSvc = require(path.join(ROOT, "git-service.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- the four answers, on the current platform ---- */
{
  check("the same directory is inside", isInside("/repo", "/repo"));
  check("a subdirectory is inside", isInside("/repo", "/repo/src"));
  check("a sibling with the root as a string prefix is outside", !isInside("/repo", "/repo2"));
  check("a `..` escape is outside", !isInside("/repo", "/repo/../etc"));
  check("an absolute path outside is outside", !isInside("/repo", "/etc"));
  check(
    "a child whose name begins with '..' is still inside",
    isInside("/repo", "/repo/..well"),
    "the escape test looks at whole segments, not the '..' prefix"
  );
  check(
    "off Windows the comparison stays case-sensitive",
    !isInside("/Repo", "/repo/sub")
  );
  check("an empty root or candidate is refused", !isInside("", "/repo") && !isInside("/repo", ""));
}

/* ---- the Windows answer the bug was about ---- */
{
  const win = { pathApi: path.win32, caseInsensitive: true };
  check(
    "Windows: C:\\Repo contains c:\\repo\\sub regardless of case",
    isInside("C:\\Repo", "c:\\repo\\sub", win)
  );
  check(
    "Windows: C:\\Repo and C:\\REPO are the same directory",
    isInside("C:\\Repo", "C:\\REPO", win)
  );
  check(
    "Windows: a sibling sharing the prefix is still outside",
    !isInside("C:\\Repo", "C:\\Repo2\\sub", win)
  );
  check("Windows: a different drive is outside", !isInside("C:\\Repo", "D:\\repo", win));
  check(
    "Windows: a drive root contains every directory on that drive",
    isInside("C:\\", "C:\\repo\\sub", win) && !isInside("C:\\", "D:\\repo", win),
    "the rule has to answer for a root with no segments of its own"
  );
}

/* ---- the flag now *decides* the case answer, it does not describe it ----
 * Round 61 recorded that `path.win32.relative` lower-cases both sides itself,
 * so the Windows answer came from the path module while the `caseInsensitive`
 * flag was decorative: the answer was the same with the flag off. That is a flag
 * nobody can turn off, i.e. a comment. It is load-bearing now — the fold happens
 * in `path-guard.js` — and these three checks are what keep it that way. Without
 * them a future implementation could quietly fall back to `relative` and the
 * Windows bug would come back with every check still green.
 */
{
  const sensitive = { pathApi: path.win32, caseInsensitive: false };
  check(
    "flag off: a differently-cased child path is outside",
    !isInside("C:\\Repo", "c:\\repo\\sub", sensitive),
    "this is the assertion round 61 could not make, and it is the one that makes the flag real"
  );
  check(
    "...and the identically-cased child is still inside with the flag off",
    isInside("C:\\Repo", "C:\\Repo\\sub", sensitive),
    "flag off must mean case-sensitive, not 'refuse everything'"
  );
  check(
    "...and the fold is applied to both sides, not just to the candidate",
    !isInside("c:\\repo", "C:\\Repo\\sub", sensitive) &&
      isInside("c:\\repo", "c:\\repo\\sub", sensitive),
    "a rule that folded one side only would pass the check above but fail this one"
  );

  // Independence from `path.relative` is asserted by handing the rule a path API
  // whose `relative` *throws*: if the answer still comes out (correctly, both
  // with the flag on and off), the case answer cannot be coming from that
  // internal. That is stronger than re-checking what Node's `relative` does
  // today, which is Node's business and can change under us.
  const noRelative = {
    sep: path.win32.sep,
    resolve: (value) => path.win32.resolve(value),
    relative: () => {
      throw new Error("isInside must not go through path.relative");
    },
  };
  let relativeCalls = 0;
  const counted = {
    sep: path.win32.sep,
    resolve: (value) => path.win32.resolve(value),
    // Answers "" (= "same directory") so that using it would make the check
    // below pass for the wrong reason; the counter is what makes it red.
    relative: () => {
      relativeCalls += 1;
      return "";
    },
  };
  check(
    "the rule answers without path.relative at all (flag on: inside, flag off: outside)",
    isInside("C:\\Repo", "c:\\repo\\sub", { pathApi: noRelative, caseInsensitive: true }) === true &&
      isInside("C:\\Repo", "c:\\repo\\sub", { pathApi: noRelative, caseInsensitive: false }) === false,
    "so the case answer is this module's rule, not an undocumented folding inside path.relative"
  );
  const countedAnswer = isInside("C:\\Repo", "c:\\repo\\sub", {
    pathApi: counted,
    caseInsensitive: true,
  });
  check(
    "...and it never calls path.relative even once",
    countedAnswer === true && relativeCalls === 0,
    `answer=${countedAnswer} calls=${relativeCalls}`
  );
}

/* ---- UNC roots and the `\\?\` long-path prefix ----
 * A prefix rule (`root + sep` / `startsWith(root)`) gets these wrong in ways
 * nobody notices, because both shapes normalise differently from a drive path:
 * `path.win32.resolve` turns a share root into `\\server\share\` (trailing
 * separator) and leaves `\\?\` in place. The segment rule is immune to both —
 * a trailing separator is an empty segment and is dropped — and the two
 * normalisations are still asserted below, because they are what made the string
 * prefix rule look correct while it was wrong. If a future Node changed them,
 * the rule's answer is what this block is about, not the normalisation, so the
 * check would say which of the two moved.
 */
{
  const win = { pathApi: path.win32, caseInsensitive: true };
  check(
    "Windows: a UNC share root contains its subdirectory",
    isInside("\\\\server\\share\\repo", "\\\\server\\share\\repo\\sub", win)
  );
  check(
    "Windows: a UNC path is compared case-insensitively too, host and share included",
    isInside("\\\\SERVER\\Share\\Repo", "\\\\server\\share\\repo\\sub", win)
  );
  check(
    "Windows: a UNC sibling sharing the root as a string prefix is outside",
    !isInside("\\\\server\\share\\repo", "\\\\server\\share\\repo2\\sub", win)
  );
  check(
    "Windows: a different host with the same share path is outside",
    !isInside("\\\\server\\share\\repo", "\\\\other\\share\\repo\\sub", win),
    "the host is the first segment, so it differs before any subdirectory is reached"
  );
  check(
    "Windows: a different share on the same host is outside",
    !isInside("\\\\server\\a", "\\\\server\\b", win)
  );
  check(
    "Windows: a `..` escape out of a UNC root is outside",
    !isInside("\\\\server\\share\\repo", "\\\\server\\share\\repo\\..\\other", win)
  );
  check(
    "Windows: the \\\\?\\ long-path root contains its subdirectory regardless of case",
    isInside("\\\\?\\C:\\Repo", "\\\\?\\C:\\repo\\sub", win)
  );
  check(
    "Windows: a \\\\?\\ sibling sharing the prefix is outside",
    !isInside("\\\\?\\C:\\Repo", "\\\\?\\C:\\Repo2\\sub", win)
  );
  check(
    "Windows: with the case rule off, host and share are compared case-sensitively too",
    !isInside("\\\\SERVER\\Share\\Repo", "\\\\server\\share\\repo\\sub", {
      pathApi: path.win32,
      caseInsensitive: false,
    }),
    "the fold is one rule for every segment, not a special case for the drive letter"
  );

  /* ---- `\\?\UNC\` is where the two lines above meet ----
   * The UNC cases and the long-path cases were each half of this shape, and the
   * combination is the one Windows actually produces for a long path on a share
   * (`os.path`-style tools, .NET's `\\?\` prefix, and any repo checked out under
   * one). It is not the union of the two answers: a device prefix means
   * `path.win32.resolve` no longer treats the leading `\\` as a UNC marker, so the
   * segments come out as `?`, `UNC`, host, share, … — which the segment rule
   * handles unchanged, but only because nothing strips a prefix as a special
   * case. Asserting it here is what keeps it that way.
   */
  check(
    "Windows: a `\\\\?\\UNC\\` long-path root contains its subdirectory",
    isInside("\\\\?\\UNC\\server\\share\\repo", "\\\\?\\UNC\\server\\share\\repo\\sub", win),
    "the union of the UNC case and the long-path case, which is the shape a share checkout gets"
  );
  check(
    "Windows: a `\\\\?\\UNC\\` path is case-insensitive across the prefix, host and share too",
    isInside("\\\\?\\UNC\\SERVER\\Share\\Repo", "\\\\?\\UNC\\server\\share\\repo\\sub", win) &&
      isInside("\\\\?\\unc\\server\\share\\repo", "\\\\?\\UNC\\Server\\Share\\Repo\\sub", win),
    "folding one side of the prefix is not enough"
  );
  check(
    "Windows: a `\\\\?\\UNC\\` sibling sharing the root as a string prefix is outside",
    !isInside("\\\\?\\UNC\\server\\share\\repo", "\\\\?\\UNC\\server\\share\\repo2\\sub", win)
  );
  check(
    "Windows: a different share on the same host under the prefix is outside",
    !isInside("\\\\?\\UNC\\server\\a", "\\\\?\\UNC\\server\\b", win)
  );
  check(
    "...and a drive long path is not inside a UNC long-path root, even with the same tail",
    !isInside("\\\\?\\UNC\\server\\share\\repo", "\\\\?\\C:\\UNC\\server\\share\\repo\\sub", win),
    "stripping the `\\\\?\\` prefix before comparing would lose the host and make these look related"
  );
  check(
    "...and with the case rule off the prefixed path is case-sensitive like every other shape",
    !isInside("\\\\?\\UNC\\SERVER\\Share\\Repo", "\\\\?\\UNC\\server\\share\\repo\\sub", {
      pathApi: path.win32,
      caseInsensitive: false,
    })
  );
  check(
    "`path.win32.resolve` leaves `\\\\?\\UNC\\` in place, prefix and all",
    path.win32.resolve("\\\\?\\UNC\\server\\share\\repo") === "\\\\?\\UNC\\server\\share\\repo",
    JSON.stringify(path.win32.resolve("\\\\?\\UNC\\server\\share\\repo"))
  );

  // The two normalisations, written down because they are the reason the string
  // prefix rule could look correct and still be wrong.
  check(
    "`path.win32.resolve` gives a share root a trailing separator",
    path.win32.resolve("\\\\server\\share") === "\\\\server\\share\\",
    JSON.stringify(path.win32.resolve("\\\\server\\share"))
  );
  check(
    "...and leaves the \\\\?\\ long-path prefix in place",
    path.win32.resolve("\\\\?\\C:\\Repo") === "\\\\?\\C:\\Repo",
    JSON.stringify(path.win32.resolve("\\\\?\\C:\\Repo"))
  );
  check(
    "...and the rule survives both: neither shape is judged by string prefix",
    isInside("\\\\server\\share", "\\\\server\\share\\x", win) &&
      isInside("\\\\?\\C:\\Repo", "\\\\?\\C:\\Repo\\sub", win) &&
      !isInside("\\\\server\\share", "\\\\server\\share2\\x", win),
    "a trailing separator is an empty segment here, which is why the UNC root case holds"
  );
}

/* ---- the second question: what is this relative to the root? ----
 * `repo:pickInside` used to answer it by hand — `path.relative(root, picked)
 * .split(path.sep).join("/") || ""` behind an `isInside` guard — so the picker
 * kept three answers in step by hand (inside? / what path? / what does a refusal
 * look like?) and only the first had a test. `relativeInside` is all three in one
 * spelling; these checks are the contract, and the reason each of them is here is
 * that the three can regress separately.
 *
 * The `null` vs `""` split is the load-bearing one: `""` means "the whole repo"
 * to every caller (`--path` empty = scan everything), so an outside pick that
 * answered `""` would silently widen the scan instead of refusing it.
 */
{
  check(
    "relative: the root itself answers the empty relPath",
    relativeInside("/repo", "/repo") === "",
    JSON.stringify(relativeInside("/repo", "/repo"))
  );
  check(
    "relative: a subdirectory answers a forward-slash path",
    relativeInside("/repo", "/repo/src") === "src",
    JSON.stringify(relativeInside("/repo", "/repo/src"))
  );
  check(
    "relative: nested directories keep their order and their slashes",
    relativeInside("/repo", "/repo/src/lib/format.ts") === "src/lib/format.ts",
    JSON.stringify(relativeInside("/repo", "/repo/src/lib/format.ts"))
  );
  check(
    "relative: a `..` inside the pick is normalised before the answer",
    relativeInside("/repo", "/repo/src/../lib") === "lib",
    "the answer describes the directory the user picked, not the route they took"
  );
  check(
    "relative: outside answers null, not the empty string",
    relativeInside("/repo", "/etc") === null && relativeInside("/repo", "/repo2") === null,
    "`\"\"` means 整个仓库 here, so a refusal must not share it"
  );
  check(
    "relative: a `..` escape answers null",
    relativeInside("/repo", "/repo/../etc") === null
  );
  check(
    "relative: an empty root or candidate answers null",
    relativeInside("", "/repo") === null && relativeInside("/repo", "") === null
  );
  check(
    "relative: off Windows the pick is case-sensitive, like the guard",
    relativeInside("/Repo", "/repo/sub") === null && relativeInside("/Repo", "/Repo/sub") === "sub"
  );
}

/* ---- the Windows shapes the guard already knew, now answering with a path ---- */
{
  const win = { pathApi: path.win32, caseInsensitive: true };
  check(
    "Windows relative: backslash input answers a forward-slash relPath",
    relativeInside("C:\\Repo", "C:\\Repo\\src\\lib", win) === "src/lib",
    JSON.stringify(relativeInside("C:\\Repo", "C:\\Repo\\src\\lib", win))
  );
  check(
    "Windows relative: the root itself (either case) answers the empty relPath",
    relativeInside("C:\\Repo", "C:\\REPO", win) === "",
    JSON.stringify(relativeInside("C:\\Repo", "C:\\REPO", win))
  );
  check(
    "Windows relative: the answer keeps the case the user's dialog produced",
    relativeInside("c:\\repo", "C:\\Repo\\Src\\Lib", win) === "Src/Lib",
    "the fold is the comparison's business, not the answer's"
  );
  check(
    "Windows relative: a different drive answers null",
    relativeInside("C:\\Repo", "D:\\Repo\\sub", win) === null
  );
  check(
    "Windows relative: a UNC share root answers the relPath without dropping a segment",
    relativeInside("\\\\server\\share\\repo", "\\\\server\\share\\repo\\sub\\a", win) === "sub/a",
    JSON.stringify(relativeInside("\\\\server\\share\\repo", "\\\\server\\share\\repo\\sub\\a", win))
  );
  check(
    "Windows relative: a UNC path under a \\\\?\\ root keeps the prefix out of the answer",
    relativeInside("\\\\?\\C:\\Repo", "\\\\?\\C:\\Repo\\sub\\a", win) === "sub/a",
    JSON.stringify(relativeInside("\\\\?\\C:\\Repo", "\\\\?\\C:\\Repo\\sub\\a", win))
  );
  check(
    "Windows relative: the \\\\?\\UNC\\ shape answers the tail only",
    relativeInside(
      "\\\\?\\UNC\\server\\share\\repo",
      "\\\\?\\UNC\\server\\share\\repo\\sub",
      win
    ) === "sub",
    JSON.stringify(
      relativeInside("\\\\?\\UNC\\server\\share\\repo", "\\\\?\\UNC\\server\\share\\repo\\sub", win)
    )
  );
  check(
    "Windows relative: a different share under the same prefix answers null",
    relativeInside("\\\\?\\UNC\\server\\a", "\\\\?\\UNC\\server\\b\\x", win) === null
  );
  check(
    "Windows relative: with the case rule off, a differently-cased pick is refused",
    relativeInside("C:\\Repo", "c:\\repo\\sub", { pathApi: path.win32, caseInsensitive: false }) === null,
    "the same flag decides both questions, because both go through the guard"
  );
}

/* ---- the picker's answer is a value, not an if-chain in main.js ----
 * `repo:pickInside` answers the renderer with one of three shapes, and only the
 * `{ relPath }` one had a test behind it. The dangerous confusion is not a
 * crash: an outside pick answered as `{}` or `{ relPath: null }` reads as 留空
 * (the whole repo), which silently widens the scan instead of refusing it.
 * `pickInsideAnswer` decides the kind and `pickInsidePayload` fixes the keys;
 * these checks pin both, and the injected `relativeInside` proves the decision
 * does not recompute the path on the side.
 */
{
  const inside = pickInsideAnswer("/repo", "/repo/src");
  check(
    "pick: a subdirectory answers kind inside with the relPath",
    inside.kind === "inside" && inside.relPath === "src" && !("error" in inside),
    JSON.stringify(inside)
  );
  check(
    "pick: the repo itself is inside with the empty relPath, not cancelled",
    JSON.stringify(pickInsideAnswer("/repo", "/repo")) ===
      JSON.stringify({ kind: "inside", relPath: "" }),
    JSON.stringify(pickInsideAnswer("/repo", "/repo"))
  );
  const outside = pickInsideAnswer("/repo", "/repo2");
  check(
    "pick: an outside directory answers kind outside with the refusal sentence",
    outside.kind === "outside" &&
      outside.error === PICK_INSIDE_MESSAGES.outside &&
      !("relPath" in outside),
    JSON.stringify(outside)
  );
  check(
    "pick: a `..` escape is outside too",
    pickInsideAnswer("/repo", "/repo/../etc").kind === "outside"
  );
  check(
    "pick: a cancelled dialog (null / undefined / empty) is one answer",
    [null, undefined, ""].every(
      (picked) => JSON.stringify(pickInsideAnswer("/repo", picked)) === JSON.stringify({ kind: "cancelled" })
    ),
    JSON.stringify([null, undefined, ""].map((picked) => pickInsideAnswer("/repo", picked)))
  );
  check(
    "pick: no repository is its own answer, with the sentence that asks for one",
    JSON.stringify(pickInsideAnswer("", "/repo")) ===
      JSON.stringify({ kind: "no-repo", error: PICK_INSIDE_MESSAGES["no-repo"] }),
    JSON.stringify(pickInsideAnswer("", "/repo"))
  );

  // The injection point is why this translation is testable without a dialog:
  // the answer is whatever `relativeInside` said, and the two early returns do
  // not consult it at all.
  {
    const calls = [];
    const stub = (root, picked) => {
      calls.push([root, picked]);
      return "from/stub";
    };
    const answer = pickInsideAnswer("/repo", "/anywhere", { relativeInside: stub });
    check(
      "pick: the relPath is whatever relativeInside answered, not recomputed here",
      answer.kind === "inside" &&
        answer.relPath === "from/stub" &&
        calls.length === 1 &&
        calls[0][0] === "/repo" &&
        calls[0][1] === "/anywhere",
      JSON.stringify({ answer, calls })
    );
    check(
      "pick: the stub's null decides outside, with the guard's sentence",
      pickInsideAnswer("/repo", "/anywhere", { relativeInside: () => null }).kind === "outside",
      "the decision reads the guard's answer instead of asking isInside again"
    );
    const forbidden = () => {
      throw new Error("must not be called");
    };
    check(
      "pick: a cancelled pick never reaches relativeInside",
      pickInsideAnswer("/repo", "", { relativeInside: forbidden }).kind === "cancelled"
    );
    check(
      "pick: a missing repository never reaches relativeInside either",
      pickInsideAnswer("", "/repo", { relativeInside: forbidden }).kind === "no-repo"
    );
  }

  // The IPC keys, one shape at a time. `inside` is the only answer with
  // `relPath`; the two refusals are the only ones with `error`; cancelled has
  // neither. A helper that always returned `{ relPath, error }` would put an
  // empty `relPath` beside a refusal, and the renderer would have to guess
  // which one to believe.
  const cancelledPayload = pickInsidePayload({ kind: "cancelled" });
  check(
    "payload: cancelled is exactly the empty object",
    JSON.stringify(cancelledPayload) === "{}",
    JSON.stringify(cancelledPayload)
  );
  const insidePayload = pickInsidePayload({ kind: "inside", relPath: "" });
  check(
    "payload: inside carries relPath (empty means the repo) and nothing else",
    JSON.stringify(Object.keys(insidePayload)) === JSON.stringify(["relPath"]) &&
      insidePayload.relPath === "",
    JSON.stringify(insidePayload)
  );
  const outsidePayload = pickInsidePayload({ kind: "outside", error: PICK_INSIDE_MESSAGES.outside });
  check(
    "payload: outside carries the refusal and no relPath",
    JSON.stringify(Object.keys(outsidePayload)) === JSON.stringify(["error"]) &&
      outsidePayload.error === PICK_INSIDE_MESSAGES.outside,
    JSON.stringify(outsidePayload)
  );
  const noRepoPayload = pickInsidePayload({ kind: "no-repo", error: PICK_INSIDE_MESSAGES["no-repo"] });
  check(
    "payload: no-repo has the same shape, with the other sentence",
    JSON.stringify(Object.keys(noRepoPayload)) === JSON.stringify(["error"]) &&
      noRepoPayload.error === PICK_INSIDE_MESSAGES["no-repo"] &&
      noRepoPayload.error !== outsidePayload.error,
    JSON.stringify(noRepoPayload)
  );
}

/* ---- the kinds are one object, and an unknown one is loud ----
 * `pickInsideAnswer` decides a kind and `pickInsidePayload` switches on it, and
 * the two used to spell the four strings independently. The failure that hid
 * there was not a crash: a kind that reached the payload's `else` came out as
 * `{ error: undefined }`, which the renderer reads as "cancelled" — a new kind
 * would have shipped as a button that does nothing. The checks below pin the
 * object as the single declaration, each answer's kind against it, and the throw
 * that replaces the fall-through, so "loud" cannot be softened back by accident.
 */
{
  const produced = [
    pickInsideAnswer("", null).kind,
    pickInsideAnswer("/repo", null).kind,
    pickInsideAnswer("/repo", "/elsewhere").kind,
    pickInsideAnswer("/repo", "/repo/src").kind,
  ];
  const declared = Object.values(PICK_INSIDE_KINDS);
  check(
    "pick: the kind set is declared once and matches the four answers exactly",
    Object.isFrozen(PICK_INSIDE_KINDS) &&
      new Set(declared).size === declared.length &&
      JSON.stringify([...declared].sort()) === JSON.stringify([...produced].sort()),
    JSON.stringify({ declared, produced })
  );

  // The answers the decision can produce, translated. Every payload key must hold
  // a real string: `{ relPath: undefined }` would read as a cancel on the renderer
  // side, and that is the shape the throw below exists to prevent.
  const answers = [
    pickInsideAnswer("", null),
    pickInsideAnswer("/repo", null),
    pickInsideAnswer("/repo", "/elsewhere"),
    pickInsideAnswer("/repo", "/repo/src"),
  ];
  check(
    "payload: every answer the decision produces translates to keys with real values",
    answers.every((answer) => {
      const payload = pickInsidePayload(answer);
      return Object.values(payload).every((value) => typeof value === "string" && value !== "");
    }),
    JSON.stringify(answers.map((answer) => [answer.kind, pickInsidePayload(answer)]))
  );

  const thrown = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  const unknown = thrown(() => pickInsidePayload({ kind: "future" }));
  check(
    "payload: an unknown kind throws, naming the kind, instead of answering `{ error: undefined }`",
    unknown instanceof TypeError && unknown.message.includes("future"),
    unknown ? unknown.message : "it returned a payload — a future kind would read as a cancelled pick"
  );
  check(
    "payload: no answer at all throws too, rather than passing as cancelled",
    thrown(() => pickInsidePayload(undefined)) instanceof TypeError &&
      thrown(() => pickInsidePayload(null)) instanceof TypeError &&
      thrown(() => pickInsidePayload({})) instanceof TypeError,
    "undefined / null / `{}` are all answers with no kind"
  );
  check(
    "payload: an inside answer without a relPath string throws",
    thrown(() => pickInsidePayload({ kind: PICK_INSIDE_KINDS.inside })) instanceof TypeError &&
      thrown(() => pickInsidePayload({ kind: PICK_INSIDE_KINDS.inside, relPath: 42 })) instanceof TypeError,
    "`{ relPath: undefined }` would reach the renderer as a cancelled pick"
  );
  check(
    "payload: a refusal without a sentence throws",
    thrown(() => pickInsidePayload({ kind: PICK_INSIDE_KINDS.outside })) instanceof TypeError &&
      thrown(() => pickInsidePayload({ kind: PICK_INSIDE_KINDS.noRepo, error: "" })) instanceof TypeError,
    "an empty or missing error is a refusal the page cannot say out loud"
  );
}

/* ---- the picker's start directory must be absolute ----
 * `repo:pickInside` is handed a path the renderer remembered (`last-repo` in
 * localStorage). A relative one is a renderer bug, and it produced two silent
 * behaviours at once: `showOpenDialog` opened at the process's working directory
 * rather than the repo, and `relativeInside` compared a relative root against an
 * absolute pick, so a directory that really is inside the repo was refused as
 * 所选目录不在该仓库内. So the question is asked *before* the dialog, and the one
 * answer "there is no usable repo" is reused instead of a new sentence.
 */
{
  const table = ["/repo", "repo", "", "  ", null, undefined, 42].map((value) => [value, repoIsPickable(value)]);
  check(
    "pick: only a non-empty absolute path is a pickable repository",
    repoIsPickable("/repo") === true &&
      table.filter(([, pickable]) => pickable).length === 1,
    JSON.stringify(table)
  );

  /* The Windows answer is the one this predicate exists for, and it is the one
   * shape a host-only test cannot see. `C:repo` is drive-relative — "the current
   * directory on drive C" — so the dialog would open somewhere the user did not
   * pick, and `relativeInside` would compare an absolute pick against it and
   * refuse a real subdirectory. It is also one character away from the valid
   * `C:\repo`, which is exactly the kind of input a stale `last-repo` produces. */
  const win = { pathApi: path.win32 };
  const windows = [
    ["C:\\repo", true],
    ["c:\\repo\\sub", true],
    ["C:repo", false],
    ["C:repo\\sub", false],
    ["\\\\server\\share", true],
    ["\\\\?\\C:\\Repo", true],
    ["repo", false],
    ["", false],
  ].map(([value, expected]) => [value, repoIsPickable(value, win), expected]);
  check(
    "Windows: a drive path, a UNC share and a long path are pickable; a drive-relative path is not",
    windows.every(([, actual, expected]) => actual === expected),
    JSON.stringify(windows)
  );
  check(
    "Windows: `C:repo` is refused while `C:\\repo` is accepted",
    repoIsPickable("C:\\repo", win) === true && repoIsPickable("C:repo", win) === false,
    "drive-relative means 'the current directory on C', so the dialog would open somewhere else"
  );
  check(
    "the injected path API decides, not the host's",
    repoIsPickable("C:\\repo", win) === true &&
      repoIsPickable("C:\\repo", { pathApi: path.posix }) === false &&
      repoIsPickable("/repo", { pathApi: path.posix }) === true,
    "the same string must not be judged by the Windows and POSIX rules alike"
  );
  /* `repo:pick` answered with `result.filePaths[0]` itself, so a path that is
   * not absolute could reach the renderer, which stores it as the repo and then
   * resolves every later relative path against its own working directory. The
   * gate is the same predicate as `repo:pickInside`'s precondition; the answer
   * is `""`, which is what a cancelled dialog gives and what the renderer reads
   * as "keep the repo you have". Three shapes, none of which the folder dialog
   * can really produce — which is exactly why they need a test. */
  check(
    "pick: a non-absolute answer is refused as \"\" (the same answer a cancel gives)",
    pickedRepoOrEmpty("relative/repo") === "" &&
      pickedRepoOrEmpty("") === "" &&
      pickedRepoOrEmpty(null) === "" &&
      pickedRepoOrEmpty(undefined) === "" &&
      pickedRepoOrEmpty(42) === "",
    JSON.stringify(["relative/repo", "", null, undefined, 42].map((value) => [value, pickedRepoOrEmpty(value)]))
  );
  check(
    "pick: an absolute answer travels as given, not resolved or rewritten",
    pickedRepoOrEmpty("/repo") === "/repo" && pickedRepoOrEmpty("/repo/../repo") === "/repo/../repo",
    "the picker's answer must be the string the user chose"
  );
  check(
    "pick: Windows drive-relative is refused while a UNC path is kept",
    pickedRepoOrEmpty("C:repo", win) === "" &&
      pickedRepoOrEmpty("C:repo\\sub", win) === "" &&
      pickedRepoOrEmpty("\\\\server\\share\\repo", win) === "\\\\server\\share\\repo",
    JSON.stringify([
      ["C:repo", pickedRepoOrEmpty("C:repo", win)],
      ["\\\\server\\share\\repo", pickedRepoOrEmpty("\\\\server\\share\\repo", win)],
    ])
  );

  /* ---- the answer travels byte-for-byte, not resolved ----
   * The gate above decides *whether* the answer may travel; it never rewrites
   * what the user chose. "As given" is a stronger promise than "absolute", and
   * the difference is exactly what a normalising call would take away: `..`
   * collapsed, the `\\?\` long-path prefix dropped, the volume's own casing
   * decided for the user. The renderer stores the answer as the repo and
   * resolves every later path against it, so a rewritten path is a path the
   * folder dialog never produced.
   *
   * The comparison is with `path.win32.resolve` — the normalisation this
   * function deliberately does not do — so "it is absolute" cannot pass here:
   * one of the samples is a path `resolve` *would* rewrite, and the assertion
   * says which.
   */
  {
    const windows = [
      "\\\\server\\share\\repo", // the UNC share the dialog answers with
      "\\\\server\\Share\\Repo", // the case is the user's, not the volume's
      "\\\\?\\UNC\\server\\share\\repo", // the long-path prefix stays
      "\\\\?\\C:\\Repo", // ...and so does the drive form of it
      "C:\\Repo",
      "C:\\Repo\\..\\Repo", // `..` is not collapsed: the dialog did not collapse it
    ];
    const rows = windows.map((input) => {
      const given = pickedRepoOrEmpty(input, win);
      return {
        input,
        given,
        identical: given === input,
        resolved: path.win32.resolve(input),
      };
    });
    check(
      "pick: every acceptable Windows answer comes back exactly as it was picked",
      rows.every((row) => row.identical),
      JSON.stringify(rows.map((row) => [row.input, row.given]))
    );
    check(
      "...and one of them is a path `resolve` would have rewritten, so the rule is not merely \"absolute\"",
      rows.some((row) => row.given !== row.resolved),
      JSON.stringify(rows.filter((row) => row.given !== row.resolved).map((row) => [row.input, row.resolved]))
    );
    const posix = pickedRepoOrEmpty("/repo/../repo");
    check(
      "pick: the same on POSIX — the answer is not resolved either",
      posix === "/repo/../repo" && posix !== path.posix.resolve("/repo/../repo"),
      JSON.stringify({ given: posix, resolved: path.posix.resolve("/repo/../repo") })
    );
  }
  const forbidden = () => {
    throw new Error("must not be called");
  };
  const relative = pickInsideAnswer("relative/repo", "/repo/src", { relativeInside: forbidden });
  check(
    "pick: a relative repo is the no-repo answer, and never reaches relativeInside",
    relative.kind === PICK_INSIDE_KINDS.noRepo && relative.error === PICK_INSIDE_MESSAGES["no-repo"],
    JSON.stringify(relative)
  );
}

/* ---- the file picker's options are a value too ----
 * `repo:pickFile` was the last picker whose defaults were written inline in
 * `main.js`, so "what does a picker with no options open as?" could only be
 * answered by reading a registration. The three edges below are the ones that
 * produce an unusable dialog rather than an ugly one, and none of them would
 * ever be noticed by hand: an empty filter list (nothing selectable), an entry
 * the OS rejects (a throw from inside a click handler), an extension written
 * with a dot (a filter that matches nothing).
 */
{
  const fallback = pickFileOptions(undefined);
  check(
    "pickFile: no options is the 所有文件 picker, spelled once",
    JSON.stringify(fallback) ===
      JSON.stringify({
        title: PICK_FILE_DEFAULTS.title,
        buttonLabel: PICK_FILE_DEFAULTS.buttonLabel,
        filters: [{ name: "所有文件", extensions: ["*"] }],
      }),
    JSON.stringify(fallback)
  );
  check(
    "pickFile: null, a string and `{}` all answer the same fallback",
    [null, "nope", 42, {}].every((asked) => JSON.stringify(pickFileOptions(asked)) === JSON.stringify(fallback)),
    JSON.stringify([null, "nope", 42, {}].map((asked) => pickFileOptions(asked).title))
  );

  const asked = pickFileOptions({
    title: "选择规则文件",
    filters: [{ name: "rule JSON", extensions: ["json"] }],
  });
  check(
    "pickFile: the caller's title and filters are what the dialog opens with",
    asked.title === "选择规则文件" &&
      JSON.stringify(asked.filters) === JSON.stringify([{ name: "rule JSON", extensions: ["json"] }]) &&
      asked.buttonLabel === PICK_FILE_DEFAULTS.buttonLabel,
    JSON.stringify(asked)
  );

  const empty = pickFileOptions({ filters: [] });
  check(
    "pickFile: an empty filter list falls back instead of passing through",
    JSON.stringify(empty.filters) === JSON.stringify([{ name: "所有文件", extensions: ["*"] }]) &&
      empty.title === PICK_FILE_DEFAULTS.title,
    "an empty list is a picker in which no file can be selected: " + JSON.stringify(empty)
  );

  const partly = pickFileOptions({
    filters: [
      { name: "md", extensions: [".md", " .txt"] },
      { name: "", extensions: ["json"] },
      { extensions: ["go"] },
      null,
      "json",
      { name: "no extensions", extensions: [] },
    ],
  });
  check(
    "pickFile: entries the dialog cannot honour are dropped, and the rest is normalised",
    JSON.stringify(partly.filters) === JSON.stringify([{ name: "md", extensions: ["md", "txt"] }]),
    JSON.stringify(partly.filters)
  );
  const repeated = pickFileOptions({ filters: [{ name: "md", extensions: ["md", ".md", " md ", "txt", ""] }] });
  check(
    "pickFile: an extension repeated in three spellings is one entry, and the rest is kept",
    JSON.stringify(repeated.filters) === JSON.stringify([{ name: "md", extensions: ["md", "txt"] }]),
    JSON.stringify(repeated.filters)
  );
  check(
    "pickFile: a list of only-unusable entries is the fallback, not whatever survived",
    JSON.stringify(pickFileOptions({ filters: [null, { name: "x" }, { extensions: ["y"] }] }).filters) ===
      JSON.stringify([{ name: "所有文件", extensions: ["*"] }]),
    JSON.stringify(pickFileOptions({ filters: [null, { name: "x" }, { extensions: ["y"] }] }).filters)
  );
  check(
    "pickFile: an empty or blank title is the default title, not an empty caption",
    ["", "   "].every((title) => pickFileOptions({ title }).title === PICK_FILE_DEFAULTS.title),
    JSON.stringify(["", "   "].map((title) => pickFileOptions({ title }).title))
  );

  // A shared literal handed to two callers is one mutation away from changing
  // the default for everyone, so each call answers a fresh copy.
  const first = pickFileOptions(undefined);
  first.filters[0].extensions.push("exe");
  first.title = "hijacked";
  const second = pickFileOptions(undefined);
  check(
    "pickFile: each call is a fresh copy, so one caller cannot rewrite the default",
    JSON.stringify(second.filters) === JSON.stringify([{ name: "所有文件", extensions: ["*"] }]) &&
      second.title === PICK_FILE_DEFAULTS.title,
    JSON.stringify(second)
  );
}

/* ---- the call sites use the shared rule, not their own spelling ---- */
{
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const gitSrc = fs.readFileSync(path.join(ROOT, "git-service.js"), "utf8");
  check(
    "repo:pickInside hands the dialog's answer to path-guard, not an inline if-chain",
    /require\("\.\/path-guard"\)/.test(mainSrc) &&
      /pickInsidePayload\(pickInsideAnswer\(repo, (?:null|picked)\)\)/.test(mainSrc) &&
      !/relativeInside\(repo/.test(mainSrc) &&
      !/path\.relative\(root, picked\)/.test(mainSrc),
    "main.js"
  );
  check(
    "repo:pickFile takes its options from path-guard, not from an inline || chain",
    /pickFileOptions\(opts\)/.test(mainSrc) &&
      !/所有文件/.test(mainSrc) &&
      !/buttonLabel: "选择此文件"/.test(mainSrc),
    "the defaults and their wording live in path-guard.js"
  );
  // The order is the point, and it has to be read inside *this* registration:
  // `repo:pick` above it asks the dialog first, so an index over the whole file
  // would pass whichever order `repo:pickInside` used.
  const registrationAt = mainSrc.indexOf('ipcMain.handle("repo:pickInside"');
  const pickInsideSrc = mainSrc.slice(registrationAt, mainSrc.indexOf('ipcMain.handle("repo:pickFile"'));
  const lineAt = (index) =>
    index === -1 ? "missing" : String(mainSrc.slice(0, registrationAt + index).split("\n").length);
  const guardAt = pickInsideSrc.indexOf("repoIsPickable(repo)");
  const dialogAt = pickInsideSrc.search(/dialog\.showOpenDialog\(/);
  const dialogCalls = (pickInsideSrc.match(/dialog\.showOpenDialog\(/g) || []).length;
  check(
    "repo:pickInside asks whether the repo is pickable before it opens the dialog",
    /if \(!repoIsPickable\(repo\)\) return pickInsidePayload\(pickInsideAnswer\("", null\)\);/.test(pickInsideSrc) &&
      guardAt !== -1 &&
      dialogAt !== -1 &&
      guardAt < dialogAt &&
      dialogCalls === 1,
    `repoIsPickable at line ${lineAt(guardAt)}, dialog at line ${lineAt(dialogAt)}, dialog calls=${dialogCalls} — a relative repo would otherwise open the dialog at the process's working directory and refuse a real subdirectory`
  );
  // `pickInsidePayload`'s unknown-kind throw is only a dead path at the IPC
  // boundary while every answer it receives came from the decision. A hand-built
  // `{ kind: ... }` in the registration would put the throw back on a path the
  // renderer can reach (and would re-spell the shapes this module owns).
  const pickAt = mainSrc.indexOf('ipcMain.handle("repo:pick",');
  const pickSrc = mainSrc.slice(pickAt, mainSrc.indexOf('ipcMain.handle("repo:pickInside"'));
  check(
    "repo:pick hands the dialog's path to the shared gate, not straight to the renderer",
    pickAt !== -1 && /pickedRepoOrEmpty\(result\.filePaths\[0\]\)/.test(pickSrc) && !/return result\.filePaths\[0\]/.test(pickSrc),
    `repo:pick at line ${pickAt === -1 ? "missing" : String(mainSrc.slice(0, pickAt).split("\n").length)} — an unguarded answer becomes the repo the whole app resolves against`
  );
  const payloadCalls = mainSrc.match(/pickInsidePayload\(/g) || [];
  check(
    "repo:pickInside never hands pickInsidePayload a hand-built answer",
    payloadCalls.length === 2 &&
      (mainSrc.match(/pickInsidePayload\(\s*pickInsideAnswer\(/g) || []).length === payloadCalls.length,
    `calls=${payloadCalls.length} — every payload must be pickInsidePayload(pickInsideAnswer(...))`
  );
  check(
    "...and neither picker sentence is spelled in the registration",
    ![PICK_INSIDE_MESSAGES.outside, PICK_INSIDE_MESSAGES["no-repo"]].some((said) =>
      mainSrc.includes(said)
    ),
    "the translation and its wording live in path-guard.js"
  );
  check(
    "readFileWindow guards the worktree read with isInside",
    /require\("\.\/path-guard"\)/.test(gitSrc) && /isInside\(repo, abs\)/.test(gitSrc),
    "git-service.js"
  );
  check(
    "neither file spells the prefix rule itself any more",
    !/\.startsWith\(root \+ path\.sep\)/.test(mainSrc) && !/abs\.startsWith\(root\)/.test(gitSrc),
    "the duplicated rule is the thing this module exists to remove"
  );
}

/* ---- the reader answers "路径越界", not a silently-empty window ---- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-path-"));
  const repo = path.join(dir, "repo");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(repo, "sub", "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "top.txt"), "top\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");

  try {
    const sub = gitSvc.readFileWindow(repo, "sub/a.txt", 1, 1, 0);
    check("the reader opens a file in a subdirectory", sub.ok === true && sub.lines.length === 1, JSON.stringify(sub));
    const top = gitSvc.readFileWindow(repo, "top.txt", 1, 1, 0);
    check("the reader opens a file at the root", top.ok === true, JSON.stringify(top));
    const dotdot = gitSvc.readFileWindow(repo, "../outside/secret.txt", 1, 1, 0);
    check(
      "the reader refuses a `..` escape",
      dotdot.ok === false && dotdot.error === "路径越界",
      JSON.stringify(dotdot)
    );
    const absolute = gitSvc.readFileWindow(repo, path.join(outside, "secret.txt"), 1, 1, 0);
    check(
      "the reader refuses an absolute path outside the repo",
      absolute.ok === false && absolute.error === "路径越界",
      JSON.stringify(absolute)
    );
    check(
      "the reader still reports a missing file inside the repo as a read failure",
      (() => {
        const missing = gitSvc.readFileWindow(repo, "sub/nope.txt", 1, 1, 0);
        return missing.ok === false && /^读取文件失败：/.test(missing.error);
      })()
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all path-guard checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
