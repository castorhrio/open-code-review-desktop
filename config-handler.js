// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * The `config:*` handlers: what a save writes, and which answer the settings
 * page gets back.
 *
 * These bodies lived in `main.js`, where the only thing a check could say about
 * them was what their source looked like. The decisions they make are not
 * spelling: which key a provider name becomes (and whether dots in a custom
 * name survive), whether a save is refused before it writes, and which of the
 * six withheld-Key reasons is passed through rather than flattened into "no
 * Key". A stub can only observe those by calling the handler.
 *
 * The collaborators are handed in so `tools/config-handler-smoke.mjs` can use a
 * stub `ocr` and count the `config set` pairs that actually go out; the app
 * passes the real service, so it runs the same code either way.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * The spelling a save would split in two.
 *
 * `config set provider <name>` writes `providers.<name>.<field>` and then
 * points `provider` at `<name>`; the CLI resolves the entry by the *raw*
 * string (`tryProviderConfig`: `cfg.Providers[cfg.Provider]`), not by the
 * registry's folded name. So saving "DeepSeek" into a config that already
 * spells the entry "deepseek" creates a second entry, leaves the old Key
 * behind, and the run reads the new one. A form reaching this boundary with
 * the other spelling is a mistake, not a rename: refuse before writing.
 *
 * An exact key wins over any variant — if both spellings exist, the form is
 * pointing at the one it named.
 *
 * The answer carries the **section** the entry was found in, not just its
 * name: the two live in different places of `config.json`, and the fix is a
 * hand edit of that file (or a save under the existing spelling). A refusal
 * that names only the spelling leaves the user to grep the whole file for it.
 *
 * It carries every same-spelled entry, not just the first one. The section
 * the CLI reads is decided by the *name* (`LookupProvider`: a built-in name
 * reads `providers`, every other name reads `custom_providers`), so while
 * the registry is silent the desktop cannot tell which of the two sections
 * the run will open — and a refusal that names one of the two entries sends
 * the user to that entry, leaving the other one in place with a Key the run
 * may end up reading. The answer therefore lists them all.
 *
 * It is a pure function of the view and that list, so it is exported: the
 * refusal's wording is not the contract, the entries it names are, and
 * `tools/config-handler-smoke.mjs` reads them directly instead of counting
 * mentions in a sentence.
 */
const spellingClash = (view, name, presetList) => {
  // Which section the CLI opens is decided by the *name* (`tryProviderConfig`:
  // a built-in name reads `providers`, every other name reads
  // `custom_providers`). Only that section can collide with the save; a
  // same-spelled entry in the other one is dead weight either way.
  //
  // An empty list is not an answer. The CLI always has built-in service names,
  // so `{ ok: true, names: [] }` means the registry read came back hollow, not
  // that every name is custom. Treating it as knowledge would check only
  // `custom_providers` and let a same-spelled entry in `providers` be split —
  // the same hole as an unreachable registry, and the same fix: check both.
  const names = presetList && presetList.ok && Array.isArray(presetList.names) ? presetList.names : [];
  const known = names.length > 0;
  const isPreset = known && names.some((knownName) => String(knownName).toLowerCase() === name.toLowerCase());
  // The section names are the ones the config file uses, because that is
  // where the user has to look. The order is the order the sections are
  // checked in, and with the registry silent it is also the tie-break: the
  // first section holding a same-spelled entry is the one that gets named.
  const sections = known
    ? [[isPreset ? "providers" : "custom_providers", isPreset ? view && view.providers : view && view.customProviders]]
    // The registry did not answer: check both. Refusing a save we might not
    // have needed to refuse is deliberate — without the registry the desktop
    // cannot tell which section the CLI will read, so it cannot know the entry
    // it leaves behind is harmless. A rejected save costs a retry; a split
    // entry costs a Key the run silently never reads.
    : [["providers", view && view.providers], ["custom_providers", view && view.customProviders]];
  for (const [, section] of sections) {
    for (const key of Object.keys(section || {})) if (key === name) return null;
  }
  // Every same-spelled entry is collected, in the order the sections are
  // checked. The first one is the entry the advice points at; the rest ride
  // along in `others`, because with the registry silent the desktop cannot
  // tell which section the CLI will read, and naming only one of two entries
  // leaves the other one in place — with its Key — for the run to read.
  const found = [];
  for (const [sectionName, section] of sections) {
    for (const key of Object.keys(section || {})) {
      if (key.toLowerCase() === name.toLowerCase()) found.push({ name: key, section: sectionName });
    }
  }
  if (!found.length) return null;
  const [first, ...others] = found;
  return { name: first.name, section: first.section, others };
};

/**
 * The refusal a spelling clash is answered with, and the entries it names.
 *
 * The answer is a shape plus a sentence, not a sentence: the sentence is what
 * the settings page shows, and the entries are what the check reads. Counting
 * section names in the sentence pinned the *wording* of the refusal — a rewrite
 * that said the same thing ("在 providers 段" → "属于 providers") turned the
 * fixture red without any decision changing — while the thing worth guarding is
 * "which entries are named, with which spelling, from which section".
 *
 * One entry: name it and its section, and say which spelling to use. That is
 * the whole story — the CLI reads one section, and this is the entry in it.
 *
 * Two entries (only possible while the registry is silent, because that is the
 * only case where both sections are checked): name both, and say that the
 * desktop cannot tell which section the CLI will read, so *both* have to be
 * reconciled. Pointing at a single spelling here is what made the refusal
 * unfixable in one step: the user renamed the form to that spelling, the save
 * went through, and the other entry was still there.
 *
 * Pure in `clash` and `name`, so it is exported and the check can assert
 * `entries` directly — and assert that `save` hands back this very sentence,
 * which ties the two halves together without spelling out any phrase.
 */
const spellingClashMessage = (clash, name) => {
  const entries = [{ name: clash.name, section: clash.section }, ...(clash.others || [])];
  const listed = entries.map((entry) => `${entry.name}（在 ${entry.section} 段）`).join("、");
  if (entries.length === 1) {
    return {
      entries,
      message: `配置里已有 ${listed}，与表单里的 ${name} 只差大小写；CLI 按 provider 字段的原始拼写读条目，这样保存会把同一个服务分成两条，旧条目里的 Key 不会再被读到。请改用已有的拼写 ${clash.name}。`,
    };
  }
  return {
    entries,
    message: `配置里已有 ${entries.length} 条只差大小写的条目：${listed}，都与表单里的 ${name} 只差大小写；CLI 按 provider 字段的原始拼写读条目，而且读哪一段取决于这个名字在 CLI 自己的服务表里算不算内置名——这一版没能读到那张表，说不准它会读哪一段，所以每一条都要你自己核对：请在配置文件里把不要的那一条改掉或删掉，再改用要留的那条的拼写保存。`,
  };
};

/**
 * @param {object} options
 * @param {object} options.ocr       the CLI service
 * @param {string} [options.tempRoot] where `config:test` gets a throwaway HOME
 *                                    (the app passes `app.getPath("temp")`)
 */
function makeConfigHandlers(options) {
  const opts = options || {};
  const ocr = opts.ocr;
  const tempRoot = opts.tempRoot || os.tmpdir();

  /* The readiness view needs one fact this module can only get asynchronously:
   * the CLI's own list of built-in services. `readConfigView` is a synchronous
   * read of the config file, so the list is fetched once (ocr-service caches it)
   * and handed in — the view stays a pure function of the file plus that list,
   * and a hand-edited `providers` entry is judged by the CLI's rule instead of
   * by "the section happens to have this key".
   *
   * `refresh` is only true when the user pressed 刷新: a failed read is
   * remembered for a short window so the settings page cannot spawn a doomed
   * process on every re-render, which would make that button the one thing that
   * does *not* retry.
   */
  const loadConfig = async (refresh = false) => {
    const presetList = await ocr.presetRegistry({ refresh });
    return { presetList, view: ocr.readConfigView({ presetList }) };
  };
  const configView = async (refresh = false) => (await loadConfig(refresh)).view;

  const save = async (_e, form) => {
    const pairs = [];
    // The order of these pairs is part of the answer, not an accident of how the
    // lines were typed. `ocr.setConfig` sends them one after another and stops at
    // the first refusal, so whatever comes first is what a half-finished save has
    // already done. Two rules follow from that:
    //
    // 1. Every write about the entry (`providers.<name>.*`) goes out before the
    //    pair that points the run at it (`provider`). Reversed, a Key the CLI
    //    refuses would leave `provider` already switched to an entry with no Key,
    //    and the next run would fail as "the Key is wrong" when nothing was wrong
    //    with the Key — the same silent half-success `removeEntry` answers with an
    //    error.
    // 2. `model` follows `provider`, because it is the model of the *selected*
    //    service: written first, a refusal of `provider` would leave a model
    //    chosen for a service the config is not on.
    //
    // `tools/config-handler-smoke.mjs` pins the resulting sequence exactly; a
    // reordering here is a change of behaviour and has to show up as a red check.
    const name = (form.provider || "").trim();
    if (!name) return { ok: false, error: "未选择 provider", steps: [] };

    const { presetList, view } = await loadConfig();
    const clash = spellingClash(view, name, presetList);
    if (clash) {
      return {
        ok: false,
        error: spellingClashMessage(clash, name).message,
        steps: [],
      };
    }

    if (form.isCustom) {
      if (form.url) pairs.push([`providers.${name}.url`, form.url]);
      if (form.protocol) pairs.push([`providers.${name}.protocol`, form.protocol]);
    }
    // A blank Key means "leave the saved one alone", not "erase it": the form
    // is empty whenever one is already stored. Clearing goes through
    // `removeEntry`, so this branch must not write an empty value either.
    if (form.apiKey) pairs.push([`providers.${name}.api_key`, form.apiKey]);
    if (form.model) pairs.push([`providers.${name}.model`, form.model]);
    // Saving an entry must not silently switch the active service; the caller
    // asks for that explicitly.
    if (form.setActive !== false) pairs.push(["provider", name]);
    if (form.model && form.setActive !== false) pairs.push(["model", form.model]);
    if (form.effort) pairs.push(["effort", form.effort]);
    if (form.language) pairs.push(["language", form.language]);
    if (form.maxTokens) pairs.push(["max_tokens", form.maxTokens]);

    const steps = await ocr.setConfig(pairs);
    const failed = steps.find((s) => !s.ok);
    return failed
      ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
      : { ok: true, steps, config: await configView() };
  };

  const read = (_e, readOpts) => configView(Boolean(readOpts && readOpts.refresh));

  // "May I leave the Key field blank for what the form is pointed at, and if
  // not, why not?" — the one question the settings page needs answered *before*
  // it asks the user anything. The Key itself never crosses this boundary (see
  // `savedKeyLookup`); the renderer only gets the reason and the sentence built
  // from it, so a wording that distinguishes six causes can be asserted without
  // launching Electron.
  //
  // The lookup happens in the main process because it consults the CLI's own
  // table (`ocr llm providers`), which the renderer does not hold: the form's
  // Base URL for a built-in service is prefilled from that table, so asking here
  // keeps the answer and the field it is about on the same source.
  //
  // The answer also carries the two facts the renderer used to have to work out
  // for itself, and got wrong: `endpoint` is the host the service resolves to
  // (the same `serviceEndpoint` the config view uses, so the endpoint the Key is
  // compared against and the endpoint on screen are one host), and `tableOk`
  // says whether the built-in table could be read at all — so the banner about
  // that table and the sentence under the Key field come from one answer.
  const savedKey = async (_e, req) => {
    const form = req || {};
    const found = await ocr.savedKeyLookupByName(form.name, form.url);
    return {
      ok: true,
      available: Boolean(found.key),
      reason: found.reason,
      hint: ocr.savedKeyFieldHint(found.reason),
      endpoint: found.endpoint,
      tableOk: found.tableOk,
    };
  };

  const unset = (_e, key) => ocr.unsetConfig(key);

  // Built-in provider entries cannot be removed (`config unset` rejects them),
  // so clearing their key and model is the equivalent of un-configuring them.
  const removeEntry = async (_e, req) => {
    const name = (req.name || "").trim();
    if (!name) return { ok: false, error: "未指定服务名" };
    const isCustom = Boolean((await configView()).customProviders[name]);
    // A custom entry is deleted whole (`config unset custom_providers.<name>`),
    // which is the only write this branch makes — so a refusal means nothing was
    // removed. `unsetConfig` answers with the CLI's own sentence and no key of
    // its own, and the page cannot say which entry was refused from a sentence
    // alone (a custom name may contain dots, which is the whole reason this
    // branch exists). The key is therefore named here, the same way the built-in
    // branch below names the write that failed.
    if (isCustom) {
      const key = `custom_providers.${name}`;
      const res = await ocr.unsetConfig(key);
      if (res && res.ok) return res;
      const said = String((res && res.error) || "").trim();
      return { ok: false, error: `${key}: ${said || "删除没有成功，CLI 没有给出原因"}` };
    }
    const steps = await ocr.setConfig([
      [`providers.${name}.api_key`, ""],
      [`providers.${name}.model`, ""],
    ]);
    const failed = steps.find((s) => !s.ok);
    return failed
      ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
      : { ok: true, cleared: true, message: `已清空 ${name} 的 Key 与模型（内置服务无法删除，仅能解除配置）`, config: await configView() };
  };

  const use = async (_e, req) => {
    const pairs = [["provider", req.name]];
    if (req.model) pairs.push(["model", req.model]);
    const steps = await ocr.setConfig(pairs);
    const failed = steps.find((s) => !s.ok);
    return failed
      ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
      : { ok: true, config: await configView() };
  };

  // `ocr llm test` reads only the saved config, so "test what I just typed" runs
  // the CLI against an empty temp HOME with OCR_LLM_* set: the config in the real
  // HOME would otherwise win and the test would prove nothing about the form.
  const test = async (_e, req) => {
    const form = req && req.form;
    if (form) {
      const missing = [
        ["url", "Base URL"],
        ["protocol", "协议"],
        ["model", "模型名"],
      ]
        .filter(([key]) => !String(form[key] || "").trim())
        .map(([, label]) => label);
      // A saved Key is only reused for the endpoint it belongs to. A built-in
      // service is usually configured with a Key and no URL — the CLI fills the
      // endpoint in from its own table — so "which host does this Key belong to"
      // has to consult that table (see `savedKeyLookupByName`); asking `savedKeyFor`
      // alone treated the empty URL as a wildcard.
      //
      // The lookup also answers *why* it withheld, and that is what the message is
      // worded from: a built-in service table that could not be read leaves the
      // form's Base URL empty too, so without the reason this branch said "还缺
      // Base URL" — pointing the user at their own typing when the fix was one
      // press of 刷新.
      const typed = String(form.apiKey || "").trim();
      const saved = typed ? { key: typed, reason: "" } : await ocr.savedKeyLookupByName(form.name, form.url);
      const apiKey = saved.key;
      if (missing.length || !apiKey) {
        return {
          ok: false,
          via: "form",
          output: ocr.savedKeyTestMessage({ missing, reason: saved.reason }),
        };
      }
      let home = "";
      try {
        home = fs.mkdtempSync(path.join(tempRoot, "ocr-llmtest-"));
        const res = await ocr.exec(
          ["llm", "test", "--color", "never"],
          undefined,
          ocr.llmTestEnv({ ...form, apiKey }, home)
        );
        return {
          ok: res.code === 0,
          via: "form",
          output: ocr.withHint(res.code === 0 ? (res.stdout + res.stderr).trim() : ocr.failureText(res)),
        };
      } catch (err) {
        return { ok: false, via: "form", output: `测试没有跑起来：${err.message}` };
      } finally {
        if (home) fs.rmSync(home, { recursive: true, force: true });
      }
    }
    const res = await ocr.exec(["llm", "test", "--color", "never"]);
    return {
      ok: res.code === 0,
      via: "saved",
      output: ocr.withHint(res.code === 0 ? (res.stdout + res.stderr).trim() : ocr.failureText(res)),
    };
  };

  return { save, read, savedKey, unset, removeEntry, use, test };
}

module.exports = { makeConfigHandlers, spellingClash, spellingClashMessage };
