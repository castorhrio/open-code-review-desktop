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
const { makeConfigHandlers, spellingClash, spellingClashMessage } = require(path.join(ROOT, "config-handler.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-config-handler-"));

/* The registry answers the stub hands out, as `presetRegistry` returns them.
 * `spellingClash` reads only `ok` and `names`, so the shape can stay this thin. */
const answeredPresets = (names) => ({ ok: true, names });
const SILENT_PRESETS = { ok: false, names: [] };
const HOLLOW_PRESETS = { ok: true, names: [] };

/**
 * The entries a clash refusal names, read as a shape.
 *
 * "Which entries does the refusal name, spelled how, from which section" is the
 * question worth pinning, and it used to be answered by counting `providers 段`
 * in the sentence — which pinned the *wording*: any rewrite that said the same
 * thing turned the check red while the decision was unchanged, and the two
 * section names overlap (`custom_providers` contains `providers`), so the count
 * needed a hand-written regex to tell them apart.
 *
 * The answer is read from the handler's own pure function (`spellingClash` then
 * `spellingClashMessage`) with the view and registry list the stub just gave the
 * handler — so it is the real decision, not a second copy of it. `saidVerbatim`
 * closes the loop on the other half: `save` has to show exactly this sentence,
 * which is what catches a handler that named different entries.
 */
const refusalOf = (res, stub, name, presetList) => {
  const clash = spellingClash(stub.ocr.readConfigView(), name, presetList);
  const answer = clash ? spellingClashMessage(clash, name) : null;
  return {
    count: answer ? answer.entries.length : 0,
    entries: answer ? answer.entries : [],
    spellings: answer ? answer.entries.map((entry) => entry.name).join(",") : "",
    sections: answer ? answer.entries.map((entry) => entry.section).join(",") : "",
    saidVerbatim: Boolean(answer) && res.error === answer.message,
  };
};

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

/* ---- the save writes the entry before it points the run at it ----
 * `ocr.setConfig` sends the pairs one after another and stops at the first
 * refusal, so the order is what a half-finished save has already done. The
 * dangerous order is `provider` first: a Key the CLI then refuses would leave
 * the config already pointed at an entry with no Key, and the next run would
 * fail as "the Key is wrong". Nothing about that shows in a per-pair check —
 * every pair is present either way — so the sequence itself is pinned here.
 */
{
  const stub = makeStub();
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-order",
    model: "deepseek-chat",
    setActive: true,
    effort: "high",
    language: "zh",
    maxTokens: "8192",
  });
  check("a save with the globals filled succeeds", res.ok === true, res.error);
  const keys = stub.setPairs.map(([key]) => key);
  check(
    "the built-in write order is: the entry's fields, then the pointer, then the model",
    JSON.stringify(keys) ===
      JSON.stringify([
        "providers.DeepSeek.api_key",
        "providers.DeepSeek.model",
        "provider",
        "model",
        "effort",
        "language",
        "max_tokens",
      ]),
    JSON.stringify(keys)
  );
  check(
    "so nothing about the pointer goes out before the entry is written",
    keys.indexOf("provider") === 2 && keys.slice(0, 2).every((key) => key.startsWith("providers.DeepSeek.")),
    JSON.stringify(keys)
  );
}

/* ---- and the custom entry's own fields go first too ---- */
{
  const stub = makeStub({ customProviders: { "my.gateway": {} } });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "my.gateway",
    isCustom: true,
    url: "https://gw.example/v1",
    protocol: "openai",
    apiKey: "sk-order",
    model: "gpt-x",
    setActive: true,
  });
  check("a custom save succeeds", res.ok === true, res.error);
  const keys = stub.setPairs.map(([key]) => key);
  check(
    "a custom write sends url, protocol, Key and model before the pointer",
    JSON.stringify(keys) ===
      JSON.stringify([
        "providers.my.gateway.url",
        "providers.my.gateway.protocol",
        "providers.my.gateway.api_key",
        "providers.my.gateway.model",
        "provider",
        "model",
      ]),
    JSON.stringify(keys)
  );
}

/* ---- saving an entry without switching the active service ----
 * `setActive: false` is the "edit this entry, but keep running the old service"
 * path, and the two skipped pairs are the whole difference: no `provider`, and
 * no global `model` either (the model belongs to the selected service, and the
 * selected service is not changing). The exact sequence is pinned, not just the
 * absence of the pointer, because a `model` that slipped through would rewrite
 * the model of the service the user is still on — a silent change of what the
 * next run uses, which no per-field assertion would see.
 *
 * The config starts on another service on purpose: "did not switch" is only
 * observable when there is something to stay on.
 */
{
  const stub = makeStub({ providers: { other: { api_key: "sk-other" } } });
  stub.state.provider = "other";
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-idle",
    model: "deepseek-chat",
    setActive: false,
    effort: "high",
    language: "zh",
    maxTokens: "8192",
  });
  check("a save that must not switch the active service succeeds", res.ok === true, res.error);
  const keys = stub.setPairs.map(([key]) => key);
  check(
    "its write order is the entry's fields, then the globals — no pointer, no global model",
    JSON.stringify(keys) ===
      JSON.stringify([
        "providers.DeepSeek.api_key",
        "providers.DeepSeek.model",
        "effort",
        "language",
        "max_tokens",
      ]),
    JSON.stringify(keys)
  );
  check(
    "and the active service is still the one from before the save",
    stub.state.provider === "other",
    JSON.stringify({ provider: stub.state.provider, providers: stub.state.providers })
  );
  check(
    "with the edited entry really written, model included",
    stub.state.providers.DeepSeek?.api_key === "sk-idle" &&
      stub.state.providers.DeepSeek?.model === "deepseek-chat" &&
      stub.state.providers.other?.api_key === "sk-other",
    JSON.stringify(stub.state.providers)
  );
  check(
    "and no global model was written for a service that was not selected",
    stub.state.model === undefined,
    JSON.stringify({ model: stub.state.model })
  );
}

/* ---- a refused Key leaves the active service where it was ----
 * The point of the order, stated as the thing the user would notice: when the
 * Key write is the one the CLI refuses, the config must still be on the service
 * it was on before the save. With `provider` first, this fixture would end with
 * `state.provider === "DeepSeek"` and no Key under it — an active service that
 * nothing configured, which the next run reads as a bad Key.
 */
{
  const stub = makeStub({ providers: { other: { api_key: "sk-other" } } });
  stub.state.provider = "other";
  const ocr = {
    ...stub.ocr,
    // The stub's own routing, with one write refused: the same sequence
    // `ocr-service.js` runs, stopping where the CLI would.
    setConfig: async (pairs) => {
      stub.setPairs.push(...pairs);
      const out = [];
      for (const [key, value] of pairs) {
        const res =
          key === "providers.DeepSeek.api_key"
            ? { code: 1, stdout: "", stderr: 'invalid value for "api_key": empty' }
            : await stub.ocr.exec(["config", "set", key, String(value)]);
        out.push({ key, ok: res.code === 0, message: (res.stderr || res.stdout).trim() });
        if (res.code !== 0) break;
      }
      return out;
    },
  };
  const h = makeConfigHandlers({ ocr, tempRoot: dir });
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-refused",
    model: "deepseek-chat",
    setActive: true,
  });
  check("a save whose Key write is refused is not a success", res.ok === false, JSON.stringify(res));
  check(
    "and the active service is still the one from before the save",
    stub.state.provider === "other",
    JSON.stringify({ provider: stub.state.provider, providers: stub.state.providers })
  );
  check(
    "with the refused write named in the error",
    String(res.error).includes("providers.DeepSeek.api_key"),
    res.error
  );
  check(
    "and the entry was not half written under the new spelling",
    stub.state.providers.DeepSeek === undefined && stub.state.custom_providers.DeepSeek === undefined,
    JSON.stringify({ providers: stub.state.providers, custom: stub.state.custom_providers })
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
  const refused = refusalOf(res, stub, "DeepSeek", answeredPresets(["deepseek"]));
  check(
    "and the refusal names that one entry, with its own spelling and section",
    refused.count === 1 && refused.spellings === "deepseek" && refused.sections === "providers",
    JSON.stringify(refused)
  );
  check("which is the sentence `save` hands back unchanged", refused.saidVerbatim, res.error);
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
  const refused = refusalOf(res, stub, "my.Gateway", answeredPresets(["deepseek"]));
  check(
    "and the clash is that one entry, from the custom section",
    refused.count === 1 && refused.spellings === "my.gateway" && refused.sections === "custom_providers",
    JSON.stringify(refused)
  );
  check("with the sentence `save` hands back unchanged", refused.saidVerbatim, res.error);
}

/* ---- the refusal says *where* every same-spelled entry lives ----
 * The two sections live in different places of `config.json`, so a refusal that
 * names only the spelling leaves the user to grep the whole file for it. The
 * message therefore names the section too.
 *
 * With the registry silent both sections are checked, and the desktop cannot
 * tell which one the CLI will open: the CLI picks the section by the *name*
 * (`tryProviderConfig` → `LookupProvider`: a built-in name reads `providers`,
 * every other name reads `custom_providers`), and the registry is the only
 * place that knows which names are built-in. So both entries below have to be
 * named — naming only one of them sent the user to the wrong entry, and the
 * other one stayed in the file with its Key.
 *
 * The two entries are spelled differently on purpose (`deepseek` vs `DEEPSEEK`)
 * so the message says *which* one is in *which* section — with the same
 * spelling in both sections, the name in the message would not tell the two
 * apart and the assertion would pass either way.
 */
{
  const stub = makeStub({
    providers: { deepseek: { api_key: "sk-old" } },
    customProviders: { DEEPSEEK: { api_key: "sk-other" } },
    presetRegistry: async () => ({ ok: false, names: [], rows: [], matched: 0, error: "registry unavailable" }),
  });
  const h = make(stub);
  const res = await h.save(null, { provider: "DeepSeek", isCustom: false, apiKey: "sk-new", setActive: true });
  check("a save is refused when both sections hold a same-spelled entry", res.ok === false, JSON.stringify(res));
  check(
    "the refusal names both same-spelled entries, not just the first one",
    res.error.includes("deepseek") && res.error.includes("DEEPSEEK"),
    res.error
  );
  const refused = refusalOf(res, stub, "DeepSeek", SILENT_PRESETS);
  check(
    "and it names both entries, each with its own spelling and section",
    refused.count === 2 &&
      refused.spellings === "deepseek,DEEPSEEK" &&
      refused.sections === "providers,custom_providers",
    JSON.stringify(refused)
  );
  check("with the sentence `save` hands back unchanged", refused.saidVerbatim, res.error);
  check(
    "it does not point at a single spelling, because both have to be reconciled",
    !res.error.includes("请改用已有的拼写"),
    res.error
  );
  check(
    "and it asks for the other entry to be dealt with, not only renamed",
    res.error.includes("改掉或删掉"),
    res.error
  );
  check(
    "neither entry is touched",
    stub.state.providers.deepseek?.api_key === "sk-old" &&
      stub.state.custom_providers.DEEPSEEK?.api_key === "sk-other" &&
      stub.state.provider === "",
    JSON.stringify(stub.state)
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
  const refused = refusalOf(res, stub, "DeepSeek", SILENT_PRESETS);
  check(
    "only the section that really holds an entry is named",
    refused.count === 1 && refused.sections === "custom_providers" && refused.spellings === "deepseek",
    JSON.stringify(refused)
  );
  check(
    "and a single entry still gets the single-entry advice",
    res.error.includes("请改用已有的拼写"),
    res.error
  );
  check(
    "the existing entry keeps the Key it had",
    stub.state.custom_providers.deepseek?.api_key === "sk-old" && stub.state.providers.DeepSeek === undefined,
    JSON.stringify(stub.state)
  );
}

/* ---- a registry that answered with no names is not an answer ----
 * `{ ok: true, names: [] }` used to count as "the registry knows the list", so
 * "DeepSeek" was judged a custom name and only `custom_providers` was checked.
 * The same-spelled entry below sits in `providers`, so the save went through and
 * split it. The CLI always has built-in names, so an empty list means the read
 * came back hollow; it has to be treated like an unreachable registry and both
 * sections checked.
 */
{
  const stub = makeStub({
    providers: { deepseek: { api_key: "sk-old" } },
    presetRegistry: async () => ({ ok: true, names: [], rows: [], matched: 0, error: "" }),
  });
  const h = make(stub);
  const res = await h.save(null, {
    provider: "DeepSeek",
    isCustom: false,
    apiKey: "sk-new",
    model: "deepseek-chat",
    setActive: true,
  });
  check("an empty registry list is treated as unknown, not as \"all custom\"", res.ok === false, JSON.stringify(res));
  check("and nothing was written to the CLI", stub.calls.length === 0 && stub.setPairs.length === 0, `${stub.calls.length} calls`);
  const refused = refusalOf(res, stub, "DeepSeek", HOLLOW_PRESETS);
  check(
    "the refusal names the entry in the providers section",
    refused.count === 1 && refused.spellings === "deepseek" && refused.sections === "providers",
    JSON.stringify(refused)
  );
  check("and the old Key is still the only one", stub.state.providers.deepseek?.api_key === "sk-old" && !stub.state.providers.DeepSeek, JSON.stringify(stub.state));
}

/* ---- a hollow registry list still checks both sections ----
 * The check above proves the empty list is not taken as knowledge, because the
 * same-spelled entry sits in `providers` and a "custom name" reading would only
 * have looked in `custom_providers`. These two pin the other half: with the list
 * hollow, *both* sections are read, and *both* entries are named. Without them
 * `spellingClash` could check only `providers` and stay green — which is the
 * shape the earlier bug came in.
 */
{
  // Only `custom_providers` holds a same-spelled entry. A handler that still
  // treated `{ ok: true, names: [] }` as "every name is custom" would check
  // exactly this section and pass, so the entry sits in `providers` above and in
  // `custom_providers` here: one shape each way round.
  const stub = makeStub({
    customProviders: { deepseek: { api_key: "sk-custom" } },
    presetRegistry: async () => ({ ok: true, names: [], rows: [], matched: 0, error: "" }),
  });
  const h = make(stub);
  const res = await h.save(null, { provider: "DeepSeek", isCustom: false, apiKey: "sk-new", setActive: true });
  check("a hollow registry list refuses a clash in custom_providers too", res.ok === false, JSON.stringify(res));
  const refused = refusalOf(res, stub, "DeepSeek", HOLLOW_PRESETS);
  check(
    "and that refusal points at custom_providers, and only at it",
    refused.count === 1 && refused.sections === "custom_providers" && refused.spellings === "deepseek",
    JSON.stringify(refused)
  );
  check("nothing was written for it either", stub.calls.length === 0 && stub.setPairs.length === 0, `${stub.calls.length} calls`);
}

{
  // Both sections hold one, spelled differently so the message has to say which
  // is which. The two-entry advice is the only one that asks for every entry to
  // be dealt with; a single-spelling pointer here is the unfixable refusal.
  const stub = makeStub({
    providers: { deepseek: { api_key: "sk-old" } },
    customProviders: { DEEPSEEK: { api_key: "sk-other" } },
    presetRegistry: async () => ({ ok: true, names: [], rows: [], matched: 0, error: "" }),
  });
  const h = make(stub);
  const res = await h.save(null, { provider: "DeepSeek", isCustom: false, apiKey: "sk-new", setActive: true });
  check("a hollow registry list refuses a clash in both sections", res.ok === false, JSON.stringify(res));
  check("and lists both entries", res.error.includes("deepseek") && res.error.includes("DEEPSEEK"), res.error);
  const refused = refusalOf(res, stub, "DeepSeek", HOLLOW_PRESETS);
  check(
    "naming each entry with its own spelling and section",
    refused.count === 2 &&
      refused.spellings === "deepseek,DEEPSEEK" &&
      refused.sections === "providers,custom_providers",
    JSON.stringify(refused)
  );
  check("with the two-entry advice, not a single spelling", !res.error.includes("请改用已有的拼写") && res.error.includes("改掉或删掉"), res.error);
  check(
    "neither entry is touched",
    stub.state.providers.deepseek?.api_key === "sk-old" &&
      stub.state.custom_providers.DEEPSEEK?.api_key === "sk-other" &&
      stub.state.provider === "",
    JSON.stringify(stub.state)
  );
}

/* ---- the clash answer is a shape, not a sentence ----
 * The refusals above read this answer (through `refusalOf`); these pin it on its
 * own, so the empty and the silent registry can be compared side by side.
 * `spellingClash` is a pure function of the view plus the registry list, so the
 * decision itself can be read: which entry is named first, and which entries
 * ride along in `others`.
 *
 * Both paths have to be pinned, because they check a different number of
 * sections: with a registry answer only the section the *name* belongs to is
 * looked at, and with the registry silent both are. A check that only read one
 * path would be green for a function that got the other one wrong.
 */
{
  const answered = { ok: true, names: ["deepseek", "openai"], rows: [], matched: 2, error: "" };
  const silent = { ok: false, names: [], rows: [], matched: 0, error: "registry unavailable" };
  const both = { providers: { deepseek: {} }, customProviders: { DEEPSEEK: {} } };

  const builtin = spellingClash(both, "DeepSeek", answered);
  check(
    "a built-in name's clash names the providers entry and nothing else",
    builtin !== null &&
      builtin.name === "deepseek" &&
      builtin.section === "providers" &&
      Array.isArray(builtin.others) &&
      builtin.others.length === 0,
    JSON.stringify(builtin)
  );

  const strayCustom = spellingClash({ customProviders: { deepseek: {} } }, "DeepSeek", answered);
  check(
    "and a same-spelled entry in the section the CLI will not read is not a clash",
    strayCustom === null,
    JSON.stringify(strayCustom)
  );

  const custom = spellingClash({ providers: { "my.gateway": {} }, customProviders: { "my.Gateway": {} } }, "my.gateway", answered);
  check(
    "a name the registry does not know is answered from custom_providers",
    custom !== null &&
      custom.name === "my.Gateway" &&
      custom.section === "custom_providers" &&
      custom.others.length === 0,
    JSON.stringify(custom)
  );

  const two = spellingClash(both, "DeepSeek", silent);
  check(
    "a silent registry puts the providers entry first",
    two !== null && two.name === "deepseek" && two.section === "providers",
    JSON.stringify(two)
  );
  check(
    "and carries exactly one other entry, with its own spelling and section",
    two !== null && two.others.length === 1 && two.others[0].name === "DEEPSEEK" && two.others[0].section === "custom_providers",
    JSON.stringify(two && two.others)
  );

  check(
    "an exact key is not a clash at all",
    spellingClash({ providers: { DeepSeek: {} }, customProviders: { deepseek: {} } }, "DeepSeek", silent) === null,
    JSON.stringify(spellingClash({ providers: { DeepSeek: {} }, customProviders: { deepseek: {} } }, "DeepSeek", silent))
  );

  // A registry that answered with an empty list is not "every name is custom":
  // the CLI always has built-in names, so the list came back hollow. This is the
  // same answer `spellingClash` gives for an unreachable registry — both
  // sections checked, both entries named — and it is pinned here directly so the
  // rule survives a handler that happens to call it with the same list.
  const hollow = spellingClash(both, "DeepSeek", HOLLOW_PRESETS);
  check(
    "an empty registry list is read like a silent one",
    hollow !== null &&
      hollow.name === "deepseek" &&
      hollow.section === "providers" &&
      hollow.others.length === 1 &&
      hollow.others[0].name === "DEEPSEEK" &&
      hollow.others[0].section === "custom_providers",
    JSON.stringify(hollow)
  );

  // The sentence and the entries come out of one call, so the refusal cannot
  // name one entry and list another. `entries` is what the checks above read.
  const one = spellingClashMessage(builtin, "DeepSeek");
  const twoSaid = spellingClashMessage(two, "DeepSeek");
  check(
    "the refusal's entries are the clash's entries, first one included",
    one.entries.length === 1 && one.entries[0].name === "deepseek" && one.entries[0].section === "providers",
    JSON.stringify(one.entries)
  );
  check(
    "and both entries ride along for a two-entry clash",
    twoSaid.entries.length === 2 && twoSaid.entries[1].name === "DEEPSEEK" && twoSaid.entries[1].section === "custom_providers",
    JSON.stringify(twoSaid.entries)
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

/* ---- a custom removal the CLI refuses is a failure, and names the entry ----
 * Deleting a custom entry is one `config unset`, so a refusal means nothing was
 * removed — but `unsetConfig` answers with the CLI's sentence only. The page's
 * error toast would then say why the CLI refused without saying which entry it
 * refused, and a custom name may contain dots (`custom_providers.my.gateway`),
 * which is exactly the case this branch exists for. So the key is named by the
 * handler, the way the built-in branch names the write that failed.
 */
{
  const stub = makeStub({ customProviders: { "my.gateway": { api_key: "sk-gateway" } } });
  const ocr = {
    ...stub.ocr,
    unsetConfig: async (key) => {
      stub.unsetCalls.push(key);
      return { ok: false, error: real.withHint('Error: cannot unset "my.gateway": config file is read-only') };
    },
  };
  const h = makeConfigHandlers({ ocr, tempRoot: dir });
  const res = await h.removeEntry(null, { name: "my.gateway" });
  check("a custom removal the CLI refuses is not reported as removed", res.ok === false, JSON.stringify(res));
  check(
    "and the refusal names the key that failed, whole name included",
    String(res.error).startsWith("custom_providers.my.gateway: "),
    res.error
  );
  check("with the CLI's own sentence kept", String(res.error).includes("config file is read-only"), res.error);
  check(
    "and no built-in clear was attempted instead",
    stub.setPairs.length === 0 && stub.unsetCalls.length === 1,
    `${stub.setPairs.length} pairs, ${stub.unsetCalls.length} unsets`
  );
}
{
  // The same branch with a CLI that fails silently: the failure still has to be
  // a failure with a sentence, not `ok: true` and an empty message.
  const stub = makeStub({ customProviders: { "my.gateway": { api_key: "sk-gateway" } } });
  const ocr = { ...stub.ocr, unsetConfig: async () => ({ ok: false }) };
  const h = makeConfigHandlers({ ocr, tempRoot: dir });
  const res = await h.removeEntry(null, { name: "my.gateway" });
  check("a refusal with no sentence is still a failure", res.ok === false, JSON.stringify(res));
  check(
    "and it still names the key, with a sentence of its own",
    String(res.error).includes("custom_providers.my.gateway") && String(res.error).length > "custom_providers.my.gateway: ".length,
    res.error
  );
}

/* ---- a custom save the CLI refuses is not a success either ----
 * The `isCustom` writes (`url` / `protocol`) go out before the Key, so one
 * refusal stops the rest of the save. The answer has to say so and name the
 * write that failed: a save that dropped the url half and reported success
 * would leave the form showing an endpoint the config does not have.
 */
{
  const stub = makeStub({ customProviders: { "my.gateway": { api_key: "sk-gateway" } } });
  const ocr = {
    ...stub.ocr,
    setConfig: async (pairs) => {
      stub.setPairs.push(...pairs);
      return pairs.map(([key]) => ({
        key,
        ok: key !== "providers.my.gateway.url",
        message: key === "providers.my.gateway.url" ? 'invalid value for "url": not an absolute URL' : "",
      }));
    },
  };
  const h = makeConfigHandlers({ ocr, tempRoot: dir });
  const res = await h.save(null, {
    provider: "my.gateway",
    isCustom: true,
    url: "gw.example/v1",
    protocol: "openai",
    apiKey: "sk-typed",
    model: "gpt-x",
    setActive: true,
  });
  check("a custom save the CLI refuses is not a success", res.ok === false, JSON.stringify(res));
  check("and the error names the url write", String(res.error).includes("providers.my.gateway.url"), res.error);
  check("with the CLI's own sentence kept", String(res.error).includes("not an absolute URL"), res.error);
  check(
    "the steps ride along so the page can see what did get written",
    Array.isArray(res.steps) && res.steps.some((s) => !s.ok) && res.steps[0]?.key === "providers.my.gateway.url",
    JSON.stringify(res.steps)
  );
}

/* ---- `use` switches only what it was asked to switch ----
 * The settings page calls this when the user activates a service from history.
 * Writing a `model` pair without a model in the request would overwrite the
 * saved one with `""` — an activation that silently erases a choice the user
 * made earlier.
 */
{
  const stub = makeStub({ providers: { deepseek: { api_key: "sk-saved", model: "deepseek-chat" } } });
  const h = make(stub);
  const res = await h.use(null, { name: "deepseek" });
  check(
    "activating a service points the CLI at it",
    res.ok === true && stub.setPairs.some(([key, value]) => key === "provider" && value === "deepseek"),
    JSON.stringify(stub.setPairs)
  );
  check(
    "without a model in the request, no model pair is written",
    !stub.setPairs.some(([key]) => key === "model"),
    JSON.stringify(stub.setPairs)
  );
  check("and the saved model is left as it was", stub.state.providers.deepseek?.model === "deepseek-chat", JSON.stringify(stub.state.providers));
}
{
  const stub = makeStub({ providers: { deepseek: { api_key: "sk-saved", model: "deepseek-chat" } } });
  const h = make(stub);
  const res = await h.use(null, { name: "deepseek", model: "deepseek-reasoner" });
  check(
    "activating with a model does write that model",
    res.ok === true && stub.setPairs.some(([key, value]) => key === "model" && value === "deepseek-reasoner"),
    JSON.stringify(stub.setPairs)
  );
}

/* ---- a built-in entry can be cleared even without a Key ----
 * Built-ins cannot be deleted (`config unset` rejects them), so `removeEntry`
 * clears both fields instead. An entry that has only a model is still an entry
 * the user asked to un-configure; skipping the clear because there is no Key
 * would leave the model pointing at a service they just tried to remove.
 */
{
  const stub = makeStub({ providers: { deepseek: { model: "deepseek-chat" } } });
  const h = make(stub);
  const res = await h.removeEntry(null, { name: "deepseek" });
  check("a built-in entry with only a model still clears", res.ok === true && res.cleared === true, JSON.stringify(res));
  check(
    "and both fields are written empty, not skipped for a missing Key",
    stub.setPairs.some(([key, value]) => key === "providers.deepseek.api_key" && value === "") &&
      stub.setPairs.some(([key, value]) => key === "providers.deepseek.model" && value === ""),
    JSON.stringify(stub.setPairs)
  );
}

/* ---- a built-in clear the CLI refuses is a failure, not a success ----
 * The clear is two writes, and either can be refused. Returning the steps with
 * `ok: true` would let the settings page announce 已清空 while the entry is
 * still configured and the next run still reads its Key — the same silent
 * half-success `save` already answers with an error. The failure has to name
 * the write that failed and keep the CLI's own message, so the page can say
 * which one to fix.
 */
{
  const stub = makeStub({ providers: { deepseek: { api_key: "sk-saved", model: "deepseek-chat" } } });
  const ocr = {
    ...stub.ocr,
    // Only the second write fails: this is a clear that was half done, not a
    // clear that never reached the CLI.
    setConfig: async (pairs) => {
      stub.setPairs.push(...pairs);
      return pairs.map(([key]) => ({
        key,
        ok: key !== "providers.deepseek.model",
        message: key === "providers.deepseek.model" ? 'invalid field "model"' : "",
      }));
    },
  };
  const h = makeConfigHandlers({ ocr, tempRoot: dir });
  const res = await h.removeEntry(null, { name: "deepseek" });
  check("a built-in clear the CLI refuses is not reported as cleared", res.ok === false && !res.cleared, JSON.stringify(res));
  check("and the refusal names the write that failed", String(res.error).includes("providers.deepseek.model"), res.error);
  check("with the CLI's own message kept", String(res.error).includes("invalid field"), res.error);
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
