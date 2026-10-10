// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let cachedBinary = null;

function binaryPath() {
  if (cachedBinary) return cachedBinary;
  try {
    const { resolveNativeBinary } = require("@alibaba-group/open-code-review/scripts/platform");
    const resolved = resolveNativeBinary();
    if (resolved && resolved.path) {
      cachedBinary = resolved.path;
      return cachedBinary;
    }
  } catch (_) {}
  const globalRoot = process.platform === "win32" ? process.env.APPDATA : null;
  if (globalRoot) {
    const guess = path.join(
      globalRoot,
      "npm",
      "node_modules",
      "@alibaba-group",
      `ocr-win32-${process.arch === "arm64" ? "arm64" : "x64"}`,
      "bin",
      "opencodereview.exe"
    );
    if (fs.existsSync(guess)) {
      cachedBinary = guess;
      return cachedBinary;
    }
  }
  return null;
}

const CONFIG_PATH = path.join(os.homedir(), ".opencodereview", "config.json");

function maskSecret(value) {
  if (typeof value !== "string" || !value) return "";
  return value.length > 6 ? `${value.slice(0, 3)}****${value.slice(-2)}` : "****";
}

function stripEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { api_key: apiKey, auth_token: authToken, ...rest } = entry;
  return {
    ...rest,
    hasKey: Boolean(apiKey || authToken || entry.api_key_cmd || entry.auth_token_cmd),
    keyPreview: maskSecret(apiKey || authToken),
  };
}

const mapSection = (section) =>
  Object.fromEntries(Object.entries(section || {}).map(([k, v]) => [k, stripEntry(v)]));

function readConfigView() {
  let raw = {};
  let fileExists = false;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    fileExists = true;
  } catch (_) {}
  const llmRaw = raw.llm || {};
  const active = raw.provider || "";
  const entry =
    (raw.providers || {})[active] || (raw.custom_providers || {})[active] || {};
  const envSources = [
    ["OCR_LLM_URL", process.env.OCR_LLM_URL],
    ["OCR_LLM_TOKEN", process.env.OCR_LLM_TOKEN],
    ["OCR_LLM_MODEL", process.env.OCR_LLM_MODEL],
    ["ANTHROPIC_BASE_URL", process.env.ANTHROPIC_BASE_URL],
    ["ANTHROPIC_AUTH_TOKEN", process.env.ANTHROPIC_AUTH_TOKEN],
    ["ANTHROPIC_MODEL", process.env.ANTHROPIC_MODEL],
  ]
    .filter(([, value]) => value)
    .map(([name]) => name);
  const view = {
    path: CONFIG_PATH,
    fileExists,
    provider: active,
    model: raw.model || entry.model || "",
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
  };
  const hasEntryKey = Boolean(entry.hasKey || entry.url);
  view.configured = Boolean(active || llmRaw.url || llmRaw.model);
  view.ready = Boolean(
    view.envSources.length || (active && hasEntryKey) || (llmRaw.url && llmRaw.auth_token)
  );
  view.blockedReason = view.ready ? "" : active ? "已选服务，但缺少 API Key" : "未选择模型服务";
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

function exec(args, cwd) {
  return new Promise((resolve) => {
    const bin = binaryPath();
    if (!bin) {
      resolve({ code: -1, stdout: "", stderr: "", error: MISSING_BINARY });
      return;
    }
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr, error: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const MISSING_BINARY = "未找到 ocr 可执行文件，请在项目目录运行 npm install";

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
// lines would flood the log panel, so only real progress lines are surfaced.
const isPayloadFragment = (line) => /^[\s]*([[{\]},]|"[^"]*"\s*:)/.test(line);

function startRun(spec, onLine, onExit) {
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

  const emit = (chunk) => {
    const text = chunk.toString("utf8");
    stderrAll += text;
    if (!sessionId) {
      const found = text.match(SESSION_ID_RE);
      if (found) sessionId = found[1];
    }
    stderrBuf += text;
    const lines = stderrBuf.split(/\r?\n/);
    stderrBuf = lines.pop();
    // The trailing `Error:` line is reported once as the run failure, so don't
    // also stream it into the log as progress.
    lines.forEach((line) => {
      const t = line.trim();
      if (!t || /^error:/i.test(t) || isPayloadFragment(t)) return;
      onLine(id, t);
    });
  };
  child.stdout.on("data", (d) => {
    stdout += d.toString("utf8");
  });
  child.stderr.on("data", emit);
  child.on("error", (err) => {
    running.delete(id);
    onExit(id, { code: -1, error: withHint(err.message), sessionId, command: args.join(" ") });
  });
  child.on("close", (code) => {
    const tail = stderrBuf.trim();
    if (tail && !/^error:/i.test(tail) && !isPayloadFragment(tail)) onLine(id, tail);
    running.delete(id);
    if (code !== 0) {
      // A failed run may still have published partial findings on stdout, so
      // report the error and the payload separately instead of picking one.
      const parsed = parseJson(stdout);
      onExit(id, {
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
      onExit(id, { code, error: parsed.error, raw: parsed.raw, sessionId, command: args.join(" ") });
      return;
    }
    onExit(id, { code: 0, value: parsed.value, sessionId: parsed.value.session_id || sessionId, command: args.join(" ") });
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
    ? { ok: true, config: readConfigView() }
    : { ok: false, error: withHint(failureText(res)) };
}

/* ---------------- sessions ---------------- */

async function listSessions(repo, limit) {
  const args = ["session", "list", "--json", "--color", "never"];
  if (Number.isFinite(limit) && limit > 0) args.push("--limit", String(limit));
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
  exec,
  preview,
  startRun,
  cancelRun,
  setConfig,
  unsetConfig,
  withHint,
  failureText,
  listSessions,
  sessionComments,
  exportSession,
  deleteSession,
  rulesCheck,
};
