// The renderer reaches the main process through one object, and the only thing
// describing it is a hand-written interface that nothing checks.
//
// `src/lib/api.ts` ends with
//
//     export const api = (window as unknown as { api: Bridge }).api;
//
// a *cast*, so TypeScript never verifies that `preload.js` implements `Bridge`.
// A method added to the interface but not to the preload object is `undefined`
// at runtime and throws on first call; a method renamed in one place and not the
// other is the same failure with a different name. Neither `tsc` nor the UI audit
// can see it — the audit's stub is written against the interface's expectations,
// so it agrees with the interface by construction and would keep agreeing after
// the real preload had drifted away.
//
// So: load the actual preload with a stubbed `electron`, capture what it really
// exposes, and compare both directions.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const passed = [];
const failed = [];
const check = (name, ok, detail) => {
  (ok ? passed : failed).push(name);
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// What preload actually exposes, by running it.
// ---------------------------------------------------------------------------
let exposedKey = null;
let exposed = null;
// Every `ipcRenderer.invoke` the preload made, with what it forwarded.
const invoked = [];

const electronStub = {
  contextBridge: {
    exposeInMainWorld: (key, obj) => {
      exposedKey = key;
      exposed = obj;
    },
  },
  ipcRenderer: {
    // Never reached at load time — preload's methods are lazy closures — but the
    // stub has to exist or requiring the module throws. What it *does* record is
    // what each method forwards, which is how the argument shapes are checked
    // below.
    invoke: (channel, ...args) => {
      invoked.push({ channel, args });
      return Promise.resolve();
    },
    on: () => {},
    removeListener: () => {},
  },
};

const sandbox = {
  require: (name) => {
    if (name === "electron") return electronStub;
    throw new Error(`preload.js required "${name}", which this check does not stub`);
  },
  module: { exports: {} },
  exports: {},
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const preloadPath = path.join(root, "preload.js");
try {
  vm.runInContext(fs.readFileSync(preloadPath, "utf8"), sandbox, { filename: preloadPath });
} catch (err) {
  check("preload.js loads", false, String(err && err.message));
  console.log(`\n${passed.length} ok, ${failed.length} failed`);
  process.exit(1);
}
check("preload.js loads", true);

// The renderer reads `window.api`; a different key would leave `api` undefined.
check("preload exposes the object the renderer reads", exposedKey === "api", exposedKey === "api" ? "" : `exposed "${exposedKey}", renderer reads "api"`);

const real = exposed && typeof exposed === "object" ? Object.keys(exposed).sort() : [];
check("preload exposes at least one method", real.length > 0, `${real.length} methods`);

// ---------------------------------------------------------------------------
// What the interface promises.
// ---------------------------------------------------------------------------
const apiTs = fs.readFileSync(path.join(root, "src/lib/api.ts"), "utf8");
const preloadSrc = fs.readFileSync(preloadPath, "utf8");
const bridgeBody = apiTs.match(/export interface Bridge \{([\s\S]*?)\n\}/);
check("the Bridge interface is where this check expects it", Boolean(bridgeBody), bridgeBody ? "" : "could not find `export interface Bridge {` in src/lib/api.ts");

const declared = bridgeBody
  ? [...bridgeBody[1].matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[(<]/gm)].map((m) => m[1]).sort()
  : [];

// ---------------------------------------------------------------------------
// Both directions. A missing method is a runtime crash; an extra one is drift
// that will become a crash the moment someone trusts it.
// ---------------------------------------------------------------------------
const missing = declared.filter((m) => !real.includes(m));
check(
  "every method the renderer declares exists on the preload object",
  missing.length === 0,
  missing.length ? `declared but not exposed: ${missing.join(", ")} — calling one throws "is not a function"` : ""
);

const undeclared = real.filter((m) => !declared.includes(m));
check(
  "every method the preload exposes is declared in the interface",
  undeclared.length === 0,
  undeclared.length ? `exposed but not declared: ${undeclared.join(", ")}` : ""
);

// ---------------------------------------------------------------------------
// The shape of the arguments, not just the names.
// ---------------------------------------------------------------------------
// A method that exists on both sides but takes its arguments in a different
// shape was invisible here: the preload rebuilt the request from two positional
// arguments, and a caller that passed the object the interface promises had it
// arrive as *the name*. The main process then looked up a service called
// "[object Object]", found nothing, and answered "no Key saved" — for every
// service, forever. The six causes the Key wording distinguishes never reached
// the screen, and nothing here noticed.
//
// So the shape is checked in two ways: the number of parameters each side
// declares, and the values a caller passes — which must arrive at the main
// process under the names the interface gave them, not nested one level deeper
// under some other key.
const splitTopLevel = (text, separators = [",", ";"]) => {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // `=>` is an arrow, not a closing angle bracket: without this, a callback
    // type would unbalance every counter below it.
    if (ch === "=" && text[i + 1] === ">") {
      current += "=>";
      i++;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "}" || ch === "]" || ch === ">") depth--;
    if (depth === 0 && separators.includes(ch)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
};

// The parameter list the interface declares for one method.
const interfaceParams = (body, name) => {
  const found = new RegExp(`^ {2}${name}\\b`, "m").exec(body);
  if (!found) return null;
  const open = body.indexOf("(", found.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") {
      depth--;
      if (depth === 0) return splitTopLevel(body.slice(open + 1, i), [","]);
    }
  }
  return null;
};

// The parameter list the preload declares for one method.
const preloadParams = (src, name) => {
  const found = new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)`).exec(src);
  if (!found) return null;
  return found[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
};

// The keys of an inline object type, e.g. `{ name: string; url: string }`.
const objectTypeKeys = (typeText) => {
  const text = typeText.trim();
  if (!text.startsWith("{")) return [];
  const close = text.lastIndexOf("}");
  if (close < 0) return [];
  return splitTopLevel(text.slice(1, close))
    .map((member) => member.split(":")[0].replace(/\?$/, "").trim())
    .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key));
};

const arityMismatches = [];
const shapeMismatches = [];
for (const name of declared) {
  const wanted = interfaceParams(bridgeBody[1], name);
  const actual = preloadParams(preloadSrc, name);
  if (!wanted || !actual) continue;
  if (wanted.length !== actual.length)
    arityMismatches.push(`${name}: the interface declares ${wanted.length}, the preload takes ${actual.length}`);
  if (!wanted.length) continue;

  // The probe: an object with one marker per key when the interface promises an
  // object, positional markers otherwise.
  const paramName = wanted[0].split(":")[0].replace(/\?$/, "").trim();
  const typeText = wanted[0].includes(":") ? wanted[0].slice(wanted[0].indexOf(":") + 1) : "";
  const keys = objectTypeKeys(typeText);
  let args = [];
  let markers = [];
  if (keys.length) {
    const probe = {};
    for (const key of keys) probe[key] = `probe:${name}:${key}`;
    markers = Object.values(probe);
    args = [probe];
  } else {
    markers = wanted.map((_, i) => `probe:${name}:${i}`);
    args = [...markers];
  }

  invoked.length = 0;
  try {
    exposed[name](...args);
  } catch (err) {
    shapeMismatches.push(`${name}: calling it with the interface's shape threw ${err && err.message}`);
    continue;
  }
  // A method that only listens sends nothing; its shape is not a request.
  if (!invoked.length) continue;
  const payload = invoked[0].args[0];
  const top = [];
  const wrapped = {};
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      top.push(value);
      wrapped[key] = value;
    }
  } else {
    top.push(payload);
  }
  // The markers have to arrive as they were sent: at the top level, or inside
  // the one object the interface named (that is how a preload may wrap a
  // request: `invoke("config:test", { form })`).
  const inner = wrapped[paramName];
  const innerValues = inner && typeof inner === "object" ? Object.values(inner) : [];
  const missing = markers.filter((marker) => !top.includes(marker) && !innerValues.includes(marker));
  if (missing.length)
    shapeMismatches.push(
      `${name}: the main process receives ${JSON.stringify(payload)} — ${missing.length} of the values the caller sent never arrive under the interface's names`
    );
}
check(
  "every method takes the number of arguments the interface declares",
  arityMismatches.length === 0,
  arityMismatches.join(" | ")
);
check(
  "and the values a caller sends reach the main process under the interface's names",
  shapeMismatches.length === 0,
  shapeMismatches.join(" | ")
);

// A channel name is a string on both sides, so a typo is a call that never
// resolves rather than an error anyone sees. Read the names out of the source:
// the exposed methods are lazy closures, so nothing is invoked during load and
// watching the stub would report an empty set (which it did, the first time).
const invokeChannels = new Set([...preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]));
const listenChannels = new Set([...preloadSrc.matchAll(/ipcRenderer\.on\(\s*"([^"]+)"/g)].map((m) => m[1]));

check("preload invokes at least one channel", invokeChannels.size > 0, `${invokeChannels.size} channels`);
check("preload listens on at least one channel", listenChannels.size > 0, `${listenChannels.size} channels`);

// Hyphens are part of the verb (`menu:open-repo`), so the verb allows them.
const badChannels = [...invokeChannels, ...listenChannels].filter((c) => !/^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9-]*$/.test(c));
check("every IPC channel is namespaced `domain:verb`", badChannels.length === 0, badChannels.join(", "));

// The handler and sender sides are spread across the main-process modules, so
// read all of them: `ipcMain.handle("update:*")` lives in update-service.js, and
// every event is emitted through main.js's `send(channel, payload)` helper
// rather than through `webContents.send` directly. Scanning main.js alone
// reported six channels as unhandled and five as never sent, none of which was
// true. Root-level `.js` files other than preload.js *are* the main process.
const mainModules = fs.readdirSync(root).filter((f) => f.endsWith(".js") && f !== "preload.js");
const mainSrc = mainModules.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");

const handled = new Set([...mainSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]));
// `send(` also matches `webContents.send(`, so both spellings are covered.
const sent = new Set([...mainSrc.matchAll(/\bsend\(\s*"([^"]+)"/g)].map((m) => m[1]));

const unhandled = [...invokeChannels].filter((c) => !handled.has(c)).sort();
check(
  "every channel preload invokes has an ipcMain handler",
  unhandled.length === 0,
  unhandled.length ? `no handler for: ${unhandled.join(", ")} — the promise never settles` : ""
);

const orphans = [...handled].filter((c) => !invokeChannels.has(c)).sort();
check(
  "every ipcMain handler has a caller in preload",
  orphans.length === 0,
  orphans.length ? `handler with no preload caller: ${orphans.join(", ")}` : ""
);

const neverSent = [...listenChannels].filter((c) => !sent.has(c)).sort();
check(
  "every channel preload listens on is sent by main",
  neverSent.length === 0,
  neverSent.length ? `nothing sends: ${neverSent.join(", ")} — the listener is dead` : ""
);

const sentToNobody = [...sent].filter((c) => !listenChannels.has(c)).sort();
check(
  "every channel main sends has a listener in preload",
  sentToNobody.length === 0,
  sentToNobody.length ? `sent but never listened for: ${sentToNobody.join(", ")}` : ""
);

console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) {
  console.error(`\nbridge contract checks failed: ${failed.join(", ")}`);
  process.exit(1);
}
