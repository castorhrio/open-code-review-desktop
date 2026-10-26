// Exercises config-handler.js with a stubbed CLI.
//
// The `config:*` handlers make decisions that a source-text check cannot see:
// which key a provider name becomes, whether a name that collides with an
// existing entry is refused before anything is written, and whether a withheld
// Key's reason is passed through instead of flattened into "no Key". Those were
// the bodies of `main.js` until this round; now they are a function a check can
// call, and this is that check.
//
// The stub models the CLI's own routing (`providers.<name>.<field>` goes to
// `custom_providers` for a name the registry does not know) and its refusal of
// a *new* dotted custom name, because those are the two upstream behaviours the
// desktop's write order depends on. Run with `npm run audit:config`.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const real = require(path.join(ROOT, "ocr-service.js"));
const { makeConfigHandlers } = require(path.join(ROOT, "config-handler.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-config-handler-"));

/**
 * A stubbed `ocr` that records what the handler asks it to do.
 *
 * `exec` is the seam the brief asks for: `setConfig` is implemented on top of it
 * the same way `ocr-service.js` does, so an assertion about a key reaching the
 * CLI is an assertion about the argument string, not about a mock of the pair
 * builder. The routing rules it simulates are the upstream ones cited in the
 * handler's comments:
 *   - a built-in name is read from `providers`, every other name from
 *     `custom_providers` (cmd/opencodereview/config_cmd.go, setProviderValue);
 *   - a dotted custom name that has no entry yet is refused outright (the
 *     `strings.Contains(name, ".")` guard added in v1.13.1, 8eb8334).
 */
const makeStub = ({ providers = {}, customProviders = {}, registry = ["deepseek"], presetRegistry, savedKey } = {}) => {
  const state = {
    providers: structuredClone(providers),
    custom_providers: structuredClone(customProviders),
    provider: "",
  };
  const calls = [];
  const setPairs = [];
  const unsetCalls = [];
  const registryCalls = [];
  const lookupCalls = [];
  let savedKeyAnswer = savedKey || { key: "sk-saved", reason: "", endpoint: "", tableOk: true };

  const isPreset = (name) => registry.some((known) => known.toLowerCase() === name.toLowerCase());

  const exec = async (args) => {
    calls.push(args);
    if (args[0] === "config" && args[1] === "set") {
      const key = args[2];
      const value = args[3];
      if (key === "provider") {
        state.provider = value;
        // Upstream creates an empty entry for the name just selected, in the
        // section its registry lookup picks.
        const target = isPreset(value) ? state.providers : state.custom_providers;
        target[value] = target[value] || {};
        return { code: 0, stdout: "", stderr: "" };
      }
      if (!key.startsWith("providers.") && !key.startsWith("custom_providers.")) {
        state[key] = value;
        return { code: 0, stdout: "", stderr: "" };
      }
      // The v1.13.1 parser: the name is everything between the section and the
      // *last* dot, so a dotted provider name survives.
      const first = key.indexOf(".");
      const last = key.lastIndexOf(".");
      const name = key.slice(first + 1, last);
      const field = key.slice(last + 1);
      if (!isPreset(name) && name.includes(".") && !state.custom_providers[name]) {
        return {
          code: 1,
          stdout: "",
          stderr: `provider "${name}" is not configured for key "${key}"; create or select it first`,
        };
      }
      const target = isPreset(name) ? state.providers : state.custom_providers;
      target[name] = { ...(target[name] || {}), [field]: value };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "config" && args[1] === "unset") {
      const key = args[2];
      const dot = key.indexOf(".");
      const section = key.slice(0, dot);
      const name = key.slice(dot + 1);
      if (state[section]) delete state[section][name];
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "llm" && args[1] === "test") return { code: 0, stdout: "ok", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  const ocr = {
    ...real,
    exec,
    setConfig: async (pairs) => {
      setPairs.push(...pairs);
      const out = [];
      for (const [key, value] of pairs) {
        const res = await exec(["config", "set", key, String(value)]);
        out.push({ key, ok: res.code === 0, message: (res.stderr || res.stdout).trim() });
        if (res.code !== 0) break;
      }
      return out;
    },
    unsetConfig: async (key) => {
      unsetCalls.push(key);
      const res = await exec(["config", "unset", key]);
      return res.code === 0
        ? { ok: true, config: view() }
        : { ok: false, error: real.withHint(real.failureText(res)) };
    },
    readConfigView: () => view(),
    presetRegistry: async (options) => {
      registryCalls.push(options || {});
      if (presetRegistry) return presetRegistry(options);
      return {
        ok: true,
        names: registry,
        rows: registry.map((name) => ({ name, protocol: "openai", url: `https://${name}.example/v1` })),
        matched: registry.length + 1,
        error: "",
      };
    },
    savedKeyLookupByName: async (name, url) => {
      lookupCalls.push({ name, url });
      return savedKeyAnswer;
    },
  };

  const view = () => ({
    provider: state.provider,
    providers: state.providers,
    customProviders: state.custom_providers,
  });

  return {
    ocr,
    state,
    calls,
    setPairs,
    unsetCalls,
    registryCalls,
    lookupCalls,
    setSavedKeyAnswer: (answer) => {
      savedKeyAnswer = answer;
    },
  };
};

const make = (stub) => makeConfigHandlers({ ocr: stub.ocr, tempRoot: dir });

/* ---- the factory wires every config channel ---- */
const handlerNames = Object.keys(make(makeStub())).sort().join(",");
check(
  "the factory returns every config handler the app registers",
  handlerNames === "read,removeEntry,save,savedKey,test,unset,use",
  handlerNames
);

/* ---- a built-in name keeps the spelling the form gave ----
 * `config set providers.DeepSeek.api_key` is what reaches the CLI. Lowercasing
 * it here would write an entry the resolver (which indexes by the raw
 * `provider` string) does not open, and the failure would look like a bad Key.
 */
{
  const stub = makeStub();
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-DeepSeek",
    model: "deepseek-chat",
    setActive: true,
  });
  check("a save succeeds", res.ok === true, res.error);
  check(
    "the provider's spelling is kept in the key it writes",
    stub.setPairs.some(([key, value]) => key === "providers.DeepSeek.api_key" && value === "sk-DeepSeek"),
    JSON.stringify(stub.setPairs)
  );
  check(
    "and the active provider is pointed at that same spelling",
    stub.setPairs.some(([key, value]) => key === "provider" && value === "DeepSeek"),
    JSON.stringify(stub.setPairs)
  );
  check(
    "the CLI's own config was updated under that spelling",
    stub.state.providers.DeepSeek?.api_key === "sk-DeepSeek",
    JSON.stringify(stub.state.providers)
  );
}

/* ---- a blank Key means "leave the saved one alone" ----
 * The form shows an empty Key field when one is already saved. Saving with it
 * blank must not push `api_key: ""`: empty is not the user asking to clear the
 * Key, it is the field having nothing new to say. Clearing has its own channel
 * (`removeEntry`), so a blank field neither writes nor erases.
 */
{
  const stub = makeStub({ providers: { DeepSeek: { api_key: "sk-old" } } });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "",
    model: "deepseek-reasoner",
    setActive: true,
  });
  check("a save with a blank Key succeeds", res.ok === true, res.error);
  check(
    "and no api_key pair is written",
    !stub.setPairs.some(([key]) => key === "providers.DeepSeek.api_key"),
    JSON.stringify(stub.setPairs)
  );
  check(
    "the saved Key is still there",
    stub.state.providers.DeepSeek?.api_key === "sk-old",
    JSON.stringify(stub.state.providers)
  );
}

/* ---- a typed Key overwrites the saved one with the typed value ---- */
{
  const stub = makeStub({ providers: { DeepSeek: { api_key: "sk-old" } } });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-new",
    model: "deepseek-reasoner",
    setActive: true,
  });
  check("a save with a typed Key succeeds", res.ok === true, res.error);
  check(
    "the typed Key is written as the new value",
    stub.setPairs.some(([key, value]) => key === "providers.DeepSeek.api_key" && value === "sk-new"),
    JSON.stringify(stub.setPairs)
  );
  check(
    "and replaces the saved Key",
    stub.state.providers.DeepSeek?.api_key === "sk-new",
    JSON.stringify(stub.state.providers)
  );
}

/* ---- a spelling collision is refused before the first write ----
 * The config already has `providers.deepseek`; the form says `DeepSeek`. The
 * resolver indexes `cfg.Providers[cfg.Provider]` by the raw string, so saving
 * would leave the old Key on the old entry and point the run at a new, empty
 * one. Nothing should be written — not even the Key that looks harmless.
 */
{
  const stub = makeStub({ providers: { deepseek: { api_key: "sk-old" } } });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-new",
    model: "deepseek-chat",
    setActive: true,
  });
  check("a provider that collides with an existing spelling is refused", res.ok === false, JSON.stringify(res));
  check("and nothing was written to the CLI", stub.calls.length === 0 && stub.setPairs.length === 0, `${stub.calls.length} calls`);
  check(
    "the refusal names both spellings",
    res.error.includes("deepseek") && res.error.includes("DeepSeek"),
    res.error
  );
  check(
    "the existing entry keeps the Key it had",
    stub.state.providers.deepseek?.api_key === "sk-old" && stub.state.providers.DeepSeek === undefined,
    JSON.stringify(stub.state.providers)
  );
}

/* ---- only the section the CLI reads can collide ----
 * `deepseek` sitting in `custom_providers` is not the entry a built-in
 * `DeepSeek` save will read (the resolver picks the section by name), so it must
 * not block the save. The custom side is checked the same way in the other
 * direction.
 */
{
  const stub = makeStub({ customProviders: { deepseek: { api_key: "sk-stale" } } });
  const h = make(stub);
  const res = await h.save(null, { provider: "DeepSeek", isCustom: false, apiKey: "sk-new", setActive: true });
  check("a same-spelled entry in the section the CLI will not read does not block a save", res.ok === true, res.error);
  check(
    "and the save writes the section the name belongs to",
    stub.state.providers.DeepSeek?.api_key === "sk-new" && stub.state.custom_providers.deepseek?.api_key === "sk-stale",
    JSON.stringify(stub.state)
  );
}
{
  const stub = makeStub({ customProviders: { "my.gateway": { api_key: "sk-stale" } } });
  const h = make(stub);
  const res = await h.save(null, { provider: "my.Gateway", isCustom: true, apiKey: "sk-new", setActive: true });
  check(
    "the custom section is still checked by its own spelling",
    res.ok === false && stub.calls.length === 0 && res.error.includes("my.gateway"),
    JSON.stringify(res)
  );
}

/* ---- a registry that did not answer refuses both spellings ----
 * Without the registry, the handler cannot know which section the CLI will
 * read for "DeepSeek" (`providers` for a built-in name, `custom_providers` for
 * anything else). The entry below sits in `custom_providers`, so a check that
 * only looked at `providers` would let the save through and split the entry.
 * Refusing is deliberate: a rejected save is cheaper than a second entry whose
 * Key the run never opens.
 */
{
  const stub = makeStub({
    customProviders: { deepseek: { api_key: "sk-old" } },
    presetRegistry: async () => ({ ok: false, names: [], rows: [], matched: 0, error: "registry unavailable" }),
  });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-new",
    model: "deepseek-chat",
    setActive: true,
  });
  check("a save is refused when the registry cannot say which section the CLI reads", res.ok === false, JSON.stringify(res));
  check("and nothing was written to the CLI", stub.calls.length === 0 && stub.setPairs.length === 0, `${stub.calls.length} calls`);
  check(
    "the refusal names both spellings here too",
    res.error.includes("deepseek") && res.error.includes("DeepSeek"),
    res.error
  );
  check(
    "the existing entry keeps the Key it had",
    stub.state.custom_providers.deepseek?.api_key === "sk-old" && stub.state.providers.DeepSeek === undefined,
    JSON.stringify(stub.state)
  );
}

/* ---- a dotted custom name is one name, not two segments ----
 * `my.gateway` already has a `custom_providers` entry, so upstream accepts the
 * field write and routes it there. The key has to stay `providers.my.gateway.
 * api_key`; the pre-8eb8334 split would have read the name as `my` and the field
 * as `gateway.api_key` and rejected it.
 */
{
  const stub = makeStub({
    customProviders: { "my.gateway": { protocol: "openai", url: "https://gw.example/v1" } },
  });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "my.gateway",
    isCustom: true,
    url: "https://gw.example/v1",
    protocol: "openai",
    apiKey: "sk-gateway",
    model: "gpt-x",
    setActive: true,
  });
  check("a dotted custom name saves", res.ok === true, res.error);
  check(
    "the dotted name stays in one key",
    stub.setPairs.some(([key]) => key === "providers.my.gateway.api_key"),
    JSON.stringify(stub.setPairs.map(([key]) => key))
  );
  check(
    "the CLI routed it into custom_providers under the whole name",
    stub.state.custom_providers["my.gateway"]?.api_key === "sk-gateway",
    JSON.stringify(stub.state.custom_providers)
  );
  check(
    "and no `my` entry was invented in either section",
    stub.state.providers.my === undefined && stub.state.custom_providers.my === undefined,
    JSON.stringify(stub.state)
  );
}

/* ---- removing a dotted custom entry uses the same whole name ---- */
{
  const stub = makeStub({ customProviders: { "my.gateway": { api_key: "sk-gateway" } } });
  const h = make(stub);
  const res = await h.removeEntry(null, { name: "my.gateway" });
  check("a dotted custom entry can be removed", res.ok === true, JSON.stringify(res));
  check(
    "and the unset key is the whole name, not a segment",
    stub.unsetCalls[0] === "custom_providers.my.gateway",
    stub.unsetCalls[0]
  );
}

/* ---- the withheld-Key answer is passed through, not flattened ----
 * `order-guess` means an entry exists under a spelling no run opens. The old
 * field hint said "该服务还没有 Key" for this, which sends the user to type a
 * Key that would not be used either. The handler's job is to keep the reason
 * and the sentence that belongs to it.
 */
{
  const stub = makeStub();
  stub.setSavedKeyAnswer({ key: "", reason: "order-guess", endpoint: "", tableOk: true });
  const h = make(stub);
  const res = await h.savedKey(null, { name: "corp-gateway", url: "https://gw.example/v1" });
  check("the lookup is asked with the form's name and URL", stub.lookupCalls[0]?.name === "corp-gateway" && stub.lookupCalls[0]?.url === "https://gw.example/v1", JSON.stringify(stub.lookupCalls));
  check("a withheld Key is not reported as available", res.ok === true && res.available === false, JSON.stringify(res));
  check("the reason survives the boundary", res.reason === "order-guess", res.reason);
  check(
    "and so does the sentence built from it",
    res.hint?.tone === real.savedKeyFieldHint("order-guess").tone &&
      res.hint?.text === real.savedKeyFieldHint("order-guess").text,
    JSON.stringify(res.hint)
  );
}

/* ---- config:read forwards the refresh flag ---- */
{
  const stub = makeStub();
  const h = make(stub);
  await h.read(null, { refresh: true });
  await h.read(null, undefined);
  check(
    "the refresh flag reaches the registry read",
    stub.registryCalls[0]?.refresh === true && stub.registryCalls[1]?.refresh === false,
    JSON.stringify(stub.registryCalls)
  );
}

/* ---- a table that could not be read is named as such ---- */
{
  const stub = makeStub();
  stub.setSavedKeyAnswer({ key: "", reason: "table-unavailable", endpoint: "", tableOk: false });
  const h = make(stub);
  const res = await h.test(null, {
    form: { name: "deepseek", url: "", protocol: "", model: "", apiKey: "" },
  });
  check("a test that cannot run reports the table, not a missing field", res.ok === false && res.output.includes("读不到内置服务表"), res.output);
  check("and no CLI process was spawned for it", stub.calls.length === 0, `${stub.calls.length} calls`);
}

/* ---- main.js is registrations now ---- */
{
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  check(
    "main.js builds the config handlers from config-handler.js",
    mainSrc.includes('require("./config-handler")') && mainSrc.includes("makeConfigHandlers("),
    mainSrc.includes("makeConfigHandlers(") ? "" : "main.js does not use the factory"
  );
  const channels = ["config:read", "config:savedKey", "config:save", "config:removeEntry", "config:use", "config:unset", "config:test"];
  check(
    "every config channel is one line pointing at the handler",
    channels.every((channel) => mainSrc.includes(`ipcMain.handle("${channel}", config.`)),
    channels.filter((channel) => !mainSrc.includes(`ipcMain.handle("${channel}", config.`)).join(", ")
  );
  const buildsKeys = mainSrc.includes("providers.${name}.api_key") || mainSrc.includes("custom_providers.${name}");
  check(
    "and the pair-building body no longer lives there",
    !buildsKeys,
    buildsKeys ? "main.js still builds a config key" : ""
  );
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length ? `${failures.length} failed` : "all config handler checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
