// Checks the uninstall answer: the order it is made of, and that nothing the
// flush does can cancel the uninstall.
//
// No Electron here, and no real uninstaller either — `app:uninstall` spawns the
// real one, which deletes the directory this check would be running from. So the
// handler is called the way `main.js` calls it, with the four collaborators it
// acts on replaced by doubles: the plan says what to spawn, the store says when
// the flush is done, the spawner records that it ran, and the quit records that
// it did not run too early. The *order* is the thing under test.
//
// Two failures motivate every check below, and neither is visible from the
// outside:
//
//   1. a flush that runs after the spawn. The uninstaller deletes the profile
//      directory, and the quit's own flush (`before-quit`) fires after the
//      uninstaller has started — so evidence written "during the quit" is
//      written into a directory that is being removed. The evidence is gone and
//      the reopened session looks clean again.
//   2. a quit that beats the reply. The settings page switches to 「正在卸载…」
//      from the reply; a quit in the same tick tears the window down first, and
//      the user sees the app vanish with no confirmation that anything was
//      started.
//
// Run with `npm run audit:uninstall`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const { makeUninstallHandler, UNINSTALL_QUIT_DELAY_MS } = require("../uninstall-handler.js");

const passed = [];
const failed = [];
const check = (name, ok, detail) => {
  (ok ? passed : failed).push(name);
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
};

const TARGET = path.join("C:", "Program Files", "Open Code Review", "Uninstall Open Code Review.exe");

/**
 * One handler, wired the way `main.js` wires it, with every side effect recorded
 * in `order` instead of performed.
 *
 * `schedule` captures the delayed quit rather than running it, so "the quit came
 * after the reply" is a fact about the order the promise resolved in — not a
 * race with a timer that a loaded machine could lose.
 */
function harness(overrides = {}) {
  const order = [];
  const logs = [];
  const scheduled = [];
  const spawnCalls = [];
  const state = { quitCalls: 0 };
  const store = overrides.store || {
    drain: async () => {
      order.push("flush");
      return { ok: true, reason: "drained" };
    },
  };
  const handler = makeUninstallHandler({
    install: overrides.install || { uninstallPlan: () => ({ ok: true, target: TARGET }) },
    store,
    spawn: (target) => {
      spawnCalls.push(target);
      order.push(`spawn:${target}`);
      if (overrides.spawnThrows) throw new Error("EPERM: the uninstaller is in use");
      return {};
    },
    quit: () => {
      state.quitCalls += 1;
      order.push("quit");
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
    warn: (line) => logs.push(line),
    ...(overrides.handler || {}),
  });
  return { handler, order, logs, scheduled, spawnCalls, state };
}

/* ---- the order: flush, spawn, reply, quit ---- */
{
  const h = harness();
  const answer = await h.handler();
  check("the handler answers the settings page", answer && answer.ok === true, JSON.stringify(answer));
  check(
    "the evidence is flushed before the uninstaller starts",
    h.order[0] === "flush",
    h.order.join(" -> ")
  );
  check(
    "and the uninstaller is started with the target the plan named",
    h.order[1] === `spawn:${TARGET}` && h.spawnCalls.length === 1 && h.spawnCalls[0] === TARGET,
    JSON.stringify(h.spawnCalls)
  );
  check("nothing else is spawned", h.spawnCalls.length === 1, `${h.spawnCalls.length} spawns`);
  check(
    "the quit is scheduled, not called while the reply is being made",
    h.state.quitCalls === 0 && h.order.length === 2,
    `${h.order.join(" -> ")} / ${h.state.quitCalls} quits`
  );
  check(
    "with the named delay that exists for the reply to be drawn",
    h.scheduled.length === 1 && h.scheduled[0].ms === UNINSTALL_QUIT_DELAY_MS && UNINSTALL_QUIT_DELAY_MS > 0,
    JSON.stringify(h.scheduled.map((s) => s.ms))
  );
  // The reply has already been returned at this point, which is the whole reason
  // the quit is scheduled: run the captured callback and the app finally quits.
  h.scheduled[0].fn();
  check("and the app quits once, after the reply", h.state.quitCalls === 1 && h.order[2] === "quit", h.order.join(" -> "));
  check("a clean flush says nothing in the log", h.logs.length === 0, JSON.stringify(h.logs));
}

/* ---- a flush that did not work must not cancel the uninstall ---- */
{
  // The store's own failure, as a value: the queue never stopped moving, or the
  // disk did not answer inside the bound. `flushNow` answers one of these instead
  // of rejecting, and the uninstall carries on — the evidence is worth a line,
  // not the whole action.
  const gaveUp = harness({
    store: {
      drain: async () => ({ ok: false, reason: "timeout" }),
    },
  });
  const answer = await gaveUp.handler();
  check("a flush that timed out does not hold the uninstall", answer && answer.ok === true, JSON.stringify(answer));
  check(
    "and the uninstaller is still started",
    gaveUp.spawnCalls.length === 1,
    gaveUp.order.join(" -> ")
  );
  check(
    "and the quit is still scheduled, so the app does not sit there",
    gaveUp.scheduled.length === 1,
    `${gaveUp.scheduled.length} scheduled`
  );
  // The line has to come out *before* the uninstaller starts: it deletes the
  // profile directory right after, so this is the last moment the loss can be
  // reported at all — and the sink is the renderer's log, not a terminal a
  // packaged app does not have.
  check(
    "and the loss is logged before the uninstaller starts",
    gaveUp.logs.length === 1 &&
      gaveUp.logs[0].startsWith("[run-diagnostics]") &&
      gaveUp.logs[0].includes("上限证据") &&
      gaveUp.order.indexOf("flush") < gaveUp.order.findIndex((e) => e.startsWith("spawn:")),
    JSON.stringify(gaveUp.logs)
  );
  check(
    "with the wording the log drawer opens itself on",
    /失败|无法|写得太慢/.test(gaveUp.logs[0] || ""),
    gaveUp.logs[0]
  );
}

/* ---- a flush that breaks outside its own promise ---- */
{
  // `flushAndReport` answers a value for every way the *store's* flush can end.
  // What is left is everything around it — a store that is not a store, a
  // `drain` that is not a function — and the uninstall must survive that too:
  // for this path a throw is not a log line, it is an uninstall that spawned
  // nothing and answered nothing.
  const broken = harness({
    store: {
      drain: () => {
        throw new Error("the store is not a store");
      },
    },
  });
  const answer = await broken.handler();
  check("a flush that throws still answers the page", answer && answer.ok === true, JSON.stringify(answer));
  check(
    "and still starts the uninstaller",
    broken.spawnCalls.length === 1,
    broken.order.join(" -> ")
  );
  check(
    "and says the flush itself went wrong",
    broken.logs.length === 1 && broken.logs[0].includes("冲刷出错"),
    JSON.stringify(broken.logs)
  );
}

/* ---- nothing to uninstall: answer the plan, touch nothing ---- */
{
  const refusal = { ok: false, error: "免安装版没有卸载器：直接删除该 exe 即可，程序不写注册表。" };
  const h = harness({ install: { uninstallPlan: () => refusal } });
  const answer = await h.handler();
  check("a build with no uninstaller gets the plan's own sentence", answer === refusal, JSON.stringify(answer));
  check(
    "and nothing is flushed, spawned or scheduled on the way",
    h.order.length === 0 && h.spawnCalls.length === 0 && h.scheduled.length === 0,
    h.order.join(" -> ")
  );
  check(
    "so the app stays usable to read the sentence",
    h.state.quitCalls === 0,
    `${h.state.quitCalls} quits`
  );
}

/* ---- a spawn that throws: do not quit ---- */
{
  const h = harness({ spawnThrows: true });
  const answer = await h.handler();
  check(
    "an uninstaller that cannot be started is reported, not claimed",
    answer && answer.ok === false && /启动卸载程序失败/.test(answer.error || ""),
    JSON.stringify(answer)
  );
  check("with the error the platform gave", /EPERM/.test(answer.error || ""), answer.error);
  check(
    "and the flush had already run, because that is the order",
    h.order[0] === "flush",
    h.order.join(" -> ")
  );
  check(
    "and the app does not quit, or the page could not show that sentence",
    h.scheduled.length === 0 && h.state.quitCalls === 0,
    `${h.scheduled.length} scheduled / ${h.state.quitCalls} quits`
  );
}

/* ---- the wiring `main.js` actually uses ---- */
{
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const preloadSrc = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
  // A detail on a passing check is noise, so every source check below states its
  // reason only when it failed — the shape the rest of the source checks in this
  // repository use.
  const why = (ok, message) => (ok ? "" : message);

  const requiresFactory = mainSrc.includes('require("./uninstall-handler")');
  const usesFactory = /makeUninstallHandler\(\{/.test(mainSrc);
  check(
    "main.js registers the handler from uninstall-handler.js",
    requiresFactory && usesFactory,
    why(requiresFactory && usesFactory, requiresFactory ? "main.js does not use the factory" : "main.js does not require it")
  );
  const registers = /ipcMain\.handle\(\s*["']app:uninstall["']\s*,\s*uninstall\s*\)/.test(mainSrc);
  const invokes = /invoke\(\s*["']app:uninstall["']/.test(preloadSrc);
  check(
    "and the channel is the one preload invokes",
    registers && invokes,
    why(registers && invokes, `main registers: ${registers}, preload invokes: ${invokes}`)
  );
  // The order this file checks used to be eleven lines of `main.js`'s handler
  // body, where nothing could call it. What has to stay true is that the body
  // is not back: no flush awaited there, no quit scheduled there.
  const flushesThere = /await flushAndReport\(/.test(mainSrc) || /await flushNow\(/.test(mainSrc);
  check(
    "main.js does not flush the evidence itself any more",
    !flushesThere,
    why(!flushesThere, "main.js awaits a flush")
  );
  // One `spawn(` call in the whole file, and it is the collaborator the handler
  // is handed — not a spawn on the handler's path, which is the thing this file
  // checks without Electron. `app.quit()` is the same story: it appears as the
  // `quit:` collaborator and in the lifecycle handlers, never as a delay the
  // uninstall path set up itself.
  const spawnCalls = (mainSrc.match(/\bspawn\(/g) || []).length;
  check(
    "the one spawn in main.js is the collaborator, not the uninstall path",
    spawnCalls === 1,
    why(spawnCalls === 1, `${spawnCalls} spawn( calls`)
  );
  const schedulesQuit = /\bsetTimeout\(\s*\(\)\s*=>\s*app\.quit\(\)/.test(mainSrc);
  check(
    "and the uninstall path does not schedule the quit itself",
    !schedulesQuit,
    why(!schedulesQuit, "main.js still schedules the uninstall quit")
  );
  // One copy of the delay, and it is the module's: a second copy in `main.js`
  // would be the one that drifts, and the check above would still pass.
  const ownDelay = /UNINSTALL_QUIT_DELAY_MS\s*=/.test(mainSrc);
  check(
    "the reply delay is named in exactly one place",
    !ownDelay,
    why(!ownDelay, "main.js declares its own copy of the delay")
  );
  // And the platform detail that *is* `main.js`'s business stays there: the
  // uninstaller is spawned detached and `unref`ed, because it deletes the
  // directory this process runs from.
  const detached = /spawn:\s*\(target\)\s*=>\s*spawn\(target,\s*\[\],\s*\{[^}]*detached:\s*true[^}]*\}\)\.unref\(\)/.test(mainSrc);
  check(
    "the detached spawn is still detached",
    detached,
    why(detached, "the spawn passed to the handler is not a detached, unref'ed one")
  );
}

console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) process.exit(1);
