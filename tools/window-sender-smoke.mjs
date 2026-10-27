// Pins the one property `window-sender.js` exists for: a line produced before
// the renderer can take it is *held and delivered*, in order — not dropped.
//
// Why this exists: the old `send()` in `main.js` was `if (mainWindow &&
// !mainWindow.isDestroyed()) mainWindow.webContents.send(…)`. That guard is
// correct about the crash it avoids and silent about everything else, so
// `updater.init()` (which runs before `createWindow()`) and any `run:log` line
// produced while the page was loading went nowhere. Nothing failed, nothing
// looked wrong, and the one channel a packaged app can read was exactly the one
// losing lines. A behaviour like that cannot be checked by reading the source:
// the line has to be *sent* with no receiver and then be *found*.
//
// The suite is in two halves, and the second one is what makes the first
// trustworthy:
//   1. the real module: order, queueing, bound, reload, a receiver that breaks
//      mid-flush;
//   2. the same questions asked of hand-written wrong senders — the old
//      drop-silently guard, and one that holds the lines but flushes them
//      backwards. Both must *fail* the property, or the property is not about
//      anything (an assertion that also passes for a dropper proves nothing).
//
// No Electron, no window, no filesystem beyond this repo's own sources.
// Run with `npm run audit:sender`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { createWindowSender, DEFAULT_PENDING_LIMIT } = require(path.join(ROOT, "window-sender.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- the window, and what it recorded -------------------------------------
 * `sendThrows(call)` decides per call whether `webContents.send` throws — the
 * one failure mode a real window has (it is torn down between "is there a
 * window" and "send"). `state.destroyed` covers the other one.
 */
const makeWindow = ({ sendThrows = () => null, destroyed = false } = {}) => {
  const received = [];
  const state = { destroyed };
  let calls = 0;
  const win = {
    received,
    state,
    isDestroyed: () => state.destroyed,
    webContents: {
      send: (channel, payload) => {
        calls += 1;
        const throwIt = sendThrows(calls, channel, payload);
        if (throwIt) throw throwIt;
        received.push({ channel, payload });
      },
    },
  };
  return win;
};

const label = (entry) => `${entry.channel}:${entry.payload.line ?? JSON.stringify(entry.payload)}`;

/* ---- 1. the shape of the module itself ---- */
{
  let threw = null;
  try {
    createWindowSender({});
  } catch (err) {
    threw = err;
  }
  check(
    "a sender without a window getter is refused, and says which argument is missing",
    threw instanceof TypeError && /currentWindow/.test(threw.message),
    threw ? `${threw.name}: ${threw.message}` : "did not throw"
  );
  check(
    "the pending bound is a positive integer by default",
    Number.isInteger(DEFAULT_PENDING_LIMIT) && DEFAULT_PENDING_LIMIT > 0,
    String(DEFAULT_PENDING_LIMIT)
  );
}

/* ---- 2. before there is a window: held, not dropped ---- */
{
  let current = null;
  const sender = createWindowSender({ currentWindow: () => current });
  const first = sender.send("update:state", { ready: false });
  const second = sender.send("run:log", { line: "启动时的一行" });
  check(
    "with no window yet, a send answers 'not delivered' and the line waits",
    first === false && second === false && sender.pending() === 2,
    JSON.stringify({ first, second, pending: sender.pending() })
  );

  const win = makeWindow();
  current = win;
  const announcement = sender.markReady();
  check(
    "...and both lines reach the window, in the order they were sent, on markReady",
    JSON.stringify(win.received.map(label)) ===
      JSON.stringify(["update:state:{\"ready\":false}", "run:log:启动时的一行"]) && announcement.sent === 2,
    JSON.stringify({ received: win.received.map(label), sent: announcement.sent })
  );
  check(
    "...the queue is empty afterwards and nothing was reported lost",
    sender.pending() === 0 && announcement.lost === 0,
    JSON.stringify({ pending: sender.pending(), lost: announcement.lost })
  );

  // A window object that exists is *not* readiness: the page has not run, so a
  // send into it is the same drop. This is the half the old guard could not see.
  // A newly created window is exactly that state (`main.js` says so with
  // `markUnready()` when it builds one).
  const reloaded = makeWindow();
  current = reloaded;
  sender.markUnready();
  check(
    "a window that exists but has not finished loading does not take lines",
    sender.send("run:log", { line: "页面还没加载" }) === false && sender.pending() === 1,
    JSON.stringify({ pending: sender.pending() })
  );
  sender.markReady();
  check(
    "...so they are delivered once the page says it is loaded",
    JSON.stringify(reloaded.received.map(label)) === JSON.stringify(["run:log:页面还没加载"]),
    JSON.stringify(reloaded.received.map(label))
  );
  check(
    "a ready window takes the next line immediately, without queueing it",
    sender.send("run:log", { line: "直接送出" }) === true && sender.pending() === 0,
    JSON.stringify({ pending: sender.pending() })
  );
}

/* ---- 3. the window going away, and coming back ---- */
{
  let current = null;
  const sender = createWindowSender({ currentWindow: () => current });
  const old = makeWindow();
  current = old;
  sender.markReady();
  sender.send("run:log", { line: "旧窗口的一行" });

  // Destroyed window: the guard in the old code answered this case; the
  // difference is what happens to the line.
  old.state.destroyed = true;
  check(
    "a destroyed window does not take the line",
    sender.send("run:log", { line: "窗口关掉了" }) === false && sender.pending() === 1,
    JSON.stringify({ pending: sender.pending() })
  );

  // The app recreates the window; only the new one is asked.
  const fresh = makeWindow();
  current = fresh;
  sender.markUnready();
  sender.markReady();
  check(
    "...and the recreated window receives it, not the dead one",
    JSON.stringify(fresh.received.map(label)) === JSON.stringify(["run:log:窗口关掉了"]) &&
      old.received.length === 1,
    JSON.stringify({ fresh: fresh.received.map(label), old: old.received.map(label) })
  );

  // A window whose webContents has been torn down mid-send throws. That is the
  // same answer as "no receiver": hold it for the next one, do not throw out of
  // whatever produced the line (a run, an update, a probe).
  let current2 = null;
  const sender2 = createWindowSender({ currentWindow: () => current2 });
  const throwing = makeWindow({ sendThrows: () => new Error("Object has been destroyed") });
  current2 = throwing;
  sender2.markReady();
  let escaped = null;
  try {
    sender2.send("run:log", { line: "发送时窗口已经没了" });
  } catch (err) {
    escaped = err;
  }
  check(
    "a send that throws does not escape the sender; the line waits instead",
    escaped === null && sender2.pending() === 1,
    escaped ? escaped.message : JSON.stringify({ pending: sender2.pending() })
  );
  const recovered = makeWindow();
  current2 = recovered;
  sender2.markReady();
  check(
    "...and the next window gets it",
    JSON.stringify(recovered.received.map(label)) === JSON.stringify(["run:log:发送时窗口已经没了"]),
    JSON.stringify(recovered.received.map(label))
  );
}

/* ---- 4. a receiver that breaks in the middle of a flush ---- */
{
  let current = null;
  const sender = createWindowSender({ currentWindow: () => current });
  ["a", "b", "c"].forEach((line) => sender.send("run:log", { line }));

  // Second call throws: `a` goes out, `b` is refused, `c` must not overtake it.
  let broken = true;
  const faltering = makeWindow({
    sendThrows: (call) => (broken && call === 2 ? new Error("页面正在卸载") : null),
  });
  current = faltering;
  const announcement = sender.markReady();
  check(
    "a receiver that breaks mid-flush takes the prefix and keeps the rest queued",
    announcement.sent === 1 && sender.pending() === 2,
    JSON.stringify({ sent: announcement.sent, pending: sender.pending() })
  );

  broken = false;
  sender.markReady();
  check(
    "...and the rest follows in the same order, once, with no duplicate",
    JSON.stringify(faltering.received.map(label)) ===
      JSON.stringify(["run:log:a", "run:log:b", "run:log:c"]),
    JSON.stringify(faltering.received.map(label))
  );
}

/* ---- 5. the bound, and the loss that is reported ---- */
{
  let current = null;
  const sender = createWindowSender({ currentWindow: () => current, limit: 3 });
  check("the bound is the one that was asked for", sender.limit === 3, String(sender.limit));
  ["1", "2", "3", "4", "5"].forEach((line) => sender.send("run:log", { line }));
  check(
    "past the bound the queue stops growing, and the newest lines are the ones kept",
    sender.pending() === 3,
    JSON.stringify({ pending: sender.pending() })
  );
  const win = makeWindow();
  current = win;
  const announcement = sender.markReady();
  check(
    "...and the count of what the bound cost comes back from markReady",
    announcement.lost === 2 && announcement.sent === 3,
    JSON.stringify(announcement)
  );
  check(
    "...the delivered lines are the tail, in order",
    JSON.stringify(win.received.map(label)) ===
      JSON.stringify(["run:log:3", "run:log:4", "run:log:5"]),
    JSON.stringify(win.received.map(label))
  );
  const again = sender.markReady();
  check(
    "...and the loss is reported once, not on every later ready",
    again.lost === 0 && again.sent === 0,
    JSON.stringify(again)
  );

  // A limit that is not a positive integer falls back to the default rather
  // than to "unbounded" (a typo turning the memory bound off) or to 0 (a queue
  // that throws every line away, which is the old bug with extra steps).
  const odd = [0, -5, 1.5, "9", null].map(
    (limit) => createWindowSender({ currentWindow: () => null, limit }).limit
  );
  check(
    "a limit that is not a positive integer falls back to the default bound",
    odd.every((limit) => limit === DEFAULT_PENDING_LIMIT),
    JSON.stringify({ odd, default: DEFAULT_PENDING_LIMIT })
  );
}

/* ---- 6. the same questions asked of wrong senders ----
 * `deliversBeforeReady` is the property, written once and applied to three
 * implementations. The real one has to pass; the two wrong ones have to fail,
 * each for its own reason — otherwise this suite would also be satisfied by the
 * code it replaced.
 */
const deliversBeforeReady = (make) => {
  let current = null;
  const sender = make(() => current);
  sender.send("update:state", { ready: false });
  sender.send("run:log", { line: "a" });
  sender.send("run:log", { line: "b" });
  current = makeWindow();
  sender.markReady();
  return current.received.map(label);
};

const WANT = ["update:state:{\"ready\":false}", "run:log:a", "run:log:b"];
const realSender = (getWindow) => createWindowSender({ currentWindow: getWindow });

/** The old shape: harmless-looking guard, silent drop. */
const droppingSender = (getWindow) => ({
  send: (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  },
  markReady: () => {},
  markUnready: () => {},
});

/** Holds the lines and delivers them — last one first. */
const lifoSender = (getWindow) => {
  const held = [];
  return {
    send: (channel, payload) => {
      held.push([channel, payload]);
    },
    markReady: () => {
      const win = getWindow();
      while (held.length) {
        const [channel, payload] = held.pop();
        win.webContents.send(channel, payload);
      }
    },
    markUnready: () => {},
  };
};

check(
  "the real sender delivers everything sent before the renderer was ready, in order",
  JSON.stringify(deliversBeforeReady(realSender)) === JSON.stringify(WANT),
  JSON.stringify(deliversBeforeReady(realSender))
);
check(
  "...and the old guard fails that question: it drops the lines it cannot deliver",
  JSON.stringify(deliversBeforeReady(droppingSender)) !== JSON.stringify(WANT),
  JSON.stringify(deliversBeforeReady(droppingSender))
);
check(
  "...and so does a sender that holds the lines but flushes them backwards",
  JSON.stringify(deliversBeforeReady(lifoSender)) !== JSON.stringify(WANT),
  JSON.stringify(deliversBeforeReady(lifoSender))
);

/* ---- 7. main.js only wires it ----
 * The module above can be perfect while the app keeps a second door, or forgets
 * to say "ready". Both are static facts about the wiring, so they are read from
 * the source with the comments stripped — the registration explains this in
 * prose and a check that forbade the words would make the comment the thing to
 * delete.
 */
{
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const mainSrc = stripComments(fs.readFileSync(path.join(ROOT, "main.js"), "utf8"));
  check(
    "main.js builds the sender from the real window getter",
    /createWindowSender\(\s*\{\s*currentWindow:\s*\(\s*\)\s*=>\s*mainWindow\s*\}\s*\)/.test(mainSrc),
    "no createWindowSender({ currentWindow: () => mainWindow })"
  );
  check(
    "main.js's send goes through it",
    /const\s+send\s*=\s*\(\s*channel\s*,\s*payload\s*\)\s*=>\s*windowSender\.send\(/.test(mainSrc),
    "main.js defines its own send"
  );
  check(
    "...it marks the sender ready on the renderer's own load event",
    /did-finish-load/.test(mainSrc) && /windowSender\.markReady\(\)/.test(mainSrc),
    "no did-finish-load → markReady wiring"
  );
  check(
    "...it marks it unready when a window is created, so a reload queues instead of dropping",
    /windowSender\.markUnready\(\)/.test(mainSrc),
    "markUnready is never called"
  );
  check(
    "...and it reports what the bound cost, on the channel a packaged app can read",
    /windowSender\.limit/.test(mainSrc) && /send\(\s*"run:log"\s*,\s*\{\s*line/.test(mainSrc),
    "the dropped count is not said out loud"
  );

  // One door: no other root module may *send* on a window's `webContents`. A
  // second door would keep working for as long as the window happens to be up,
  // which is exactly how the first one hid. Listening is a different thing and
  // stays allowed — `main.js` subscribes to `did-finish-load`, which is how the
  // door learns the page is up — so the question asked of every other module is
  // "what do you do with `webContents`", and the only allowed answer is an event
  // subscription.
  const rootModules = fs
    .readdirSync(ROOT)
    .filter((file) => file.endsWith(".js") && file !== "preload.js" && file !== "window-sender.js");
  const LISTEN_ONLY = ["on", "once"];
  const uses = [];
  for (const file of rootModules) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
    for (const match of src.matchAll(/\.webContents\b\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (!LISTEN_ONLY.includes(match[1])) uses.push(`${file}: ${match[1]}`);
    }
  }
  const senderSrc = stripComments(fs.readFileSync(path.join(ROOT, "window-sender.js"), "utf8"));
  check(
    "every other root module only listens on webContents; sending is the sender's job",
    uses.length === 0,
    uses.join(", ")
  );
  // ...and the question really asks it: the same scan finds a direct send in a
  // constructed line. Without this, a typo in the regex would answer "only
  // listeners" for a file that sends from three places.
  const constructed = 'mainWindow.webContents.send("run:log", { line: "x" });';
  const constructedUses = [...constructed.matchAll(/\.webContents\b\s*\.\s*([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1])
    .filter((method) => !LISTEN_ONLY.includes(method));
  check(
    "...and a direct send in a constructed module is caught by it",
    JSON.stringify(constructedUses) === JSON.stringify(["send"]),
    JSON.stringify(constructedUses)
  );
  check(
    "...and it really is the one that sends on it",
    /\.webContents\b/.test(senderSrc) && /contents\.send\(/.test(senderSrc),
    "window-sender.js does not send"
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all window-sender checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
