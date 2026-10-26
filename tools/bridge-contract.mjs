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
// The parser above is a claim, so it is checked like one.
// ---------------------------------------------------------------------------
// Everything below walks `declared`, which is whatever one regular expression
// managed to read out of the interface. If that expression stops matching — a
// reformat to four-space indentation, a `readonly` modifier, prettier splitting
// a declaration differently — `declared` shrinks or empties, and the checks built
// on it shrink with it: no member to compare means nothing to disagree about, so
// the suite reports full marks for a parser that no longer parses. The failure
// then looks like "the interface has no methods", which is not a thing anyone
// would say out loud, and the next drift in the real contract goes unnoticed
// behind it.
//
// Two claims, because a count can be wrong in two directions:
//
//   1. the interface has members at all — an empty `declared` used to make every
//      comparison below vacuous (the "exposed but not declared" check is the only
//      one that would have complained, and it blames preload.js for it);
//   2. every method-shaped line inside the interface body produced a member —
//      counted with an indentation-agnostic pattern that also accepts a leading
//      `readonly`, so the two counts differing means the strict pattern missed a
//      line that is visibly a method declaration. That is the drift this parser
//      cannot see, made to fail out loud.
const methodShaped = bridgeBody
  ? [...bridgeBody[1].matchAll(/^[ \t]+(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*[(<]/gm)].map((m) => m[1])
  : [];

check(
  "the Bridge interface declares at least one method",
  declared.length > 0,
  `${declared.length} read out of src/lib/api.ts — an empty interface makes every check below vacuous`
);
check(
  "and every method-shaped line in it was read, so no member is skipped",
  methodShaped.length === declared.length,
  methodShaped.length === declared.length
    ? ""
    : `${methodShaped.length} method-shaped line(s) inside the interface, ${declared.length} parsed: ${
        methodShaped.filter((m) => !declared.includes(m)).join(", ") || "(count mismatch)"
      } — the parser no longer understands the interface's formatting`
);

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
// Methods whose shape was actually examined: parsed on both sides, called, and
// found to reach the main process with a payload to look at (or to take no
// parameter at all, where the call itself is the whole check). Counted so that
// "every non-listener method was examined" is an assertion rather than a
// consequence of the loop's `continue`s — each of which is a method that quietly
// stops being checked.
const examined = new Set();
// What each method actually reached, from the same probe call. Kept for the
// checks at the end of this file: "the name exists, the arguments line up, the
// payload arrives, the channel has a handler" is all true of a method pointed at
// a *neighbour's* channel.
const channelOf = new Map();
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
  examined.add(name);
  // `invoked` was cleared before the call, so these are this method's own
  // channels and nobody else's. A method that reached none is `unprobed` above
  // and is deliberately not recorded here: the two checks would say the same
  // thing twice.
  channelOf.set(name, invoked.map((call) => call.channel));
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

// The parsers, the loop's `continue`s and the counts are all ways for a method to
// drop out of the shape checks while every name-shaped check above stays green.
// The listeners are the only methods allowed to be absent from `examined` — they
// cross the bridge in the other direction — so the two sets have to add up.
const needExamining = declared.filter((name) => !LISTENER_METHODS.has(name));
const notExamined = needExamining.filter((name) => !examined.has(name));
check(
  "and every non-listener method's shape was actually examined",
  notExamined.length === 0,
  notExamined.length ? `skipped without being examined: ${notExamined.join(", ")}` : ""
);
check(
  "the examined set and the listener allow-list together cover the interface",
  examined.size + declared.filter((name) => LISTENER_METHODS.has(name)).length === declared.length,
  `${examined.size} examined + ${declared.filter((name) => LISTENER_METHODS.has(name)).length} listener(s) vs ${declared.length} declared`
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
// A channel may also be sent *through a constant* — the exit channel is named
// in `run-diagnostics.js` and sent as `send(RUN_EXIT_CHANNEL, payload)`, so the
// main process does not spell it at all. Those bindings are resolved here: a
// channel that moved into a constant must not look like a channel nobody sends
// (which is what happened the first time this arrangement was introduced).
const channelConstants = new Map(
  [...mainSrc.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]])
);
const sent = new Set([
  ...[...mainSrc.matchAll(/\bsend\(\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...mainSrc.matchAll(/\bsend\(\s*([A-Za-z_$][\w$]*)\b/g)]
    .map((m) => channelConstants.get(m[1]))
    .filter(Boolean),
]);

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

// ---------------------------------------------------------------------------
// Which channel each method reaches, not just that the names agree.
// ---------------------------------------------------------------------------
// Everything above compares the two sides *per name*: the method exists on both,
// takes the same arguments, its payload arrives under the interface's names, and
// the channel it names has a handler. None of that says a method reaches its
// *own* channel. `revealFile` invoking `file:open` satisfies all of it — the
// channel exists, the handler exists, and both take the same single string, so
// the shape probe cannot tell them apart either. The user gets a file that opens
// when they asked where it lives, and every check here stays green.
//
// So the channel reached during the probe is kept, and two properties are
// asserted. The first is general and needs no maintenance: one channel per
// method, and no channel shared by two methods — a copy-paste or a rename that
// stopped half-way. The second is a pinned table, and deliberately small: only
// where a swap is invisible to every other check in this file. Pinning all 36
// would make this file a second copy of preload.js, and the two copies would
// disagree about formatting before they disagreed about a channel.
const FILE_CHANNELS = {
  readFile: "file:read",
  openFile: "file:open",
  revealFile: "file:reveal",
  saveText: "file:saveText",
  openUrl: "file:openUrl",
};

const manyChannels = [...channelOf]
  .filter(([, channels]) => channels.length !== 1)
  .map(([name, channels]) => `${name} reached ${channels.join(", ")}`);
check(
  "every method reaches exactly one channel",
  manyChannels.length === 0,
  manyChannels.length ? `${manyChannels.join(" | ")} — the extra payloads are never examined` : ""
);

const byChannel = new Map();
for (const [name, channels] of channelOf)
  for (const channel of channels) byChannel.set(channel, [...(byChannel.get(channel) || []), name]);
const sharedChannels = [...byChannel]
  .filter(([, names]) => names.length > 1)
  .map(([channel, names]) => `${channel}: ${names.join(" + ")}`);
check(
  "and no two methods reach the same one",
  sharedChannels.length === 0,
  sharedChannels.length ? `${sharedChannels.join(" | ")} — one of them does not do what its name says` : ""
);

const wrongFileChannel = Object.entries(FILE_CHANNELS)
  .map(([name, channel]) => ({ name, channel, reached: channelOf.get(name) || [] }))
  .filter((entry) => entry.reached.length !== 1 || entry.reached[0] !== entry.channel)
  .map((entry) => `${entry.name} -> ${entry.reached.join(", ") || "nothing"} (should be ${entry.channel})`);
check(
  "the file methods reach the channel their name promises",
  wrongFileChannel.length === 0,
  wrongFileChannel.join(" | ")
);
const staleFileChannels = Object.keys(FILE_CHANNELS).filter((name) => !declared.includes(name));
check(
  "the file channel table names only methods the interface declares",
  staleFileChannels.length === 0,
  staleFileChannels.length ? `not in the Bridge interface: ${staleFileChannels.join(", ")}` : ""
);

// The channels are read twice, and the two readings have to agree: as text out of
// preload.js (the `ipcRenderer.invoke("…")` calls) and as what the probe actually
// saw. A method that started building its channel name — a template string, a
// lookup — would still pass the "is there a handler" check on the spelling it
// used to have, while the channel the renderer really invokes went unchecked.
const probedChannels = new Set([...channelOf.values()].flat());
const unspelled = [...probedChannels].filter((c) => !invokeChannels.has(c)).sort();
const unreached = [...invokeChannels].filter((c) => !probedChannels.has(c)).sort();
check(
  "the probe and preload.js name the same channels",
  unspelled.length === 0 && unreached.length === 0,
  [
    unspelled.length ? `reached but not spelled in preload.js: ${unspelled.join(", ")}` : "",
    unreached.length ? `spelled in preload.js but no method reached it: ${unreached.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ")
);

console.log(`\n${passed.length} ok, ${failed.length} failed`);
if (failed.length) {
  console.error(`\nbridge contract checks failed: ${failed.join(", ")}`);
  process.exit(1);
}
