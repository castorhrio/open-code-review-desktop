// The stub Electron objects `install-info.js` takes, in one place.
//
// Two suites build these stubs — `tools/install-info-smoke.mjs` (behaviour: the
// four install shapes, the ancestor walk, the shell refusals) and
// `tools/app-info-smoke.mjs` (the `app:info` payload's key set, which spreads
// `installInfo()` into the IPC answer). Each used to carry its own copy of the
// `app` / `shell` stubs and of the six install facts, and the two copies were
// asserted to agree only in prose: one said "the same six names as
// `app-info-smoke`'s `expected` list". A drift in either copy would make the two
// assertions disagree in opposite directions — one suite red for a key the other
// had just invented — without saying which copy was the stale one.
//
// So the parameter set lives here, and both suites import it. `install-info-smoke`
// still answers its own filesystem questions (real temp dirs, injected `exists` /
// `readdir` / `dirname`), because those *are* the behaviour under test; what it
// shares is the shape of the stubs and the list of facts, which is what the two
// suites have to agree about.
//
// `app-info-smoke.mjs` additionally asserts that this fixture's stub answers
// exactly `INSTALL_INFO_KEYS`, and that both suites import this file — so a
// second copy of the stub parameters cannot quietly come back.
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { createInstall } = require(path.join(ROOT, "install-info.js"));

/**
 * The six facts `installInfo()` answers, sorted. Hand-written on purpose: it is
 * the *contract* the settings page and `src/lib/types.ts` read by name, so it
 * must come from somewhere a person wrote down, not from the module that would
 * define whatever it happens to return. Both suites compare against this list,
 * and the failure prints the key that appeared or left.
 */
export const INSTALL_INFO_KEYS = Object.freeze([
  "canUninstall",
  "executable",
  "installDir",
  "packaged",
  "portable",
  "userData",
]);

/**
 * The names `formatAppInfo()` returns *for itself*, sorted — i.e. the payload's
 * non-install half. `app:info` spreads `installInfo()` before them, so an
 * install fact with one of these names would silently lose to the computed
 * value. That is the decision (computed wins), but it must stay a decision on
 * both sides: this list lets `install-info-smoke.mjs` assert the module never
 * *offers* a colliding name, and `app-info-smoke.mjs` assert the collision still
 * resolves the other way even if one appears.
 *
 * The list is the authority, not a reflection of whatever the module happens to
 * return. `app-info-smoke.mjs` asserts one direction only — every key
 * `formatAppInfo()` returns is named here — and runs the collision proof over
 * *this* list, not over the return value. A field added to the return object
 * without being named here is therefore red, while a name listed here that the
 * function does not return is harmless (the fixture then contributes an ordinary
 * install fact). Deriving the collision surface from the return value instead
 * would make the two sides provable from each other: add a field and the list
 * together and every check stays green while the new field's collision is never
 * tried.
 */
export const APP_INFO_COMPUTED_KEYS = Object.freeze([
  "appVersion",
  "binary",
  "binarySource",
  "configPath",
  "docsUrl",
  "platform",
  "version",
]);

/**
 * `shell` that records the calls instead of opening a file manager.
 * `openError` is what `shell.openPath` resolves to — Electron's contract is that
 * a failure comes back as a non-empty string, not as a rejection.
 *
 * `openThrows` is the shell that rejects anyway. That is not the contract, but it
 * is not this module's contract either, and an unhandled rejection here reaches
 * the renderer as a thrown `await` — the one failure shape that says nothing.
 * Any value other than `undefined` is thrown as-is, so the two reasonless shapes
 * (`null`, and an `Error` with an empty message) can each be stubbed exactly.
 * `undefined` therefore means "do not throw" — not `null`, which is a value to
 * throw and the one case a message cannot be read off.
 */
export const makeShell = (openError = "", openThrows = undefined) => {
  const calls = { reveal: [], open: [] };
  return {
    calls,
    showItemInFolder: (p) => calls.reveal.push(p),
    openPath: async (p) => {
      calls.open.push(p);
      if (openThrows !== undefined) throw openThrows;
      return openError;
    },
  };
};

/**
 * `app` with only the two members install-info reads. `getPath("exe")` answers
 * with a path under the install root, because that is the only thing the
 * renderer shows for it; every name other than `userData` answers the exe, which
 * is what Electron does for `exe` and what the module asks for.
 */
export const makeApp = ({
  packaged = true,
  resources = "",
  userData = "/home/me/.config/app",
  exe = "/opt/app/app",
} = {}) => ({
  isPackaged: packaged,
  resourcesPath: resources,
  getPath: (name) => (name === "userData" ? userData : exe),
});

/**
 * The whole parameter object `createInstall` takes, with the canonical stub
 * values: an installed copy (packaged, not portable) whose resources live under
 * `/opt/app/resources`, so `installDir` is `/opt/app`.
 *
 * `exists` / `readdir` answer without touching the filesystem and `platform` is
 * `linux`, so this fixture describes the *payload shape* only — no uninstaller
 * can be found on linux, hence `canUninstall: false`. Anything that needs the
 * disk (the uninstaller scan, the ancestor walk) injects its own answers through
 * the same overrides; keeping the defaults disk-free is what lets
 * `app-info-smoke.mjs` ask about the key set on every host.
 */
export const installStubs = ({
  app = makeApp(),
  shell = makeShell(),
  platform = "linux",
  env = {},
  resourcesPath = () => "/opt/app/resources",
  exists = () => true,
  readdir = () => [],
  dirname = path.dirname,
} = {}) => ({ app, shell, platform, env, resourcesPath, exists, readdir, dirname });

/** `install-info.js` built from the canonical stubs, for callers that only want
 *  `installInfo()` — the payload-shape half of the contract. */
export const stubInstall = (overrides = {}) => createInstall(installStubs(overrides));
