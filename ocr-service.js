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

// The Key never travels to the renderer: the settings page asks "may I reuse
// what is already saved for this service?" and only gets a value back when the
// endpoint being tested is the one that Key belongs to. Sending a saved Key to
// a URL the user just typed would leak it to another host.
function savedKeyFor(name, url) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {
    return "";
  }
  const entry = (raw.providers || {})[name] || (raw.custom_providers || {})[name];
  if (!entry) return "";
  const saved = String(entry.url || "").trim().replace(/\/+$/, "");
  const target = String(url || "").trim().replace(/\/+$/, "");
  if (saved && saved !== target) return "";
  return String(entry.api_key || entry.auth_token || "");
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
const PROVIDER_ROW = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}/;

function parseProviderNames(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => PROVIDER_ROW.exec(line))
    .filter((m) => m && m[1].toUpperCase() !== "NAME")
    .map((m) => m[1]);
}

// Read once per process: the table lives in the CLI, so it costs one process
// spawn, and a stale list is safer than a guessed one (the registry only grows).
// `null` means "could not be read" — which is not the same as "empty", and the
// view below falls back to its older reading rather than inventing a registry.
let cachedPresetNames = null;

async function presetNames() {
  if (cachedPresetNames) return cachedPresetNames;
  const res = await exec(["llm", "providers", "--color", "never"]);
  if (res.code !== 0) return null;
  const names = parseProviderNames(res.stdout);
  if (!names.length) return null;
  cachedPresetNames = names;
  return names;
}

function readConfigView({ configPath = CONFIG_PATH, env = process.env, presetNames: presetList = null } = {}) {
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
  // which must not be read as "no name is built in".
  const presets =
    Array.isArray(presetList) && presetList.length
      ? new Set(presetList.map((name) => String(name).toLowerCase()))
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
  // The same branch, now that the `custom_providers` fallback is checked: a name
  // the registry does not know is rejected whether the stray entry sits in
  // `providers` or nowhere at all, but a name that *does* live in
  // `custom_providers` is the entry the resolver reads, so it is not rejected.
  const rejectedProvider = presets && active && !registryHit && !customEntry ? active : "";
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
  // A rejected name is not one of the three fields: the CLI never opens that
  // section, so no URL, Key or model added under it changes the outcome. Its own
  // gap key keeps `ready` and `missing` agreeing while naming the real problem.
  view.rejectedProvider = rejectedProvider;
  view.missing = rejectedProvider ? ["provider"] : GAP_ORDER.filter((key) => !gapPresent[key]);
  view.ready = view.missing.length === 0;
  const gapText = listText(view.missing.map((key) => GAP_LABEL[key] || key));
  // Same order and same labels as the gap list above, so the two halves of the
  // sentence cannot spell a dimension differently.
  const configuredParts = GAP_ORDER.filter((key) => gapPresent[key]).map((key) => GAP_LABEL[key]);
  if (view.ready) view.blockedReason = "";
  // The whole config is refused, so the sentence must not read like a form with
  // one empty field left: the fix is to rename or move the entry.
  else if (rejectedProvider)
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
    progress.comments = Number(m[2]) || progress.comments;
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
  if (tool === "code_comment") progress.comments += 1;
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
    ? { ok: true, config: readConfigView({ presetNames: await presetNames() }) }
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
  parseProviderNames,
  presetNames,
  exec,
  llmTestEnv,
  savedKeyFor,
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
  listSessions,
  sessionComments,
  exportSession,
  deleteSession,
  rulesCheck,
};
