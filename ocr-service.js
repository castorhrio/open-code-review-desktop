// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let cachedBinary = null;

// Mirrors @alibaba-group/open-code-review's own platform map. Keeping a copy
// here means the fallback search below works even if the CLI package's layout
// changes, and it is what makes macOS/Linux resolution explicit rather than
// "Windows plus an afterthought".
const PLATFORM_PACKAGES = {
  "darwin-arm64": "@alibaba-group/ocr-darwin-arm64",
  "darwin-x64": "@alibaba-group/ocr-darwin-x64",
  "linux-arm64": "@alibaba-group/ocr-linux-arm64",
  "linux-x64": "@alibaba-group/ocr-linux-x64",
  "win32-arm64": "@alibaba-group/ocr-win32-arm64",
  "win32-x64": "@alibaba-group/ocr-win32-x64",
};

const BINARY_FILENAME = process.platform === "win32" ? "opencodereview.exe" : "opencodereview";

// The CLI's postinstall chmods the binary, but that mode does not survive a
// Windows-authored package or a zip round-trip. Re-asserting it here keeps the
// macOS/Linux builds from failing with a bare EACCES on first run.
function ensureExecutable(file) {
  if (process.platform === "win32") return file;
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch (_) {
    try {
      fs.chmodSync(file, 0o755);
    } catch (_) {}
  }
  return file;
}

// `node_modules` sits next to this file in both the dev tree and the packaged
// (asar:false) app; the second candidate covers a portable extraction that
// nests the app one level deeper.
function platformPackageDir(name) {
  const candidates = [
    path.join(__dirname, "node_modules", name),
    process.resourcesPath ? path.join(process.resourcesPath, "app", "node_modules", name) : "",
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, "bin", BINARY_FILENAME))) return dir;
  }
  return null;
}

function globalRoots() {
  return [
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : "",
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
    path.join(os.homedir(), ".local", "lib", "node_modules"),
  ].filter(Boolean);
}

function binaryPath() {
  if (cachedBinary) return cachedBinary;
  const name = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];

  // 1) Let the CLI resolve its own platform package — it knows its layout best.
  try {
    const { resolveNativeBinary } = require("@alibaba-group/open-code-review/scripts/platform");
    const resolved = resolveNativeBinary();
    if (resolved && resolved.path && fs.existsSync(resolved.path)) {
      cachedBinary = ensureExecutable(resolved.path);
      return cachedBinary;
    }
  } catch (_) {}

  // 2) Look for the current platform's package beside this file.
  if (name) {
    const dir = platformPackageDir(name);
    if (dir) {
      cachedBinary = ensureExecutable(path.join(dir, "bin", BINARY_FILENAME));
      return cachedBinary;
    }
  }

  // 3) Last resort: a global npm install of the platform package.
  if (name) {
    for (const root of globalRoots()) {
      const guess = path.join(root, name, "bin", BINARY_FILENAME);
      if (fs.existsSync(guess)) {
        cachedBinary = ensureExecutable(guess);
        return cachedBinary;
      }
    }
  }
  return null;
}

const CONFIG_PATH = path.join(os.homedir(), ".opencodereview", "config.json");

function maskSecret(value) {
  if (typeof value !== "string" || !value) return "";
  return value.length > 6 ? `${value.slice(0, 3)}****${value.slice(-2)}` : "****";
}

function entryHasCredential(entry) {
  return Boolean(
    entry &&
      (entry.api_key || entry.auth_token || entry.api_key_cmd || entry.auth_token_cmd)
  );
}

function stripEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { api_key: apiKey, auth_token: authToken, ...rest } = entry;
  return {
    ...rest,
    hasKey: entryHasCredential(entry),
    keyPreview: maskSecret(apiKey || authToken),
  };
}

const mapSection = (section) =>
  Object.fromEntries(Object.entries(section || {}).map(([k, v]) => [k, stripEntry(v)]));

/**
 * The entry a service name refers to, spelled the way the CLI would find it.
 *
 * A built-in name is looked up by the registry, which is case insensitive
 * (`llm.LookupProvider`), so `DeepSeek` in the file and `deepseek` from the form
 * are the same service to `ocr`. An exact-string lookup then missed a Key the
 * CLI was happily using: the settings page said "还没有已保存的 Key" while
 * `ocr review` ran fine on that very config. The renderer's spelling is not ours
 * to control either — it can come back from a restored form, a paste, or a
 * config written by hand.
 *
 * A custom name is a plain map key upstream (`custom_providers[name]`), so it is
 * matched exactly: answering for another spelling would hand out a Key for a
 * config entry the CLI never opens.
 *
 * An exact match always wins over a case variant, in either section — the
 * spelling the config already uses is the one the user meant.
 */
// What decided which entry answers. Three of the four rules answer a question
// `ocr` itself asks; the last one (`order`) answers one it never asks, so the
// caller is told which rule it got instead of only which entry — and that one
// comes back with no entry at all (`entry: null`), because a caller holding an
// entry and a rule will eventually act on the entry alone.
//
// The four are *ordered by if/else*, so "the rules are mutually exclusive" is a
// property of this function's shape and not of anything a caller can see. Both
// the constants and `entryByName` are therefore exported: the smoke checks ask
// which rule answered for each shape, so moving one `if` below another (the
// registry rule below file order, say) makes an assertion red instead of
// silently handing the settings page a Key from the wrong entry.
const MATCH_EXACT = "exact"; // the file spells the name this way
const MATCH_ACTIVE = "active"; // the config's own `provider` names this entry
const MATCH_REGISTRY = "registry"; // the registry's spelling, from `ocr llm providers`
const MATCH_ORDER = "order"; // file order — a guess, not an answer

function entryByName(raw, name) {
  if (!name) return null;
  const providers = raw.providers || {};
  const custom = raw.custom_providers || {};
  const exact = providers[name] || custom[name];
  if (exact) return { entry: exact, rule: MATCH_EXACT };
  // Only the built-in section folds case, because only it is resolved through
  // the registry. Two entries whose names differ only by case (`DeepSeek` and
  // `deepseek`) are two different entries to everything below, so which one is
  // meant has to be decided here rather than guessed: `tryProviderConfig` tests
  // the name against the registry, which folds case, and then reads
  // `cfg.Providers[cfg.Provider]` — the *raw* string out of the config, not the
  // registry's spelling (internal/llm/resolver.go, v1.13.3). So the entry the
  // config's own `provider` field names is the one `ocr` actually opens, and it
  // is the one asked about. The registry's spelling comes next (that is the form
  // `ocr llm providers` prints, so it is what a form filled from the table
  // holds); picking it first was a guess that only looked right while the two
  // agreed.
  const wanted = String(name).toLowerCase();
  const matches = Object.entries(providers).filter(([key]) => key.toLowerCase() === wanted);
  if (!matches.length) return null;
  const active = String(raw.provider || "");
  // The last fallback is a last resort, not a second opinion: it only answers
  // when the config's `provider` is not one of these spellings at all (empty, or
  // another service than the one asked about) *and* the file never spells the
  // name the way the registry does — e.g. only `DeepSeek` exists while the form
  // asks about `DEEPSEEK`. Then there is exactly one entry the question can be
  // about, and no ordering left to get wrong.
  //
  // It is still reported as `order`, not as an answer, and the Key is still
  // withheld: a single candidate says which entry the *user* means, not which
  // entry `ocr` opens — with `provider` empty or naming something else, the CLI's
  // `cfg.Providers[cfg.Provider]` read misses and the config is refused, so no
  // run reads this entry. The rule describes the lookup, and the lookup is a
  // guess whatever the number of candidates. Both shapes (one entry, two
  // entries) are pinned in `tools/service-smoke.mjs`.
  //
  // A third spelling can also arrive, and it is worth saying what `ocr` does
  // with such a file: `provider: "DEEPSEEK"` with entries named `DeepSeek` and
  // `deepseek` matches no map key, so `cfg.Providers["DEEPSEEK"]` misses and the
  // run fails with "provider DEEPSEEK is set but not configured in providers
  // section" — nothing opens, so there is no entry a Key could be reused from
  // *and* no entry this answer can contradict. The registry rule still answers,
  // with the registry's spelling, because that is the name the settings page is
  // editing (the form holds what `ocr llm providers` printed).
  //
  // File order (`MATCH_ORDER`) is left only for the narrower shape above, where
  // even the registry's spelling is absent, and it is *not* an answer the app may
  // act on: it comes back with `entry: null` and `savedKeyFor` withholds the Key
  // (see there). `tools/service-smoke.mjs` pins all three shapes so none can
  // become another by accident.
  //
  // `entry: null` is the *structural* half of that: a rule and an entry travelled
  // back together, and "the entry is here for display, just do not use it" was a
  // promise a caller had to keep by reading `rule` first. A caller that reached
  // for `entry` alone got a Key from an entry no run opens — the right Key for
  // the right entry, out of a config the CLI refuses. Nothing is displayed from
  // here anyway (`view.providers` is built from the raw sections, line by line),
  // so the entry had exactly one possible use and it was the one use forbidden.
  // Now that use fails loudly: `null.api_key` throws instead of handing out a
  // secret, and the smoke checks assert the `null` for both order shapes.
  if (matches.some(([key]) => key === active)) {
    return { entry: matches.find(([key]) => key === active)[1], rule: MATCH_ACTIVE };
  }
  if (matches.some(([key]) => key === wanted)) {
    return { entry: matches.find(([key]) => key === wanted)[1], rule: MATCH_REGISTRY };
  }
  // No entry: `order` is a guess, and nothing downstream may act on it. See the
  // comment block above — this is the whole point of returning `null` rather
  // than the first match.
  return { rule: MATCH_ORDER, entry: null };
}

/**
 * Why a saved Key was not handed out.
 *
 * An empty string was the old answer for every one of these, and the caller had
 * to word all of them the same way — so "there is no Key saved for this service"
 * (fix: type one) and "the built-in service table could not be read, so which
 * host the Key belongs to is unknown" (fix: press 刷新 and try again) arrived at
 * the settings page as the same sentence. The reasons exist so the sentence can
 * be about the thing that actually went wrong.
 */
const KEY_WITHHELD_CONFIG = "config-unreadable"; // the config file is missing or not JSON
const KEY_WITHHELD_NO_ENTRY = "no-entry"; // no entry is named like this in either section
const KEY_WITHHELD_ORDER = "order-guess"; // the entry was picked by position; `ocr` never opens it
const KEY_WITHHELD_URL = "url-mismatch"; // the Key belongs to another endpoint
const KEY_WITHHELD_EMPTY = "no-key"; // the entry exists and matches, but holds no credential
const KEY_WITHHELD_TABLE = "table-unavailable"; // the built-in endpoint could not be read

// A URL is compared without its trailing slashes: "https://api.deepseek.com/"
// and "https://api.deepseek.com" are one host, and a difference there would
// withhold a Key that does belong to the endpoint the form is pointed at.
const strip = (value) => String(value || "").trim().replace(/\/+$/, "");

/**
 * Why a match rule withholds the Key — the mapping from "which rule answered"
 * to "no Key for you".
 *
 * `entryByName` answers with a *rule* as well as an entry, and one of the four
 * rules is not an answer the CLI ever asks: the entry was picked by position
 * in the file, so no run opens it. That rule has to turn into "the Key is
 * withheld" here, where the Key is decided — not in each caller. The Key would
 * still be the right Key for the right entry; it simply belongs to a config the
 * CLI refuses, so reusing it tells the user a service is configured when `ocr`
 * will refuse to run on it.
 *
 * `entryByName` already withholds the *entry* for that rule (`entry: null`), so
 * this module has two independent halves of the same promise: nothing to read
 * the Key from, and a reason that says why. Both are asserted.
 *
 * So the mapping is a function of its own, and the smoke checks ask it what
 * every rule means. The three rules that answer a question `ocr` asks mean
 * "nothing is withheld": their entries are the ones a run opens.
 */
function withholdReasonFor(rule) {
  if (rule === MATCH_ORDER) return KEY_WITHHELD_ORDER;
  return "";
}

/**
 * The endpoint one service resolves to — the rule both ends of the Key decision
 * ask.
 *
 * `tryProviderConfig` (internal/llm/resolver.go, v1.13.3) starts from the
 * built-in service's registered base URL and lets the entry's own `url` override
 * it:
 *
 *     url = preset.BaseURL
 *     if entry.URL != "" { url = entry.URL }
 *
 * So the *entry* wins. The settings page used to read the two the other way
 * round — the table's URL first, the entry's second — and for a service whose
 * entry names a URL of its own (a gateway, a proxy) that made the form show
 * and test a host the CLI would never use, and made the Key that belongs to the
 * entry look like it belonged to a different endpoint.
 *
 * One function, two callers: the config view hands the renderer the endpoint to
 * show and to test against, and `savedKeyLookup` compares the saved Key against
 * the same value. A second copy of this rule is exactly what let the two ends
 * disagree — and nothing asserted that they did.
 */
function serviceEndpoint(entry, presetUrl = "") {
  return strip(entry && entry.url) || strip(presetUrl);
}

// The Key never travels to the renderer: the settings page asks "may I reuse
// what is already saved for this service?" and only gets a value back when the
// endpoint being tested is the one that Key belongs to. Sending a saved Key to
// a URL the user just typed would leak it to another host.
//
// `configPath` is a parameter so the smoke checks can point this at a throwaway
// file instead of the user's own `~/.opencodereview/config.json`.
//
// `tableUnavailable` says the built-in service table could not be read, which
// makes `presetUrl` a *missing* answer rather than an empty one: for a built-in
// entry configured without a URL (the shape this app writes), the host is then
// unknown, and unknown is not the same as "any host will do".
//
// The default is the conservative one: a caller that says nothing about the
// table is a caller that did not read it, so the endpoint is unknown and the Key
// is withheld. It used to default to `false` — "the table was read and had
// nothing to say" — which made a forgotten argument (or a new call site written
// before the table existed) hand the Key out for whatever URL the form held.
// The two directions of that mistake are not symmetric: a withheld Key costs one
// retype, a Key sent to the wrong host cannot be taken back. Only a caller that
// actually read the table may pass `false`, and `savedKeyLookupByName` is the
// one that does.
function savedKeyLookup(name, url, configPath = CONFIG_PATH, presetUrl = "", { tableUnavailable = true } = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_) {
    return { key: "", reason: KEY_WITHHELD_CONFIG, endpoint: "" };
  }
  const found = entryByName(raw, name);
  if (!found) return { key: "", reason: KEY_WITHHELD_NO_ENTRY, endpoint: "" };
  // The endpoint is part of the answer, not just the Key: the settings page
  // shows the service's endpoint and the Key decision compares against it, and
  // a caller that cannot see which endpoint was used has to take the wording on
  // faith. It is returned on every path, including the ones that withhold.
  const withheld = (reason, endpoint = "") => ({ key: "", reason, endpoint });
  // `order` answers a question `ocr` never asks, and that is why the answer
  // stops here. This is the shape where no spelling in the file is the one the
  // config's `provider` names *and* the file never spells the name the registry
  // way either, so the entry was picked by position in the file. A run on such a
  // config never opens that entry: `cfg.Providers[cfg.Provider]` misses and the
  // CLI refuses the whole config ("provider %q is set but not configured in
  // providers section"). There is therefore no Key to reuse, and handing one out
  // would fill the settings form with a secret from an entry nothing opens —
  // the same reason a custom provider's Key is matched exactly rather than
  // folded. The entry stays visible in `view.providers` (that is what the
  // section is for); it just does not travel through here.
  //
  // The rule → reason mapping is `withholdReasonFor`, so that "which rule
  // answers" and "does the Key come out" cannot drift apart: a caller that
  // only looked at the entry would leak the Key of an entry no run opens.
  const orderReason = withholdReasonFor(found.rule);
  if (orderReason) return withheld(orderReason);
  // `order` is the only rule that comes back without an entry, and it returned
  // above — so `found.entry` here is an answer `ocr` really asks for, and the
  // rule check cannot be skipped without hitting `null` first.
  const entry = found.entry;
  const target = strip(url);
  // Which host the Key belongs to is *not* only the entry's own `url`: a
  // built-in service is normally configured with a Key and a model and no URL at
  // all (this app writes exactly that shape), and the endpoint then comes from
  // the CLI's own table — `url = preset.BaseURL`, overridden by `entry.URL`
  // (internal/llm/resolver.go, tryProviderConfig, v1.13.3). Without that second
  // source, an empty `entry.url` made the comparison vacuous and every URL the
  // form offered was handed the Key, which is the one thing this function exists
  // to prevent. A custom provider has no table to fall back to (upstream requires
  // its `url` for every protocol that names an endpoint), so nothing is known
  // there and nothing is handed out.
  //
  // `serviceEndpoint` is the one rule for that order, and the config view uses
  // it for the endpoint the settings page shows — so the endpoint the Key is
  // compared against and the endpoint the user is looking at cannot be two
  // different hosts.
  const home = serviceEndpoint(entry, presetUrl);
  // The entry has no URL of its own and the table that would supply one could
  // not be read: the host this Key belongs to is unknown, and that is a
  // different failure from "it belongs somewhere else". Reported before the
  // comparison, because with both sides empty the comparison is vacuous and
  // would hand the Key out for whatever the form happens to say.
  if (!home && tableUnavailable) return withheld(KEY_WITHHELD_TABLE);
  // No target at all is the "may I reuse what is saved?" question, not a test
  // against a host, so there is nothing to compare and nothing to leak.
  if (target && home !== target) return withheld(KEY_WITHHELD_URL, home);
  const key = String(entry.api_key || entry.auth_token || "");
  if (!key) return withheld(KEY_WITHHELD_EMPTY, home);
  return { key, reason: "", endpoint: home };
}

/**
 * `savedKeyLookup` for callers that only need the value.
 *
 * It states nothing about the table, so it inherits the conservative default and
 * withholds a Key whose endpoint is only knowable from `ocr llm providers`. That
 * is the point of the default: a call site that has not read the table cannot
 * claim the endpoint is known. Callers that *have* read it use
 * `savedKeyLookupByName` below.
 */
function savedKeyFor(name, url, configPath = CONFIG_PATH, presetUrl = "") {
  return savedKeyLookup(name, url, configPath, presetUrl).key;
}

/**
 * `savedKeyFor` with the endpoint the CLI would fill in for a built-in service.
 *
 * The settings page knows the table already (`providers`), but the question is
 * asked in the main process, so the lookup happens here, against the same cached
 * `providerTable()`. A registry that could not be read leaves `presetUrl` empty,
 * which withholds the Key rather than sending it to a host it may not belong to:
 * the user can always type the Key again, a Key sent to the wrong host cannot be
 * taken back.
 *
 * `tableOk` says whether that table could be read *for this lookup*, so the
 * caller can tell "the built-in list is unreadable" from "this service has
 * nothing to do with the built-in list" (a custom provider never does) without
 * reading the reason code and guessing.
 */
async function savedKeyLookupByName(name, url, configPath = CONFIG_PATH, options = {}) {
  const table = await providerTable(options);
  const wanted = String(name || "").toLowerCase();
  const row = table.ok ? table.rows.find((item) => String(item.name).toLowerCase() === wanted) : null;
  const found = savedKeyLookup(name, url, configPath, row ? row.url : "", { tableUnavailable: !table.ok });
  return { ...found, tableOk: table.ok };
}

async function savedKeyForName(name, url, configPath = CONFIG_PATH, options = {}) {
  return (await savedKeyLookupByName(name, url, configPath, options)).key;
}

/**
 * The sentence the settings page shows when "test what I typed" cannot run.
 *
 * It lives here, beside the reasons it reads, for the same reason `withHint`
 * does: the main process only wires it up, and a wording that has to distinguish
 * six causes can be asserted per cause without launching Electron.
 *
 * `table-unavailable` comes first because it also explains a *missing* field: for
 * a built-in service the form's Base URL is prefilled from that table, so a
 * table that failed to read leaves the form looking incomplete when the real
 * problem is one read. Saying "还缺 Base URL" there sends the user to type an
 * endpoint the CLI already knows.
 */
function savedKeyTestMessage({ missing = [], reason = "" } = {}) {
  const tail = "无法按当前填写的值测试。补齐后再点，或先保存再测已保存的配置。";
  if (reason === KEY_WITHHELD_TABLE)
    return `读不到内置服务表，无法判断这个服务已保存的 Key 属于哪个端点，也取不到内置服务的 Base URL（设置页的「刷新」会重读一次）。${tail}`;
  if (missing.length) return `还缺 ${missing.join("、")}，${tail}`;
  if (reason === KEY_WITHHELD_URL)
    return `已保存的 Key 属于另一个端点，不会发到当前填写的地址；请把 Key 重新填进来，或把端点改回原值。${tail}`;
  if (reason === KEY_WITHHELD_ORDER)
    return `配置里没有能对上这个名字的条目（providers 段里只有写法不同的条目，且 provider 没有指向它），已保存的 Key 不会被采用；请在设置页重新保存一次该服务。${tail}`;
  if (reason === KEY_WITHHELD_CONFIG)
    return `读不到配置文件，无法判断是否已有 Key（首次保存后 CLI 才会创建它）。把 Key 填进来即可测试。${tail}`;
  // `no-entry` / `no-key`: the plain answer, and what the old wording said for
  // every case.
  return `该服务还没有已保存的 Key，请把 Key 填进来，${tail}`;
}

/**
 * The line under the API Key field: may the user leave it blank, and if not,
 * what stands in the way.
 *
 * `savedKeyTestMessage` above only speaks after a test has already failed, so
 * the six reasons were reachable in exactly one place — press 测试连通, read the
 * sentence, guess. The field's own hint said "该服务还没有 Key" for every one of
 * them, including "the built-in service table could not be read" (fix: press
 * 刷新) and "the saved Key belongs to another endpoint" (fix: put the endpoint
 * back). Those are three different fixes behind one sentence, and the one the
 * user is shown is the one they will try.
 *
 * The tone is part of the answer rather than the caller's guess: `ok` is "leaving
 * it blank reuses the saved Key", `warn` is "something you can fix stands in the
 * way", `muted` is the ordinary state of an entry nothing has been saved for —
 * not a fault, and not worth an alarm colour.
 */
function savedKeyFieldHint(reason) {
  if (!reason) return { tone: "ok", text: "留空即沿用这个端点已保存的 Key。" };
  // First, because it is the one cause whose fix is an in-app button rather than
  // typing: the read failed, nothing is wrong with what the user entered.
  if (reason === KEY_WITHHELD_TABLE)
    return { tone: "warn", text: "读不到内置服务表，无法确认已保存的 Key 属于哪个端点；点「刷新」重读一次，再留空保存。" };
  if (reason === KEY_WITHHELD_URL)
    return { tone: "warn", text: "已保存的 Key 属于另一个端点，不会发到这里：把 Base URL 改回原值，或把 Key 填进来。" };
  // The entry exists but under a spelling no run opens — the fix is a save (which
  // writes the entry the form is about) or a hand edit plus 刷新, not a new Key.
  if (reason === KEY_WITHHELD_ORDER)
    return { tone: "warn", text: "配置里没有能对上这个名字的条目（只有写法不同的条目，且当前服务没有指向它）；在这里保存一次该服务，或手改配置文件后点「刷新」。" };
  if (reason === KEY_WITHHELD_CONFIG)
    return { tone: "muted", text: "还没有可读的配置文件，首次保存时 CLI 才会创建它。" };
  // `no-entry` / `no-key`: nothing is saved, which is where a new entry starts.
  return { tone: "muted", text: "该服务还没有已保存的 Key，留空保存不会写入 Key。" };
}

// Endpoint and credential are different questions. A URL in the config or in
// the environment says where to send the request, not that the CLI can
// authenticate it, and treating the two as one turned the top bar green for a
// custom gateway with no Key — the review then failed only after it started.
//
// The third column says which config shape reads the variable at all. The
// provider shape stops at the selected entry (internal/llm/resolver.go,
// tryProviderConfig): the endpoint comes from that entry or from the built-in
// service's own table, and the `OCR_LLM_*` overrides are never consulted — so a
// lone `OCR_LLM_URL` beside a `provider` is not an endpoint, and `OCR_LLM_TOKEN`
// is not its Key. Counting them is how a provider entry with no URL came out
// "ready" and then failed with `no valid LLM endpoint configured`.
//
// `ANTHROPIC_AUTH_TOKEN` is the Claude-Code variable (tryCCEnv), which is one of
// the *legacy* strategies — the provider shape never reads it.
//
// The fourth column names the built-in service whose `EnvVar` a variable is
// (internal/llm/providers.go). In the provider shape the environment is a Key
// source only through that table: `tryProviderConfig` falls back to
// `preset.EnvVar` when the entry has neither `api_key` nor `api_key_cmd`, and
// only for a preset — a custom provider has no fallback at all, and, say,
// `ANTHROPIC_API_KEY` is not what the `deepseek` preset reads. Held as a list of
// the variables this app knows about, not as a copy of the whole table, so a
// provider whose variable is missing here reads as "no Key" (the CLI will still
// run it) rather than as "ready".
const ENV_SOURCES = [
  ["OCR_LLM_URL", "endpoint", "legacy"],
  ["OCR_LLM_TOKEN", "credential", "legacy"],
  ["OCR_LLM_MODEL", "model", "legacy"],
  ["ANTHROPIC_BASE_URL", "endpoint", "legacy"],
  ["ANTHROPIC_AUTH_TOKEN", "credential", "legacy"],
  ["ANTHROPIC_API_KEY", "credential", "both", "anthropic"],
  ["ANTHROPIC_MODEL", "model", "legacy"],
];

// A gap is named once, here: `missing` carries the keys and the sentence next to
// the readiness badge is built from the same list, so the two cannot drift apart
// (they used to: the list knew about a missing endpoint, the sentence did not).
const GAP_LABEL = { baseUrl: "服务端点", model: "模型名", credential: "API Key", provider: "有效的服务名" };
// The order the user should fill the gaps in, and the order they are named in.
// Readiness, the gap list and the sentence are all derived from this array plus
// the three booleans below, so adding a fourth dimension cannot leave one of the
// three behind.
const GAP_ORDER = ["baseUrl", "model", "credential"];
// Chinese run straight into a latin word would read as one token ("缺少API Key"),
// so an ASCII label carries a leading space, and the last one is introduced with
// 和 rather than the enumeration comma.
const listText = (labels) =>
  labels.reduce((text, label, i) => {
    const ascii = /^[A-Za-z]/.test(label);
    const word = ascii ? ` ${label}` : label;
    if (i === 0) return word;
    return `${text}${ascii && i === labels.length - 1 ? "和" : "、"}${word}`;
  }, "");

/* ---- built-in service registry ---- */

// `providers.<name>` is only read for a name the CLI's own registry knows
// (`llm.LookupProvider`, case insensitive); every other name goes to the
// `custom_providers` section instead. So "is this name built in?" is a fact the
// CLI owns and this app cannot guess — `ocr llm providers` prints it.
//
// One parser, one table. The settings page lists name / protocol / base URL and
// the readiness view needs only the names, and the two used to parse the same
// bytes with their own regexes — the page's was stricter (lowercase names, no
// `matched` check), so a wider column or an underscored service name would have
// made them disagree about the same output. Both questions are now answered by
// the one function below, so they cannot drift.
const PROVIDER_ROW = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}(.*)$/;
// The rule under the header (`----   --------   --------`). It does not match
// `PROVIDER_ROW` today — a rule may not start with a letter — but the table's
// column widths are the CLI's to change, and a rule that ever did match would be
// looked up as a service name: `LookupProvider("----")` misses, and a config the
// user wrote correctly would be judged by the wrong section.
const RULE_ROW = /^-+$/;

/**
 * Parse `ocr llm providers`.
 *
 * Returns `{ rows, matched }` rather than a bare array: `matched` counts the
 * rows that had the table's *shape* (header included), so "the table changed and
 * nothing here looks like a row" (0) is a different answer from "the table is
 * empty". Both used to come back as `null`, and the caller then fell back to the
 * lenient judgement this whole registry lookup exists to replace — silently.
 */
function parseProviderTable(text) {
  let matched = 0;
  const rows = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const m = PROVIDER_ROW.exec(line.trim());
    if (!m || RULE_ROW.test(m[1])) continue;
    matched += 1;
    // The header is a row by shape and not a service; it still counts as
    // `matched`, because seeing it proves the shape is intact.
    if (m[1].toUpperCase() === "NAME") continue;
    // The remaining columns are two-or-more spaces apart, and the last one is
    // empty for a service whose URL the CLI prints blank (`bedrock`).
    const cols = m[2].split(/\s{2,}/);
    rows.push({ name: m[1], protocol: cols[0] || "", url: cols[1] || "" });
  }
  return { rows, matched };
}

/** Just the names, for the readiness view. Same parse, same `matched`. */
function parseProviderNames(text) {
  const { rows, matched } = parseProviderTable(text);
  return { names: rows.map((row) => row.name), matched };
}

// Read once per process: the table lives in the CLI, so it costs one process
// spawn, and a stale list is safer than a guessed one (the registry only grows).
//
// `ok: false` means "could not be read", which is not the same as "empty". A
// failure is remembered for a short window instead of not at all: the settings
// page asks for this list on every refresh and beside every readiness view, so
// an uncached failure spawns one doomed process per interaction — a missing or
// broken binary turns a single broken read into a stream of them, each one
// waiting out its own spawn. The window is short enough that a transient failure
// (a spawn racing an update, a binary a reinstall is about to restore) clears on
// its own, and `refresh` clears it immediately — the settings page tells the user
// to press 刷新, so that button has to actually retry.
const PRESET_FAILURE_TTL_MS = 30_000;
let cachedPresetTable = null; // a successful read, for the life of the process
let cachedPresetFailure = null; // { at, result }, for PRESET_FAILURE_TTL_MS
let lastPresetError = "";

function resetPresetCache() {
  cachedPresetTable = null;
  cachedPresetFailure = null;
}

/**
 * `ocr llm providers`, at most once per process for a success and once per
 * failure window.
 *
 * `refresh` is the settings page's 刷新 button; `runner` and `now` exist so the
 * retry policy can be asserted without waiting on a clock or breaking a binary
 * on purpose.
 *
 * This is the *only* read of the built-in table, and both of the answers the
 * settings page gets come from it: the config view (`presetRegistry`) and the
 * Key decision (`savedKeyLookupByName`). That is deliberate — the two are
 * separate IPC calls, and if each read the table for itself they could disagree
 * about the same moment: one would say "the built-in list is unreadable" (the
 * banner) while the other said "your Key is fine" (the sentence under the Key
 * field), and the two would be about the same table.
 *
 * So the rule is: within one process the two answers cannot disagree, and the
 * only thing that may change the table's state is a `refresh` (the 刷新 button)
 * or the failure window expiring. The renderer takes the same view — the banner
 * follows the *latest* answer rather than the config view's — so a window that
 * expired between the two calls changes both, not one.
 */
async function providerTable({ refresh = false, runner = exec, now = Date.now } = {}) {
  if (refresh) resetPresetCache();
  if (cachedPresetTable) return cachedPresetTable;
  if (cachedPresetFailure && now() - cachedPresetFailure.at < PRESET_FAILURE_TTL_MS)
    return { ...cachedPresetFailure.result, cached: true };
  const fail = (error) => {
    lastPresetError = error;
    const result = { ok: false, rows: [], matched: 0, error };
    cachedPresetFailure = { at: now(), result };
    return result;
  };
  const res = await runner(["llm", "providers", "--color", "never"]);
  if (res.error) return fail(res.error);
  if (res.code !== 0) return fail(failureText(res));
  const { rows, matched } = parseProviderTable(res.stdout);
  // No row at all is a parsing problem, not an empty registry: the CLI always
  // ships built-in services, so an unreadable shape must not read as "no name is
  // built in" (which would reject every correctly configured entry).
  if (!matched) return fail("ocr llm providers 的输出里没有可识别的服务行");
  cachedPresetTable = { ok: true, rows, matched, error: "" };
  cachedPresetFailure = null;
  lastPresetError = "";
  return cachedPresetTable;
}

/**
 * The built-in service registry: the names, the table's rows (so a caller can
 * resolve a service's endpoint without reading the table again), and whether
 * they could be read at all.
 */
async function presetRegistry(options) {
  const table = await providerTable(options);
  return {
    ok: table.ok,
    names: table.rows.map((row) => row.name),
    rows: table.rows,
    matched: table.matched,
    error: table.error,
    ...(table.cached ? { cached: true } : {}),
  };
}

// `readConfigView` takes the registry from its caller (the IPC layer hands in
// what `presetRegistry()` returned), and the smoke checks hand in a plain array
// of names. Both forms answer the same question; anything else means "not
// read". The rows are optional: without them the view can still say which names
// are built in, but not what endpoint a built-in service resolves to.
function registryFrom(presetList) {
  if (Array.isArray(presetList))
    return presetList.length
      ? { ok: true, names: presetList, rows: [], error: "" }
      : { ok: false, names: [], rows: [], error: lastPresetError || "内置服务名单为空" };
  if (presetList && typeof presetList === "object" && Array.isArray(presetList.names)) return presetList;
  return { ok: false, names: [], rows: [], error: lastPresetError || "还没有读取过内置服务名单" };
}

function readConfigView({ configPath = CONFIG_PATH, env = process.env, presetList = null } = {}) {
  let raw = {};
  let fileExists = false;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fileExists = true;
  } catch (_) {}
  const llmRaw = raw.llm || {};
  const active = raw.provider || "";
  // The config has two shapes, not one: the resolver stops at the provider
  // section as soon as `provider` is set and only reads the legacy `llm` block
  // when it is not (internal/llm/resolver.go, ResolveEndpointWithOptions →
  // tryOCRConfig). Every answer below is therefore given per shape — the model
  // lives under one key in one of them and under another key in the other, and
  // the `llm` block's own Key never reaches a selected service.
  const usesLlmBlock = !active;
  // The built-in registry, lowercased once. `null` here means "not known",
  // which must not be read as "no name is built in" — so it is a third state,
  // reported as `presetRegistry: "unavailable"` rather than folded into either
  // answer. Every question below that needs the registry stays on the older,
  // lenient reading when it is missing, which is why the caller has to be able to
  // see that it happened.
  const registry = registryFrom(presetList);
  const presets =
    registry.ok && registry.names.length
      ? new Set(registry.names.map((name) => String(name).toLowerCase()))
      : null;
  const shape = usesLlmBlock ? "legacy" : "provider";
  // "Is the selected name one of the CLI's built-in services?" is asked three
  // times below — the endpoint, the credential, and which section the entry is
  // read from — so it is answered once. `registryHit` is about the *name* (does
  // the CLI know it), `knownPreset` about name plus entry: an entry under a
  // built-in name is what the resolver reads.
  const registryHit = Boolean(presets && active && presets.has(String(active).toLowerCase()));
  const providerEntry = active ? (raw.providers || {})[active] : undefined;
  const customEntry = active ? (raw.custom_providers || {})[active] : undefined;
  const inProvidersSection = Boolean(active && providerEntry);
  const knownPreset = registryHit && inProvidersSection;
  const activePreset = knownPreset ? String(active).toLowerCase() : "";
  // The resolver reads exactly one section and the *name* picks it
  // (`tryProviderConfig`): a built-in name comes from `providers`, every other
  // name from `custom_providers` — an entry of the same name left in
  // `providers` is never opened. Without the registry both sections are tried,
  // which is the older, looser reading.
  const entry =
    (presets ? (registryHit ? providerEntry : customEntry) : providerEntry || customEntry) || {};
  const detectedEnv = ENV_SOURCES.filter(([name, , readBy, owner]) => {
    if (!env[name]) return false;
    if (readBy === "legacy") return shape === "legacy";
    // `both` — the variables that count in either shape. In the provider shape
    // only a preset's own variable does, and only for that preset.
    if (shape === "legacy") return true;
    // No registry yet: fall back to the older, lenient reading. Refusing a
    // config that works is worse than letting the CLI say "no api_key" on a run.
    return !presets || Boolean(owner && owner === activePreset);
  });
  const envSources = detectedEnv.map(([name]) => name);
  const envCredentials = detectedEnv
    .filter(([, kind]) => kind === "credential")
    .map(([name]) => name);
  const envHasEndpoint = detectedEnv.some(([, kind]) => kind === "endpoint");
  const envHasModel = detectedEnv.some(([, kind]) => kind === "model");
  // The effective model is the one the resolver would actually send, and the two
  // shapes read it from different places (internal/llm/resolver.go):
  // - provider form (`tryProviderConfig`): the entry's own `model` wins, and the
  //   top-level `model` is the fallback;
  // - legacy form (`tryLegacyLlmConfig`): only `llm.model` — the top-level
  //   `model` is not read at all.
  const entryModel = String(entry.model || "").trim();
  // The endpoint every known service resolves to, so the settings page shows
  // the host the CLI will use and tests against that one — instead of deriving
  // it a second time from the table and the config, in the other order, and
  // getting a different host.
  //
  // `serviceEndpoint` is the same rule `savedKeyLookup` compares a saved Key
  // against, and it is applied here to the *entry the form is about* (the one
  // named exactly, in either section) — the same entry the settings page looks
  // up. A service with no endpoint of its own and no table row (a custom
  // provider the user has not filled in yet) is simply absent.
  const presetUrls = new Map();
  for (const row of registry.rows || []) {
    if (row && row.name) presetUrls.set(String(row.name).toLowerCase(), row.url || "");
  }
  const endpointNames = new Set([
    ...Object.keys(raw.providers || {}),
    ...Object.keys(raw.custom_providers || {}),
    ...(registry.rows || []).map((row) => (row && row.name) || ""),
  ]);
  const endpoints = {};
  for (const name of endpointNames) {
    if (!name) continue;
    const own = (raw.providers || {})[name] || (raw.custom_providers || {})[name] || {};
    const endpoint = serviceEndpoint(own, presetUrls.get(String(name).toLowerCase()) || "");
    if (endpoint) endpoints[name] = endpoint;
  }
  const view = {
    path: configPath,
    fileExists,
    provider: active,
    model: usesLlmBlock ? llmRaw.model || "" : entryModel || raw.model || "",
    effort: raw.effort || "",
    language: raw.language || "",
    maxTokens: raw.max_tokens || 0,
    providers: mapSection(raw.providers),
    customProviders: mapSection(raw.custom_providers),
    endpoints,
    llm: {
      url: llmRaw.url || "",
      model: llmRaw.model || "",
      protocol: llmRaw.protocol || "",
      hasToken: Boolean(llmRaw.auth_token || llmRaw.auth_token_cmd),
      tokenPreview: maskSecret(llmRaw.auth_token),
    },
    envSources,
    envCredentials,
  };
  // `providers.<name>` only accepts a preset name — `config set` routes every
  // other name into `custom_providers` (cmd/opencodereview/config_cmd.go,
  // setProviderValue) — and the resolver takes the URL from the preset registry
  // unless the entry overrides it. This app configures a built-in service with a
  // Key and a model and no URL at all, which is complete, so a preset entry has
  // an endpoint even when the file never spells one out.
  //
  // "The key exists in `providers`" is therefore *not* the same question as "the
  // CLI will read it": the resolver looks the name up in the registry first and,
  // when it does not match, goes to `custom_providers` and fails there with
  //   provider %q is set but not configured in custom_providers section
  // So a name hand-edited into `providers` is a config the CLI rejects outright,
  // not a preset entry that happens to be missing a URL. Naming `baseUrl` for it
  // would point the user at the one field that cannot fix anything.
  //
  // `registryHit` / `inProvidersSection` / `knownPreset` themselves are computed
  // above, where the environment question needs them too. Without the registry
  // all that can be said is the older, looser answer.
  const presetEntry = presets ? knownPreset : inProvidersSection;
  // The other half of that rule, and the one that was still being answered
  // wrongly: `tryProviderConfig` picks the section by the *name* and then stops
  // if the entry is not there — it never falls back to the other section.
  //   built-in name, entry only in `custom_providers`
  //     → provider %q is set but not configured in providers section
  //   any other name, entry only in `providers`
  //     → provider %q is set but not configured in custom_providers section
  // The entry that *does* exist is in the section the resolver will not open, so
  // no field under it can change the outcome — this is a refused config, not a
  // form with a missing field. The two causes are kept apart because the fix
  // differs (move the entry one way or the other, or rename the service).
  const rejected = !presets || !active
    ? ""
    : registryHit
      ? (inProvidersSection ? "" : "provider-not-in-section")
      : customEntry
        ? ""
        : "name-unknown";
  const rejectedProvider = rejected ? active : "";
  const hasEntryKey = entryHasCredential(entry);
  // An `llm.auth_token` sitting next to a selected provider never reaches the
  // request, and counting it left the gap list empty for a service that had no
  // Key of its own.
  const hasLlmKey = usesLlmBlock && Boolean(llmRaw.auth_token || llmRaw.auth_token_cmd);
  // A provider entry carries its own endpoint and model, the environment can
  // supply them too, and a preset entry has both from the CLI's own table, so
  // all of those count. Reading only the `llm` section here made a selected
  // provider with neither a URL nor a model report a single gap — the Key — and
  // the settings page sent the user to add an API key while the endpoint was the
  // actual hole.
  const hasEndpoint =
    Boolean((usesLlmBlock && llmRaw.url) || String(entry.url || "").trim()) ||
    envHasEndpoint ||
    presetEntry;
  // The model is read from a *different* key in each shape, and reading the
  // wrong one is how a config that the CLI rejects gets called ready:
  // - provider form (`tryProviderConfig`): the top-level `model` is read, and
  //   the entry's own `model` overrides it. The `llm` block is not read at all.
  // - legacy form (`tryLegacyLlmConfig`): only `llm.model` is read. The
  //   top-level `model` is *not* — and `ocr config set model X` without a
  //   provider writes exactly that key, so the legacy path ignores what the
  //   CLI's own `config set` just wrote.
  // The environment fills the model only in the legacy form: the provider path
  // never consults `OCR_LLM_MODEL`, and a provider without a model is a hard
  // error ("provider %q has no model configured"), not something the next
  // resolution strategy can complete.
  const hasModel = usesLlmBlock
    ? Boolean(llmRaw.model) || envHasModel
    : Boolean(raw.model) || Boolean(entryModel);
  // Any credential counts, wherever the CLI would look for it: the entry's own
  // Key, a built-in service's variable (`envCredentials` already holds only what
  // the current shape reads, and in the provider shape only the selected
  // preset's own variable), or — in the legacy shape — the `llm` block's token.
  // Being wrong in the optimistic direction only means a run that fails with the
  // CLI's message instead of a disabled button; being wrong the other way blocks
  // a config that works, which is why a variable this app does not track is left
  // out of the list rather than guessed at.
  const hasCredential = Boolean(envCredentials.length || (active && hasEntryKey) || hasLlmKey);
  view.configured = Boolean(active || llmRaw.url || llmRaw.model);
  // One list decides both answers. `ready` used to be its own expression and
  // could disagree with `missing`: a selected service with an endpoint and a
  // model but no Key of its own emptied the list while the badge still said
  // "not ready", and the sentence then had no gap to name.
  const gapPresent = { baseUrl: hasEndpoint, model: hasModel, credential: hasCredential };
  // A refused name is not one of the three fields: the CLI never opens the
  // section the entry sits in, so no URL, Key or model added under it changes the
  // outcome — see `rejected` right below for what each cause names instead.
  view.rejectedProvider = rejectedProvider;
  view.rejected = rejected;
  // A refusal is not a missing field: for a name the registry does not know, the
  // gap *is* the name (`provider`, a field the user can act on by renaming), but
  // for an entry in the wrong section there is nothing to fill in — `missing`
  // stays empty and `ready` is decided by the refusal. Two states, not one.
  view.missing = rejected
    ? (rejected === "name-unknown" ? ["provider"] : [])
    : GAP_ORDER.filter((key) => !gapPresent[key]);
  view.ready = !rejected && view.missing.length === 0;
  // Whether the built-in service list could be read at all. `unavailable` means
  // every judgement above about built-in names took the older, lenient branch —
  // the one that called a config "ready" and let the CLI refuse it — so the
  // settings page says so instead of showing a confident badge.
  view.presetRegistry = presets ? "ok" : "unavailable";
  view.presetRegistryError = presets ? "" : registry.error || "";
  const gapText = listText(view.missing.map((key) => GAP_LABEL[key] || key));
  // Same order and same labels as the gap list above, so the two halves of the
  // sentence cannot spell a dimension differently.
  const configuredParts = GAP_ORDER.filter((key) => gapPresent[key]).map((key) => GAP_LABEL[key]);
  if (view.ready) view.blockedReason = "";
  // The whole config is refused, so the sentence must not read like a form with
  // one empty field left: the fix is to rename or move the entry.
  else if (rejected === "provider-not-in-section")
    view.blockedReason = `已选服务 ${active} 是内置服务，但条目不在 providers 段，CLI 会整份拒绝这份配置：把条目移到 providers.${active}，或改用别的服务名`;
  else if (rejected)
    view.blockedReason = `已选服务 ${active} 不在内置服务名单里，配置里也没有 custom_providers 条目，CLI 会整份拒绝这份配置：把这个服务写进 custom_providers，或改选一个内置服务`;
  // `|| "必要配置"` is still the belt: a not-ready view always has at least one
  // gap, so it can only fire if a gap key has no GAP_LABEL — and a sentence
  // ending in 但缺少 with nothing after it is worse than a vague one.
  else if (active) view.blockedReason = `已选服务 ${active}，但缺少${gapText || "必要配置"}`;
  else if (configuredParts.length)
    view.blockedReason = `已配置${listText(configuredParts)}，但缺少${gapText || "必要配置"}`;
  else view.blockedReason = "未选择模型服务";
  return view;
}

/*
 * Flag coverage below mirrors `ocr review --help` / `ocr scan --help` of
 * @alibaba-group/open-code-review. scan and review are separate Cobra commands
 * with different accepted flags; sending a review-only flag to scan fails the
 * whole run with "unknown flag", so every mode lists its own allowed keys.
 */
const SHARED_FLAGS = [
  "provider",
  "model",
  "exclude",
  "background",
  "concurrency",
  "maxTokens",
  "maxTokensBudget",
  "maxTools",
  "timeout",
  "rule",
  "audience",
];

const MODES = {
  workspace: {
    command: "review",
    resumeSupported: false,
    own: ["effort", "noFilter", "backgroundFile"],
  },
  range: {
    command: "review",
    resumeSupported: true,
    own: ["effort", "noFilter", "backgroundFile"],
  },
  commit: {
    command: "review",
    resumeSupported: true,
    own: ["effort", "noFilter", "backgroundFile"],
  },
  scan: {
    command: "scan",
    resumeSupported: true,
    own: ["path", "noPlan", "noDedup", "noSummary", "batch"],
  },
};

// spec key -> CLI tokens. Boolean flags carry their own name, so they need the
// explicit form to avoid emitting a dangling value.
const FLAG_ARGS = {
  provider: (v) => ["--provider", v],
  model: (v) => ["--model", v],
  exclude: (v) => ["--exclude", v],
  background: (v) => ["--background", v],
  backgroundFile: (v) => ["--background-file", v],
  concurrency: (v) => ["--concurrency", String(v)],
  maxTokens: (v) => ["--max-tokens", String(v)],
  maxTokensBudget: (v) => ["--max-tokens-budget", String(v)],
  maxTools: (v) => ["--max-tools", String(v)],
  timeout: (v) => ["--timeout", String(v)],
  rule: (v) => ["--rule", v],
  audience: (v) => ["--audience", v],
  effort: (v) => ["--effort", v],
  path: (v) => ["--path", v],
  batch: (v) => ["--batch", v],
  noFilter: () => ["--no-filter"],
  noPlan: () => ["--no-plan"],
  noDedup: () => ["--no-dedup"],
  noSummary: () => ["--no-summary"],
};

function modeOf(spec) {
  return MODES[spec.mode] || MODES.workspace;
}

function argList(spec, preview) {
  const mode = modeOf(spec);
  const allowed = new Set([...SHARED_FLAGS, ...mode.own]);
  const args = [mode.command, "--repo", spec.repo, "--format", "json", "--color", "never"];
  if (spec.mode === "range") args.push("--from", spec.from, "--to", spec.to);
  if (spec.mode === "commit") args.push("--commit", spec.commit);
  Object.entries(spec).forEach(([key, value]) => {
    if (!allowed.has(key) || !FLAG_ARGS[key]) return;
    if (value === "" || value === null || value === undefined || value === false) return;
    args.push(...FLAG_ARGS[key](value));
  });
  // The CLI rejects --preview together with --resume, so a resume target must
  // never leak into the preview call the UI shares the same spec with.
  if (!preview && mode.resumeSupported && spec.resume) args.push("--resume", spec.resume);
  if (preview) args.push("--preview");
  return args;
}

/*
 * Node reports a spawn failure with the *program's* path even when what is
 * missing is the working directory — so a repository that no longer exists
 * surfaced as `spawn <binaryPath> ENOENT`, and a user (or a bug report) went
 * looking for a missing executable. Say which of the two is actually gone.
 */
function spawnFailure(err, bin, cwd) {
  if (err.code !== "ENOENT") return err.message;
  if (bin && !fs.existsSync(bin)) return `未找到 ocr 可执行文件：${bin}`;
  if (cwd && !fs.existsSync(cwd)) return `仓库目录已经不存在：${cwd}`;
  return err.message;
}

function exec(args, cwd, env) {
  return new Promise((resolve) => {
    const bin = binaryPath();
    if (!bin) {
      resolve({ code: -1, stdout: "", stderr: "", error: MISSING_BINARY });
      return;
    }
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr, error: spawnFailure(err, bin, cwd) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// `ocr llm test` takes no flags, and its OCR_LLM_* overrides are only honoured
// when the config selects no provider — a saved Key silently wins over the env
// (verified). So testing values that were never saved means running the CLI
// against an empty HOME, not just setting the variables.
const LLM_ENV_KEYS = { url: "OCR_LLM_URL", protocol: "OCR_LLM_PROTOCOL", model: "OCR_LLM_MODEL", apiKey: "OCR_LLM_TOKEN" };

function llmTestEnv(form, homeDir) {
  const env = {
    USERPROFILE: homeDir,
    HOME: homeDir,
    APPDATA: path.join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    OneDrive: homeDir,
  };
  for (const [field, key] of Object.entries(LLM_ENV_KEYS)) {
    const value = String(form[field] || "").trim();
    if (value) env[key] = value;
  }
  return env;
}

const MISSING_BINARY =
  `未找到 ocr 可执行文件（当前平台 ${process.platform}-${process.arch}）。` +
  "源码运行时请先在项目目录执行 npm install；安装版请重新安装以补齐该平台的二进制。";

// On failure the CLI prints the JSON payload to BOTH stdout and stderr, so
// taking "whichever stream is non-empty" yields a JSON blob as the error text.
// Only the `Error:` lines are the human-readable failure.
function errorLines(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^error:/i.test(line))
    .join("\n");
}

// The failure payload is pretty-printed, so it always begins with a bare `{`
// line; everything before that is the human-readable progress/warnings.
function stripPayload(text) {
  const lines = (text || "").split(/\r?\n/);
  const cut = lines.findIndex((line) => line.trim() === "{");
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n");
}

function failureText(res) {
  const fromStderr = errorLines(res.stderr);
  if (fromStderr) return fromStderr;
  const noise = stripPayload(res.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[ocr\] Session:/i.test(line));
  return (
    noise.join("\n").trim() || (res.stdout || "").trim() || `ocr 以退出码 ${res.code} 结束`
  );
}

const HELP_HINTS = [
  [
    /no valid LLM endpoint configured/,
    "还没有配置模型服务。到「设置」里选择服务、填入 API Key 并保存后再运行。",
  ],
  [
    /check your LLM configuration and API key/,
    "到「设置」点「测试连通」看完整报错。常见原因有两个：API Key 无效，或模型名填成了控制台显示名而不是 API 模型名。",
  ],
  [/supported API model names are/i, "模型名不被该服务接受：错误里列出的才是 API 模型名，别用控制台的显示名。"],
  [/is set but not configured/i, "该服务还没有配置：到「设置」的已配置服务里选它填 Key，或先切回一个已配置的服务。"],
  [/unknown flag/, "该模式不支持这个参数，请把出错参数留空后重试。"],
  [/not a valid commit ref|unknown revision/, "分支或提交号无法解析：检查拼写，或直接从下拉列表里选。"],
  [/cannot be used together/, "预览模式不能与续跑同时使用，请先不带续跑地预览。"],
  [/resume requires --from\/--to or --commit/, "工作区改动无法续跑，请改用「分支对比」或「单个提交」。"],
  [/fatal: not a git repository/, "所选目录不是 git 仓库。请选仓库根目录，或改用「全量扫描」。"],
  [
    // v1.13.2 turned a nonexistent `--path` from "select 0 files and exit 0"
    // into an error, and its wording is the only thing the user sees.
    /does not exist in the working tree/,
    "扫描路径在仓库工作区里找不到：检查拼写与大小写（区分大小写的系统上 a.go 和 A.go 是两个文件），或清空「扫描路径」改为扫描全部文件。",
  ],
  [
    /仓库目录已经不存在/,
    "上次用的目录已经不在了——临时目录被清掉、克隆被删、换过盘符都会这样。在顶部重新选一个仓库目录即可，其它设置不受影响。",
  ],
];

function withHint(text) {
  const hit = HELP_HINTS.find(([re]) => re.test(text));
  return hit ? `${text}\n→ ${hit[1]}` : text;
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "命令没有输出任何 JSON" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (_) {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
    } catch (_) {}
  }
  const bStart = trimmed.indexOf("[");
  const bEnd = trimmed.lastIndexOf("]");
  if (bStart >= 0 && bEnd > bStart) {
    try {
      return { ok: true, value: JSON.parse(trimmed.slice(bStart, bEnd + 1)) };
    } catch (_) {}
  }
  return { ok: false, error: "无法解析输出 JSON", raw: trimmed.slice(0, 2000) };
}

async function runJson(args, cwd) {
  const res = await exec(args, cwd);
  if (res.error) return { ok: false, error: withHint(res.error) };
  if (res.code !== 0) return { ok: false, error: withHint(failureText(res)) };
  const parsed = parseJson(res.stdout);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error, raw: parsed.raw };
}

async function preview(spec) {
  return runJson(argList(spec, true), spec.repo);
}

let runSeq = 0;
const running = new Map();

const SESSION_ID_RE = /\[ocr\] Session: (\S+)/;

// On failure the CLI re-emits the whole JSON payload on stderr; those fragment
// lines would flood the log panel. But every real progress line starts with
// `[ocr]`, which the same character class would swallow — so exempt it, or the
// UI shows a single [cmd] line for a run that is quietly working.
const isPayloadFragment = (line) => !line.startsWith("[ocr]") && /^[\s]*([[{\]},]|"[^"]*"\s*:)/.test(line);

// The CLI writes its progress with `\r` so a burst of tool-call lines arrives as
// one "line" if you only split on `\n` — the log then holds a single entry that
// renders as fifty.
const splitLines = (text) => text.split(/[\r\n]/);

/*
 * Everything below is keyed to what `ocr` v1.12.13 actually prints, captured
 * from a live single-file review (which took 3m48s and emitted nothing but the
 * lines below for the whole time). That run is the reason this parser exists:
 * the previous version matched only the *scan* wording for the file count, so
 * across all three diff modes the UI's "进入审查的文件" never left "—", and the
 * per-tool lines were thrown away except for a tally every 25 — which is how a
 * working run came to look like a hung one.
 */

// How many files the run will actually read, and how many it found.
//   `[ocr] 1 file(s) changed, reviewing 1 in <repo>`      — review modes
//   `[ocr] full-scan: 27 file(s) discovered, reviewing 27 in <repo>` — scan
const SCOPE_RE = /(\d+) file\(s\) (?:changed|discovered), reviewing (\d+)/;
//   `[ocr] Resume <id>: reusing 3 file(s), reviewing 5 file(s)`
const RESUME_RE = /reusing (\d+) file\(s\), reviewing (\d+) file\(s\)/;
//   `[ocr] estimated cost: ~1.2M tokens`
const COST_RE = /estimated cost:\s*([^\r\n]*)/;
//   `[ocr] Summary: 1 file(s) reviewed, 6 comment(s), ~81601 token(s) used, 3m48s elapsed`
const SUMMARY_RE = /Summary: (\d+) file\(s\) reviewed, (\d+) comment\(s\)(?:, ~(\d+) token\(s\) used)?(?:, ([^\r\n]*?))?$/;
// Files the rules dropped, in one aggregate line rather than per-file.
const FILTERED_RE = /(?:Filtered|Pre-filtered) (\d+) file\(s\)/;
// `Skipping` is also how the CLI reports skipping a *phase*, so only the form
// that names a path counts as an excluded file.
const SKIP_FILE_RE = /^\[ocr\] Skipping (?!plan phase\b|LLM grouping\b|MCP server\b)\S+/;
const GROUP_RE = /group "([^"]+)"/;
const FILE_ARG_RE = /(?:^|\s)file_path=(\S+)/;

// `[ocr]   ▶ file_read file_path=auth.js` / `[ocr]   ✔ code_search (55ms)` is
// per-tool-call chatter. It used to be counted and discarded; it is now the
// activity feed, because it is the only thing the CLI emits while it works, and
// it is what tells a user the run is alive and on which file.
const TOOL_CHATTER = /^\[ocr\]\s*([▶✔✗•])\s*(\S+)(.*)$/;
const ACTIVITY_MAX = 80;

function createProgress() {
  return {
    files: 0,
    reviewing: 0,
    tools: 0,
    comments: 0,
    excluded: 0,
    cost: "",
    current: "",
    byTool: {},
    activity: [],
  };
}

/**
 * Fold one `[ocr]` stderr line into the progress model.
 *
 * Returns the line unchanged when it is a milestone worth showing in the log,
 * or `null` when it is tool chatter already represented in `progress.activity`
 * — so the log stays a timeline of steps while the feed keeps every event.
 */
function feedProgressLine(progress, line) {
  let m = line.match(SCOPE_RE) || line.match(RESUME_RE);
  if (m) {
    progress.files = Number(m[1]);
    progress.reviewing = Number(m[2]);
    pushActivity(progress, { kind: "note", text: `范围确定：${m[2]} 个文件进入审查` });
    return line;
  }
  if ((m = line.match(COST_RE))) {
    progress.cost = m[1].trim();
    pushActivity(progress, { kind: "note", text: `预计成本 ${progress.cost}` });
    return line;
  }
  if ((m = line.match(FILTERED_RE))) {
    progress.excluded += Number(m[1]);
    return line;
  }
  if (SKIP_FILE_RE.test(line)) {
    progress.excluded += 1;
    return line;
  }
  if ((m = line.match(SUMMARY_RE))) {
    // The CLI's total is the number that counts, zero included. `|| progress
    // .comments` read a summary of "0 comment(s)" as "nothing to say" and kept
    // the running tally instead — which is how a run whose batches were all
    // refused ended up displaying comments it does not have.
    progress.comments = Number(m[2]);
    const elapsed = (m[4] || "").trim().replace(/\s+elapsed$/i, "");
    pushActivity(progress, { kind: "note", text: `已完成 ${m[1]} 个文件，产出 ${m[2]} 条评论${elapsed ? ` · 耗时 ${elapsed}` : ""}` });
    return line;
  }
  // The per-group plan lines are the closest thing the CLI gives to file-level
  // progress, so they are worth a row: without them the feed is empty for the
  // first ten seconds of every run, which is the window that reads as "hung".
  if ((m = line.match(GROUP_RE))) {
    progress.current = m[1];
    if (/Plan completed/i.test(line)) pushActivity(progress, { kind: "note", text: `${m[1]}：规划完成，开始逐段读` });
    else if (/Skipping plan phase/i.test(line)) pushActivity(progress, { kind: "note", text: `开始审查 ${m[1]}` });
  }

  const chatter = line.match(TOOL_CHATTER);
  if (!chatter) {
    // Not chatter, so it stays in the log verbatim. A warning is also worth a
    // row in the feed, because the feed is what the user is watching.
    if (/WARNING|ERROR|budget reached/i.test(line)) pushActivity(progress, { kind: "note", text: line.replace(/^\[ocr\]\s*/, ""), warn: true });
    return line;
  }
  const [, mark, tool, rest] = chatter;
  const args = rest.trim();
  if (mark === "▶") {
    const file = args.match(FILE_ARG_RE);
    if (file) progress.current = file[1];
    pushActivity(progress, { kind: "tool", tool, state: "running", args: argSummary(args) });
    return null;
  }
  if (mark === "•") {
    pushActivity(progress, { kind: "tool", tool, state: "running", args: argSummary(args) });
    return null;
  }
  // Only `✔` is a completed call; counting `▶` as well would double every number.
  const duration = /\(([^)]+)\)/.exec(args);
  progress.tools += 1;
  progress.byTool[tool] = (progress.byTool[tool] || 0) + 1;
  // A `code_comment` call that failed filed nothing. Since v1.13.3 (upstream
  // 375f64c) a batch whose entries are all unusable is answered with an error
  // instead of a success, so its closing line is `✗ code_comment failed: none of
  // the 'comments' entries could be filed…` — and counting that as one produced
  // comment put "已产出 1 条评论" on a run that will show an empty result.
  if (tool === "code_comment" && mark !== "✗") progress.comments += 1;
  // A failed call's closing line is the only place its reason exists — "✗
  // code_search failed: git grep failed: exit status 128: …". Settling the row
  // without it left a red dot that could not say why, on the screen the user
  // watches for minutes: the run-screen shape of a silent failure.
  const failed = mark === "✗";
  const reason = failed ? argSummary(args.replace(/^failed:\s*/i, "")) : undefined;
  settleActivity(progress, tool, failed ? "failed" : "done", duration ? duration[1] : "", reason);
  return null;
}

/** Keep the row short: the CLI dumps whole regexes and file lists into args. */
function argSummary(args) {
  const text = args.replace(/\s+/g, " ").trim();
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

function pushActivity(progress, event) {
  // Monotonic off the last row rather than off a sum of counters: once the feed
  // hits its cap the length stops growing, so a length-derived id collides —
  // and the rows are React keys.
  const last = progress.activity[progress.activity.length - 1];
  progress.activity.push({ ...event, id: last ? last.id + 1 : 0 });
  if (progress.activity.length > ACTIVITY_MAX) progress.activity.shift();
}

/**
 * `✔`/`✗` names the tool but not the call, so it closes the newest still-running
 * row for that tool. Concurrent files interleave, which is why the match is by
 * tool name rather than "the last row".
 */
function settleActivity(progress, tool, state, ms, reason) {
  for (let i = progress.activity.length - 1; i >= 0; i--) {
    const row = progress.activity[i];
    if (row.kind === "tool" && row.tool === tool && row.state === "running") {
      row.state = state;
      row.ms = ms;
      if (reason) row.args = reason;
      return;
    }
  }
  pushActivity(progress, { kind: "tool", tool, state, ms, args: reason || "" });
}

function startRun(spec, onLine, onExit, onProgress) {
  const bin = binaryPath();
  // Returning null lets the IPC caller report the failure synchronously instead
  // of firing an exit event before the run id reaches the renderer.
  if (!bin) return null;
  const id = `run-${++runSeq}`;
  const args = argList(spec, false);
  // Surface the exact invocation: it is the wrapper's whole job, and without it
  // a surprising run cannot be diagnosed. API keys never appear here.
  onLine(id, `[cmd] ocr ${args.join(" ")}`);
  const child = spawn(bin, args, { cwd: spec.repo, windowsHide: true });
  running.set(id, child);

  let stdout = "";
  let stderrBuf = "";
  let stderrAll = "";
  let sessionId = "";
  const progress = createProgress();
  const snapshot = () => ({ ...progress, activity: progress.activity.slice() });
  /**
   * Every stderr line can move the feed, and a 233-file scan produces thousands
   * of them — reporting per line would push a whole activity snapshot across IPC
   * dozens of times a second. Coalesced to one send per 120ms, flushed before
   * the exit event so the last rows are never dropped.
   */
  let reportTimer = null;
  const report = () => {
    if (!onProgress || reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      onProgress(id, snapshot());
    }, 120);
  };
  const flushReport = () => {
    if (!reportTimer) return;
    clearTimeout(reportTimer);
    reportTimer = null;
    if (onProgress) onProgress(id, snapshot());
  };

  const emit = (chunk) => {
    const text = chunk.toString("utf8");
    stderrAll += text;
    if (!sessionId) {
      const found = text.match(SESSION_ID_RE);
      if (found) sessionId = found[1];
    }
    stderrBuf += text;
    const lines = splitLines(stderrBuf);
    stderrBuf = lines.pop();
    // The trailing `Error:` line is reported once as the run failure, so don't
    // also stream it into the log as progress.
    lines.forEach((line) => {
      const t = line.trim();
      if (!t || /^error:/i.test(t) || isPayloadFragment(t)) return;
      const milestone = feedProgressLine(progress, t);
      report();
      if (milestone) onLine(id, milestone);
    });
  };
  /**
   * One run reports one outcome.
   *
   * A process that could not be started emits `error` *and* `close`, and both
   * used to call `onExit` — so the renderer was told twice that the same run
   * failed: two red toasts, two lines in the log, and a second one that reads
   * like a separate event rather than a repeat. The first outcome is the
   * informative one (it knows *why* the process could not start), so it wins
   * and the later close is ignored.
   */
  let exited = false;
  const finish = (payload) => {
    if (exited) return;
    exited = true;
    flushReport();
    running.delete(id);
    onExit(id, payload);
  };

  child.stdout.on("data", (d) => {
    stdout += d.toString("utf8");
  });
  child.stderr.on("data", emit);
  child.on("error", (err) => {
    finish({ code: -1, error: withHint(spawnFailure(err, bin, spec.repo)), sessionId, command: args.join(" ") });
  });
  child.on("close", (code) => {
    const tail = stderrBuf.trim();
    if (tail && !/^error:/i.test(tail) && !isPayloadFragment(tail)) onLine(id, tail);
    if (exited) return; // the error path already reported this run
    if (code !== 0) {
      // A failed run may still have published partial findings on stdout, so
      // report the error and the payload separately instead of picking one.
      const parsed = parseJson(stdout);
      finish({
        code,
        error: withHint(failureText({ code, stdout, stderr: stderrAll })),
        value: parsed.ok ? parsed.value : null,
        sessionId,
        command: args.join(" "),
      });
      return;
    }
    const parsed = parseJson(stdout);
    if (!parsed.ok) {
      finish({ code, error: parsed.error, raw: parsed.raw, sessionId, command: args.join(" ") });
      return;
    }
    finish({ code: 0, value: parsed.value, sessionId: parsed.value.session_id || sessionId, command: args.join(" ") });
  });
  return id;
}

function cancelRun(id) {
  const child = running.get(id);
  if (!child) return false;
  child.kill();
  return true;
}

async function setConfig(pairs) {
  const out = [];
  for (const [key, value] of pairs) {
    const res = await exec(["config", "set", key, String(value)]);
    out.push({ key, ok: res.code === 0, message: (res.stderr || res.stdout).trim() });
    if (res.code !== 0) break;
  }
  return out;
}

async function unsetConfig(key) {
  const res = await exec(["config", "unset", key]);
  return res.code === 0
    ? { ok: true, config: readConfigView({ presetList: await presetRegistry() }) }
    : { ok: false, error: withHint(failureText(res)) };
}

/* ---------------- sessions ---------------- */

// `--limit` caps the *output*, not the work: the CLI still opens every session
// file so it can sort by start time. Measured over 300 sessions on disk,
// `--limit 20` and `--limit 0` both take ~1.5s — so a cap buys nothing and only
// risks hiding sessions. We therefore always ask for everything; `0` is the
// CLI's own spelling of "unlimited". Anything else (missing, negative, NaN)
// falls back to 0 rather than silently inheriting the CLI default of 20.
async function listSessions(repo, limit) {
  const cap = Number.isFinite(limit) && limit >= 0 ? limit : 0;
  const args = ["session", "list", "--json", "--color", "never", "--limit", String(cap)];
  if (repo) args.push("--repo", repo);
  const res = await exec(args, repo || undefined);
  if (res.error) return { ok: false, error: withHint(res.error) };
  if (res.code !== 0) return { ok: false, error: withHint(failureText(res)) };
  // `session list --json` prints `null`, not `[]`, when the repo has none.
  const parsed = parseJson(res.stdout);
  if (!parsed.ok) return { ok: true, value: [] };
  return { ok: true, value: Array.isArray(parsed.value) ? parsed.value : [] };
}

async function sessionComments(repo, sessionId) {
  return runJson(["session", "comments", "--json", "--repo", repo, sessionId], repo);
}

async function exportSession(repo, sessionId, outFile) {
  const res = await exec(["session", "export", "--repo", repo, sessionId, "-o", outFile], repo);
  if (res.error) return { ok: false, error: withHint(res.error) };
  if (res.code !== 0) return { ok: false, error: withHint(failureText(res)) };
  return { ok: true, file: outFile };
}

async function deleteSession(sessionId, repo) {
  // An id can exist in more than one repository, where the CLI lists instead of
  // guessing; narrowing by repo makes the deletion unambiguous.
  const args = ["session", "rm", "-y"];
  if (repo) args.push("--repo", repo);
  args.push(sessionId);
  const res = await exec(args);
  if (res.error) return { ok: false, error: withHint(res.error) };
  if (res.code !== 0) return { ok: false, error: withHint(failureText(res)) };
  return { ok: true };
}

async function rulesCheck(repo, filePath, ruleFile) {
  const args = ["rules", "check", "--repo", repo];
  if (ruleFile) args.push("--rule", ruleFile);
  args.push(filePath);
  const res = await exec(args, repo);
  if (res.error) return { ok: false, error: withHint(res.error) };
  if (res.code !== 0) return { ok: false, error: withHint(failureText(res)) };
  return { ok: true, value: res.stdout };
}

module.exports = {
  binaryPath,
  CONFIG_PATH,
  readConfigView,
  entryByName,
  serviceEndpoint,
  MATCH_EXACT,
  MATCH_ACTIVE,
  MATCH_REGISTRY,
  MATCH_ORDER,
  parseProviderTable,
  parseProviderNames,
  providerTable,
  presetRegistry,
  resetPresetCache,
  PRESET_FAILURE_TTL_MS,
  exec,
  llmTestEnv,
  savedKeyFor,
  savedKeyForName,
  savedKeyLookup,
  savedKeyLookupByName,
  withholdReasonFor,
  savedKeyTestMessage,
  savedKeyFieldHint,
  KEY_WITHHELD_CONFIG,
  KEY_WITHHELD_NO_ENTRY,
  KEY_WITHHELD_ORDER,
  KEY_WITHHELD_URL,
  KEY_WITHHELD_EMPTY,
  KEY_WITHHELD_TABLE,
  preview,
  startRun,
  cancelRun,
  setConfig,
  unsetConfig,
  withHint,
  failureText,
  spawnFailure,
  createProgress,
  feedProgressLine,
  parseJson,
  listSessions,
  sessionComments,
  exportSession,
  deleteSession,
  rulesCheck,
};
