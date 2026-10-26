// Pins the one rule both path callers now share.
//
// There used to be two spellings of "is this inside the repo?": the folder
// picker compared `picked.startsWith(root + sep)` and the worktree reader
// compared `abs.startsWith(root)`. Both are case-sensitive on Windows, so
// `C:\Repo` rejected `c:\repo\sub` — the same directory the filesystem would
// happily open. They also had to be kept in sync by hand, which is how the two
// answers drifted. `path-guard.js` is now the one implementation, and this
// suite asserts the four basic answers, the Windows case answer (via
// `path.win32`, so it runs on Linux), and that both call sites actually use it.
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
