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
// The same check then runs the move once with `fs`/`path` left at their defaults
// against a real root under the OS temp dir. The fake table proves the order of
// the calls; only the real disk proves the calls are the right ones — a double
// accepts whatever names it is handed, so "the app dir lands in `release/`" would
// otherwise stay a claim about names the double made up. That matters most here:
// this is the only path in the release chain whose first real run would otherwise
// be release day.
//
// The answer names what happened (`moved`, `skipped`, `replaced`) so the release
// log can say it, and so a caller cannot mistake "it returned" for "everything
// landed".
//
// `retryDistIntoFallback` is the same path one level up: clear the stale fallback
// dir, build into it, move the result out. It lives here for the same reason —
// the *order* is the whole content of the path, and the order used to be three
// statements inside `tools/release.mjs`, which no check can import. A same-version
// retry is what made this urgent: `release-0.1.14/` still holds the previous
// attempt's setup.exe, electron-builder builds on top of it, and the move then
// finds names it cannot rename over.
import fs from "node:fs";
import path from "node:path";

/**
 * Entries of the fallback output dir that must not be renamed into `release/`.
 *
 * `win-unpacked` is moved first and as a directory (it is the one path the
 * locked build could not rename), and `builder-debug.yml` describes the *temp*
 * output dir, so copying it over the real one's would mislabel the build that
 * ships. Both are left behind and then deleted with the fallback dir.
 *
 * A DENYLIST, ON PURPOSE: this names what the *temp dir owns*, not what the
 * release is known to contain. Everything else in that dir came out of the build
 * this function exists to save, and the fallback dir is deleted at the end — so
 * an entry nobody anticipated (`builder-effective-config.yaml` today, whatever
 * electron-builder writes beside the installer tomorrow) has exactly two possible
 * fates: moved into `release/` or destroyed unseen. An extra YAML beside the
 * installers is cosmetic; a missing setup.exe is a release that has to be rebuilt
 * and, if nobody notices, a GitHub Release with no artefact.
 *
 * So the unknown entry is *moved*, and `tools/release-guard-smoke.mjs` pins both
 * halves of that: an unlisted artefact lands in `release/`, and this list is still
 * exactly the two names above. Adding a third name therefore means deliberately
 * deleting something on the next packaging run, which shows up as a red check
 * instead of as a quiet edit here.
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

/**
 * The fallback output dir a retried build uses, relative to the repo root.
 *
 * Named once: `tools/release.mjs` logs it, `electron-builder` is told to build
 * into it, and `relocateDistOutput` is told to empty it, so the three cannot
 * disagree about which directory this attempt owns.
 */
export function fallbackOutputDir(version) {
  return `release-${version}`;
}

/**
 * Remove a previous attempt's fallback output dir, so this attempt builds into
 * an empty one.
 *
 * WHY THIS IS NOT OPTIONAL
 * A same-version retry is the normal case (the first attempt is the one that hit
 * the locked rename). Whatever it left in `release-<version>/` — a whole
 * `win-unpacked`, a setup.exe with the very name this build will produce — makes
 * electron-builder build on top of a previous run, and the move afterwards then
 * fails on a name it cannot rename over. Clearing first turns "one attempt, one
 * output dir" from a hope into a step.
 *
 * Answers the entries that went, so the release log can say how much was stale
 * rather than only that it did something. A path that is missing is a no-op;
 * `force` covers the case where it is already gone by the time `rm` runs.
 *
 * The file-shaped case is pinned against a real file (a `readdirSync` that
 * answers `ENOTDIR`, not a double that throws on request) in
 * `tools/release-guard-smoke.mjs`, because the `try` below only ever runs on that
 * shape: writing it as a comment is what let it stay a guess.
 */
export function clearStaleDistOutput({ dir, fs: fsApi = fs } = {}) {
  if (!dir) throw new Error("clearStaleDistOutput needs a `dir`");
  if (!fsApi.existsSync(dir)) return { dir, removed: [] };
  let removed = [];
  // A stale path that is a file rather than a directory still has to go, and
  // `readdirSync` is the only call here that cares which it is. Failing to read
  // its entries must not become failing to clear it.
  try {
    removed = fsApi.readdirSync(dir);
  } catch (_) {
    removed = [];
  }
  fsApi.rmSync(dir, { recursive: true, force: true });
  return { dir, removed };
}

/**
 * The whole fallback: clear the stale dir, retry the build into it, move the
 * result into `release/`.
 *
 * `run` is injected (it spawns `electron-builder` and, in `tools/release.mjs`,
 * exits the process when the command fails), and so are `fs`/`path`, so
 * `tools/release-guard-smoke.mjs` can assert the three facts that make this path
 * safe: the dir is cleared *before* the build starts, nothing is moved when the
 * build throws, and the move is handed exactly the dirs this attempt owns.
 *
 * A build that fails is not caught here: the caller's runner has already decided
 * what a failed command means (exit, in the release script), and catching it
 * would turn a failed retry into a silent "nothing to move".
 */
export function retryDistIntoFallback({
  version,
  root,
  run,
  relocate = relocateDistOutput,
  fs: fsApi = fs,
  path: pathApi = path,
} = {}) {
  if (!version) throw new Error("retryDistIntoFallback needs the release version");
  if (!root) throw new Error("retryDistIntoFallback needs the repo root");
  if (typeof run !== "function") throw new Error("retryDistIntoFallback needs a `run` command runner");

  const dir = fallbackOutputDir(version);
  const from = pathApi.join(root, dir);
  const to = pathApi.join(root, "release");
  const cleared = clearStaleDistOutput({ dir: from, fs: fsApi });
  const command = `npx electron-builder --win -c.directories.output=${dir}`;
  run(command);
  const landed = relocate({ from, to, fs: fsApi, path: pathApi });
  return { dir, command, cleared, landed };
}
