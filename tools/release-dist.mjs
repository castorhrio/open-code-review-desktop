// Where the fallback output of a failed `electron-builder --win` gets moved.
//
// WHY THE FALLBACK EXISTS
// electron-builder assembles the app in `<output>/win-unpacked.tmp` and renames
// it into place. On this machine that rename has failed with EPERM/EBUSY on a
// single file inside the tmp dir, held by an unidentified external handle (an
// antivirus scan is the likeliest owner; no process in the list admits it).
// Building to a fresh output dir sidesteps the locked path entirely, and the
// artefacts are then moved into `release/` — copying never touches the locked
// directory.
//
// WHY THIS IS A MODULE AND NOT FIVE LINES IN `tools/release.mjs`
// This is the only place in the release chain that rearranges files on the real
// disk without a command behind it, so it is the one write path no check could
// reach: importing `tools/release.mjs` starts packaging. `relocateDistOutput`
// takes the filesystem and the path module as arguments, so
// `tools/release-guard-smoke.mjs` can drive it against a table of fake
// directories and assert what was moved, what was deliberately left behind, and
// in which order — including the three facts that are easy to lose in a rewrite:
//
//   - a previous `release/win-unpacked` is removed *before* the new one is
//     renamed into its place (renaming onto a non-empty directory fails on
//     Windows, which is the platform this path exists for);
//   - `builder-debug.yml` and the freshly moved `win-unpacked` are never renamed
//     a second time out of the fallback dir;
//   - the fallback dir is removed *last* — removing it first would delete the
//     very files this function exists to keep.
//
// The answer names what happened (`moved`, `skipped`, `replaced`) so the release
// log can say it, and so a caller cannot mistake "it returned" for "everything
// landed".
import fs from "node:fs";
import path from "node:path";

/**
 * Entries of the fallback output dir that must not be renamed into `release/`.
 *
 * `win-unpacked` is moved first and as a directory (it is the one path the
 * locked build could not rename), and `builder-debug.yml` describes the *temp*
 * output dir, so copying it over the real one's would mislabel the build that
 * ships. Both are left behind and then deleted with the fallback dir.
 */
export const DIST_SKIP = ["win-unpacked", "builder-debug.yml"];

/**
 * Move a fallback build's output into the real output dir, in the order that
 * keeps the artefacts.
 *
 * `fs` and `path` are injected for the check's sake; every call in here is one
 * of `existsSync / readdirSync / renameSync / rmSync / mkdirSync` and
 * `path.join` / `path.resolve`, so a double only has to answer those.
 *
 * Throws when there is nothing to move — a clear sentence is worth more than the
 * `ENOENT` from `renameSync` on a path the reader has never seen — and when the
 * two directories are the same one, which would delete the build it was asked to
 * preserve.
 */
export function relocateDistOutput({ from, to, fs: fsApi = fs, path: pathApi = path } = {}) {
  if (!from || !to) throw new Error("relocateDistOutput needs a `from` and a `to` directory");
  if (pathApi.resolve(from) === pathApi.resolve(to)) {
    throw new Error(`refusing to relocate a directory onto itself: ${from}`);
  }

  const fresh = pathApi.join(from, "win-unpacked");
  if (!fsApi.existsSync(fresh)) {
    throw new Error(`nothing to relocate: ${fresh} does not exist — the retried build produced no app dir`);
  }
  // The first `npm run dist:win` may have failed before it created its output
  // dir at all, in which case `release/` is not there to rename into. Creating it
  // is cheaper than a rename that fails on a missing parent.
  if (!fsApi.existsSync(to)) fsApi.mkdirSync(to, { recursive: true });

  const target = pathApi.join(to, "win-unpacked");
  const replaced = fsApi.existsSync(target);
  if (replaced) fsApi.rmSync(target, { recursive: true, force: true });
  fsApi.renameSync(fresh, target);

  const moved = [];
  const skipped = [];
  for (const name of fsApi.readdirSync(from)) {
    if (DIST_SKIP.includes(name)) {
      skipped.push(name);
      continue;
    }
    fsApi.renameSync(pathApi.join(from, name), pathApi.join(to, name));
    moved.push(name);
  }

  // Last, and only now: everything worth keeping has left the fallback dir.
  fsApi.rmSync(from, { recursive: true, force: true });

  return { moved, skipped, replaced, from, to };
}
