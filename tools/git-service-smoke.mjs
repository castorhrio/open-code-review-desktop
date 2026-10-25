// Exercises git-service.js against a real git repository.
//
// The code pane next to a finding has to show the code that was reviewed. The
// policy that decides *which* code that is lived in the `file:read` handler,
// and it was wrong twice at once:
//
//   - `HEAD` was treated as "no ref", so a review against HEAD read the working
//     tree — exactly the case where a dirty working copy differs from what was
//     reviewed;
//   - any failed ref read fell back to the working tree as well, so a file that
//     is not in the reviewed ref at all was shown as though it were.
//
// Both failures are silent: the pane looks normal, and the only symptom is a
// finding whose code does not match the finding. Nothing else in the suite
// covers this layer — the UI audit stubs the bridge, and the service smoke
// talks to the CLI — so the rule is checked here, against real git.
//
// Run with `npm run audit:git`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const gitSvc = require(path.join(ROOT, "git-service.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- a throwaway repository with a dirty working copy and a second branch ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-"));
// Async spawn, not spawnSync: spawnSync is refused outright with EBUSY in a
// sandboxed environment, and this suite has to run there too.
const git = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} failed (${code}): ${err || out}`));
      else resolve(out.trim());
    });
  });

const COMMITTED = "package main\n\nfunc main() {}\n";
const DIRTY = "// edited in the working tree, never committed\npackage main\n";
const FEATURE = "package main\n\nfunc feature() {}\n";

await git(["init", "-q"]);
await git(["config", "user.email", "t@example.com"]);
await git(["config", "user.name", "Test"]);
await git(["checkout", "-q", "-b", "main"]);
fs.writeFileSync(path.join(dir, "a.go"), COMMITTED);
await git(["add", "."]);
await git(["commit", "-q", "-m", "initial"]);

await git(["checkout", "-q", "-b", "feature"]);
fs.writeFileSync(path.join(dir, "a.go"), FEATURE);
await git(["commit", "-q", "-am", "feature"]);
await git(["checkout", "-q", "main"]);

// The working copy now differs from every commit — the state in which reading
// the working tree instead of the snapshot silently shows the wrong code.
fs.writeFileSync(path.join(dir, "a.go"), DIRTY);

const read = (opts) => gitSvc.readFile(dir, "a.go", { startLine: 1, endLine: 10, pad: 2, ...opts });
const text = (res) => (res.lines || []).map((l) => l.content).join("\n");

/* ---- a ref means that ref ---- */

const atHead = await read({ ref: "HEAD" });
check("reading at HEAD succeeds", atHead.ok, atHead.error || "");
check(
  "reading at HEAD returns the committed file, not the dirty working copy",
  atHead.ok && text(atHead).includes("func main() {}") && !text(atHead).includes("edited in the working tree"),
  atHead.ok ? text(atHead).split("\n")[0] : atHead.error
);
check("reading at HEAD is labelled as coming from the ref", atHead.source === "git" && atHead.ref === "HEAD", `${atHead.source} / ${atHead.ref}`);

const atFeature = await read({ ref: "feature" });
check(
  "reading at another branch returns that branch's file",
  atFeature.ok && text(atFeature).includes("func feature() {}"),
  atFeature.ok ? text(atFeature).split("\n")[0] : atFeature.error
);

/* ---- no ref means the working tree ---- */

const atWorktree = await read({});
check("reading without a ref returns the working tree", atWorktree.ok && text(atWorktree).includes("edited in the working tree"), atWorktree.error || "");
check("the working tree is labelled as such", atWorktree.source === "worktree", atWorktree.source || "");

/* ---- a failed ref read is reported, never replaced ---- */

const missing = await gitSvc.readFile(dir, "only-in-worktree.txt", { ref: "HEAD" });
check("a file that is not in the ref fails instead of falling back", missing.ok === false, missing.ok ? "it succeeded" : "");
check("...and says which ref was missing it", missing.reason === "missing", missing.reason || "");
check("...and names the ref in the message", /HEAD/.test(missing.error || ""), missing.error || "");

const badRef = await gitSvc.readFile(dir, "a.go", { ref: "no-such-ref" });
check("an unresolvable ref fails instead of falling back", badRef.ok === false, badRef.ok ? "it succeeded" : "");
check("...and is reported as an unresolvable ref", badRef.reason === "bad-ref", badRef.reason || "");

/* ---- a wording that matches nothing is a plain failure ----
 * The reasons above are read out of git's own stderr, and git's wording is
 * not the app's to control: a localised git, or a newer git, says it
 * differently. Anything that matches neither wording has to land on the
 * generic branch — reported as a failure, with git's own first line, rather
 * than guessed to be a missing file or an unresolvable ref.
 *
 * A directory that is not a repository is what produces such a wording
 * ("fatal: not a git repository"), and the ceiling keeps git from finding a
 * repository further up the tree.
 */
const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-notrepo-"));
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = path.dirname(notARepo);
const unknownWording = await gitSvc.readFileAtRef(notARepo, "a.go", "HEAD", 1, 1, 0);
if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
check(
  "a wording that matches neither is reported as a plain failure",
  unknownWording.ok === false && unknownWording.reason === "failed",
  unknownWording.reason || unknownWording.error || ""
);
check("...and it keeps git's own words in the message", /git/i.test(unknownWording.error || ""), unknownWording.error || "");
fs.rmSync(notARepo, { recursive: true, force: true });

/* ---- the working tree does not hide the snapshot ---- */

// The file is committed at HEAD and deleted in the working tree: the snapshot
// still has it, and the working tree does not. Reading at the ref must find it.
fs.rmSync(path.join(dir, "a.go"));
const afterDelete = await read({ ref: "HEAD" });
check(
  "a file deleted in the working tree is still readable at the ref",
  afterDelete.ok && text(afterDelete).includes("func main() {}"),
  afterDelete.ok ? text(afterDelete).split("\n")[0] : afterDelete.error
);
const deletedWorktree = await read({});
check("...and is gone from the working tree", deletedWorktree.ok === false, deletedWorktree.ok ? "it succeeded" : "");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "all git-service checks passed" : `${failures.length} failed`}`);
if (failures.length) {
  console.error(`\ngit-service checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
