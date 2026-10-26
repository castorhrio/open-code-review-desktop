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
// Run with `npm run audit:path`.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { isInside } = require(path.join(ROOT, "path-guard.js"));
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

/* ---- the call sites use the shared rule, not their own spelling ---- */
{
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const gitSrc = fs.readFileSync(path.join(ROOT, "git-service.js"), "utf8");
  check(
    "repo:pickInside guards the picked directory with isInside",
    /require\("\.\/path-guard"\)/.test(mainSrc) && /isInside\(root, picked\)/.test(mainSrc),
    "main.js"
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
