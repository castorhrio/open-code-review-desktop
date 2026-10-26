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
// So the shape is checked in three ways: the number of parameters each side
// declares; the values a caller passes — which must arrive at the main process
// under the names the interface gave them, not nested one level deeper under
// some other key; and in the other direction, that nothing arrives under a name
// the interface never declared (the main process reads the names it knows and
// silently ignores the rest, so a renamed field can sit there unread).
//
// The first version of this only looked at the *first* parameter, and only when
// its type was written inline — which covered `savedKey` and little else. Every
// other method passed because the markers were checked for presence anywhere in
// the payload, so `{ repo: ref, ref: repo }` was indistinguishable from correct:
// both values did arrive. Every parameter of every method is now probed by name,
// and swapping two of them fails the check.
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
// `inline` is reported separately from the key count so a type that *is* an
// object literal but yields no keys can be told apart from a type that is not an
// object at all (a `Spec`, a `string`): the first is a parse that got worse, the
// second is a shape this check has nothing to say about.
const objectType = (typeText) => {
  const text = typeText.trim();
  if (!text.startsWith("{")) return { inline: false, keys: [] };
  const close = text.lastIndexOf("}");
  if (close < 0) return { inline: true, keys: [] };
  const keys = splitTopLevel(text.slice(1, close))
    .map((member) => member.split(":")[0].replace(/\?$/, "").trim())
    .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key));
  return { inline: true, keys };
};

// One parameter of one method: the name the interface gives it, and — when the
// type is written inline — the keys that name promises.
const parseParam = (text) => {
  const colon = text.indexOf(":");
  const name = (colon < 0 ? text : text.slice(0, colon)).replace(/\?$/, "").trim();
  const typeText = colon < 0 ? "" : text.slice(colon + 1).trim();
  const { inline, keys } = objectType(typeText);
  return { name, typeText, keys, inlineObject: inline };
};

// Where a value sits inside what the main process received, as a key path.
const collectPaths = (value, path, into) => {
  if (typeof value === "string") {
    if (!into.has(value)) into.set(value, []);
    into.get(value).push(path);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, inner] of Object.entries(value)) collectPaths(inner, [...path, key], into);
};

// The key paths a value is allowed to arrive at. The interface names the
// parameter; a preload may forward the object flat (`invoke("file:read", req)`)
// or wrapped under the parameter's own name (`invoke("config:test", { form })`),
// and both are honest. Anything else — a different name, one level deeper under
// some other key — is the drift this check exists for.
const allowedPaths = (param, paramCount) => {
  if (param.keys.length) {
    const named = param.keys.map((key) => [param.name, key]);
    return paramCount === 1 ? [...named, ...param.keys.map((key) => [key])] : named;
  }
  const paths = [[param.name]];
  if (paramCount === 1) paths.push([]);
  return paths;
};

const markerFor = (method, param, key) => (key ? `probe:${method}:${param.name}.${key}` : `probe:${method}:${param.name}`);

// Methods that only subscribe to a channel: the contract is "call it with the
// callback the interface declares and it will call back", and nothing crosses the
// bridge in the other direction, so there is no payload whose shape could be
// checked. Keeping this list explicit is the point. Everything *not* on it has to
// reach the main process when called, so a method that used to send a request and
// stopped — a renamed channel, a dropped `invoke`, a method whose request moved
// behind a condition — fails instead of silently losing its shape checks while the
// name-only comparison above stays green.
const LISTENER_METHODS = new Set(["onUpdateState", "onLog", "onExit", "onProgress", "onMenuOpenRepo"]);

const arityMismatches = [];
const shapeMismatches = [];
const extraKeyMismatches = [];
const parseFailures = [];
const unprobed = [];
const listenerDrift = [];
const describePath = (path) => (path.length ? `\`${path.join(".")}\`` : "the argument itself");

for (const name of declared) {
  const wantedList = interfaceParams(bridgeBody[1], name);
  const actual = preloadParams(preloadSrc, name);
  // `continue` on a failed parse is what a silently worse parser looks like: the
  // method stops being examined at all, while the name-only checks above stay
  // green. A signature this parser does not understand — method shorthand in the
  // preload instead of a `name: (…) =>` property, an object type written as an
  // index signature, a declaration with no parenthesised parameter list — used to
  // leave that method's shape unexamined with nothing said about it. (A parameter
  // list spread over several lines *is* understood: the splitter below keeps
  // nesting depth, not line breaks.) So the parse is a claim of its own, and it
  // has to fail out loud.
  if (!wantedList) {
    parseFailures.push(`${name}: could not read its parameter list out of the Bridge interface — its shape went unchecked`);
    continue;
  }
  if (!actual) {
    parseFailures.push(`${name}: could not read its parameter list out of preload.js — its shape went unchecked`);
    continue;
  }
  if (wantedList.length !== actual.length)
    arityMismatches.push(`${name}: the interface declares ${wantedList.length}, the preload takes ${actual.length}`);

  const params = wantedList.map(parseParam);
  for (const param of params) {
    // An inline object type with zero keys is a parse that got worse, not a
    // parameter without fields: every key below would go unexamined while the
    // check stayed green.
    if (param.inlineObject && !param.keys.length)
      parseFailures.push(`${name}: the inline object type of \`${param.name}\` yields no keys, so its fields went unchecked`);
  }
  // The probe: one marker per interface parameter, and per key of every inline
  // object type — so a value that lands under the wrong name, or a key the
  // preload invents or drops, shows up as a marker that never arrives where the
  // interface said it would.
  const probeArgs = params.map((param) =>
    param.keys.length
      ? Object.fromEntries(param.keys.map((key) => [key, markerFor(name, param, key)]))
      : markerFor(name, param, "")
  );

  invoked.length = 0;
  let threw = null;
  try {
    exposed[name](...probeArgs);
  } catch (err) {
    threw = err;
  }
  const isListener = LISTENER_METHODS.has(name);
  const sentNothing = invoked.length === 0;

  if (threw) {
    shapeMismatches.push(`${name}: calling it with the interface's shape threw ${threw && threw.message}`);
    continue;
  }
  if (isListener) {
    if (!sentNothing)
      listenerDrift.push(`${name}: listed as a listener but it sends an IPC request, so its shape is not the listener shape`);
    continue;
  }
  if (sentNothing) {
    // Nothing was invoked, so there is no payload to examine. For anything but a
    // listener that is a method that no longer works, not a method with nothing to
    // check — and "nothing to check" is exactly how it used to be skipped.
    unprobed.push(`${name}: calling it sent nothing to the main process, so its shape went unchecked (only the listener methods may send nothing)`);
    continue;
  }
  // A zero-parameter method has nothing left to compare: the call above *was* the
  // check, and it did reach a channel.
  if (!params.length) continue;
  const sent = invoked[0].args;

  // Several positional arguments: the interface's names do not cross the bridge
  // at all, so position is the contract.
  if (sent.length > 1) {
    if (sent.length !== params.length) {
      shapeMismatches.push(`${name}: the caller passes ${params.length} argument(s), the main process receives ${sent.length}`);
      continue;
    }
    params.forEach((param, i) => {
      if (JSON.stringify(sent[i]) !== JSON.stringify(probeArgs[i]))
        shapeMismatches.push(`${name}: the value passed for \`${param.name}\` does not arrive in position ${i + 1}`);
    });
    continue;
  }

  const payload = sent[0];
  const paths = new Map();
  collectPaths(payload, [], paths);

  for (const param of params) {
    const expected = param.keys.length ? param.keys.map((key) => markerFor(name, param, key)) : [markerFor(name, param, "")];
    const allowed = allowedPaths(param, params.length);
    expected.forEach((marker, i) => {
      const found = paths.get(marker) || [];
      if (found.some((path) => allowed.some((want) => want.join(".") === path.join(".")))) return;
      const wanted = describePath(allowed[i] || allowed[0]);
      if (!found.length)
        shapeMismatches.push(`${name}: the value passed for \`${param.name}\` never reaches the main process (expected at ${wanted})`);
      else
        shapeMismatches.push(`${name}: the value passed for \`${param.name}\` arrives at ${found.map(describePath).join(", ")} instead of ${wanted}`);
    });
  }

  // Keys the preload adds beyond what the interface promises are drift in the
  // other direction: the main process reads the names it knows and silently
  // ignores the rest, so a renamed field can sit there unread.
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const sentKeys = Object.keys(payload);
    const expectedKeys =
      params.length === 1
        ? params[0].keys.length && !params[0].keys.includes(sentKeys[0])
          ? [params[0].name]
          : params[0].keys.length
            ? params[0].keys
            : [params[0].name]
        : params.map((param) => param.name);
    const extra = sentKeys.filter((key) => !expectedKeys.includes(key));
    if (extra.length)
      extraKeyMismatches.push(`${name}: the main process receives ${extra.join(", ")}, which the interface does not declare`);
  }
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
check(
  "and nothing arrives under a key the interface does not declare",
  extraKeyMismatches.length === 0,
  extraKeyMismatches.join(" | ")
);
check(
  "every method's parameter list could be read, so none was skipped",
  parseFailures.length === 0,
  parseFailures.join(" | ")
);
check(
  "every declared method reaches the main process when called",
  unprobed.length === 0,
  unprobed.join(" | ")
);
check(
  "and the listener methods send nothing",
  listenerDrift.length === 0,
  listenerDrift.join(" | ")
);

// A stale name on the allow-list is dead weight that quietly exempts a method
// from the "must reach the main process" check above.
const staleListeners = [...LISTENER_METHODS].filter((name) => !declared.includes(name));
check(
  "the listener allow-list names only methods the interface declares",
  staleListeners.length === 0,
  staleListeners.length ? `not in the Bridge interface: ${staleListeners.join(", ")}` : ""
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
