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
  // Recorded because it is easy to get the credit wrong: `path.win32.relative`
  // lower-cases both sides itself, so the Windows case answer above comes from
  // the path API and not from the `caseInsensitive` flag. The two checks below
  // are what keep that honest — one pins the internal the answer currently rests
  // on, the other pins that the flag is not silently load-bearing (the fold in
  // `path-guard.js` is), so a future switch away from `relative` cannot leave
  // "Windows works" green while the case bug is back.
  check(
    "`path.win32.relative` lower-cases both sides itself",
    path.win32.relative("C:\\Repo", "c:\\repo\\sub") === "sub",
    JSON.stringify(path.win32.relative("C:\\Repo", "c:\\repo\\sub"))
  );
  check(
    "...so the Windows case answer does not depend on the flag being passed",
    isInside("C:\\Repo", "c:\\repo\\sub", { pathApi: path.win32, caseInsensitive: false }) === true,
    "the flag states the rule; `path.relative` is what currently lower-cases"
  );
}

/* ---- UNC roots and the `\\?\` long-path prefix ----
 * A prefix rule (`root + sep` / `startsWith(root)`) gets these wrong in ways
 * nobody notices, because both shapes normalise differently from a drive path:
 * `path.win32.resolve` turns a share root into `\\server\share\` (trailing
 * separator) and leaves `\\?\` in place. That is exactly why the rule is
 * expressed through `path.relative` instead of by comparing strings, and the two
 * normalisations are asserted below rather than assumed — if a future Node
 * changed them, the rule's answer is what this block is about, not the
 * normalisation, so the check would say which of the two moved.
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
    "the answer comes back absolute, which the last clause catches"
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
    "resolve() adding a separator is why the UNC root case is the sharp one"
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
