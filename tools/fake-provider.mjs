// A local provider that answers the review protocol the pinned CLI really speaks.
//
// Why this exists: every runtime-level claim in this repository was, until now,
// proven against the discard port `http://127.0.0.1:9/v1` — a provider that
// refuses every connection. That is enough to prove the *refusals* (`audit:e2e-first-run`
// judges "no run left the process", "the gate stayed shut"), and it is what makes
// the run-level scopes untested: with nothing listening, every file fails, so a
// run can never complete and never publish a finding. `单个提交` and `全量扫描`
// were therefore only covered at `--preview` level (`tools/e2e-flow.cjs`), and the
// truncation sentence in `ResultsPanel.tsx` had only fixture evidence.
//
// What it is: an OpenAI-compatible `POST …/chat/completions` endpoint that speaks
// the tools the CLI's own templates declare. Nothing is invented about the
// protocol: the request shapes below are what `ocr v1.13.5` (abb7abc) sends,
// captured from real runs, and `tools/fake-provider-smoke.mjs` runs the pinned
// CLI against this file and pins each reply to what that run asked for.
//
// Three phases, told apart by the tool set the request declares — not by the
// wording of the prompt, which is upstream's to change:
//
//   * **plan** (`tools` absent / empty) — the per-file PLAN_TASK pre-pass.
//     Answered with `task_done` so the task closes at once; a plan that produced
//     findings would be a second, invented source of them.
//   * **review** (`code_comment` declared) — files one canned finding per review
//     file, anchored on that file's own first added line (where the CLI's
//     sliding-window locator will mount it), then closes the task.
//   * **filter** (`approve_all_comments` declared) — the post-run pass that may
//     delete comments the diff proves wrong. Answered with `approve_all_comments`,
//     which upstream documents as "the expected outcome for most files". Without
//     this branch the CLI cannot parse the reply, retries the whole review, and
//     the same finding is published twice — that is how this branch was found.
//
// Two prompt shapes, because the two run modes ask differently:
//
//   * diff review (`ocr review`) — `<review_files>` with one `<file path="…">`
//     per member of the group.
//   * full-file scan (`ocr scan`) — `<current_file_path>` plus
//     `<current_file_content>`, no diff at all.
//
// And one behaviour that is not a phase but is part of the protocol: `ocr review`
// runs **two** review passes per group. The second one carries
// `### Previously Confirmed Findings` / `<confirmed_findings>` and says, in
// upstream's own words, "Do not repeat them". A test double that ignores that
// block reports every finding twice — not a parse error, just a run whose
// `summary.comments` says 2 where a human reading the diff would say 1. So the
// review branch skips files this block already names; the block is parsed, not
// pattern-matched out of the prompt wording.
//
// What it is NOT: a model. The finding text is a fixed marker, so a screen that
// shows it is showing something that could only have come from this provider.
// The endpoint is bound to loopback, and it is started by the harness that uses
// it, so no packet leaves the machine and no token is spent.
//
// The three things a caller can ask for, because three different claims need
// them:
//   * `findingsPerFile` — how many `code_comment`s a task files. The default (1)
//     is enough to prove "a completed run renders a finding".
//   * `usage` — the token usage reported back. Small values keep a run inside any
//     budget; a large value is how a *truncated* run is produced honestly, by
//     making the CLI's own budget arithmetic (not a mock of it) go over.
//   * `refuse` — answer 500 instead of a completion, for the "provider down"
//     shape, which is a different ending from "the run was cut short".
"use strict";

import http from "node:http";

/** What a canned finding says. Fixed on purpose: a screen showing this text is
 * showing something only this provider could have produced. */
export const FINDING_CONTENT = "FAKE-PROVIDER: this added line needs a second look";
export const FINDING_CATEGORY = "bug";
export const FINDING_SEVERITY = "medium";

/** The default token usage reported back. Small on purpose: a run that reports
 * 160 tokens per request stays inside any budget a harness sets. */
export const DEFAULT_USAGE = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };

/** The tool each phase is recognised by. Upstream's templates declare these; a
 * request that declares none of them is the plan pre-pass. */
export const PHASE_TOOLS = {
  review: "code_comment",
  filter: "approve_all_comments",
};

/** Which phase a request belongs to, from the tool set it declares.
 *
 * `plan` is "no tools at all" rather than a name, because the plan template
 * declares none — so a future upstream tool added to the review template cannot
 * silently reclassify the plan phase. `unknown` is a real answer: a request that
 * declares tools but none of the two above is a phase this provider does not
 * speak, and answering it with a review reply would invent findings. */
export function phaseOf(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools : [];
  const names = tools.map((t) => (t && t.function && t.function.name) || "").filter(Boolean);
  if (names.length === 0) return "plan";
  if (names.includes(PHASE_TOOLS.filter)) return "filter";
  if (names.includes(PHASE_TOOLS.review)) return "review";
  return "unknown";
}

/**
 * The review task(s) inside one request: file path plus the lines a finding may
 * be anchored on.
 *
 * Diff shape: the CLI puts each group under `<review_files>` with one
 * `<file path="…">` per member. Added lines keep their `+` stripped, which is
 * the form `existing_code` has to be in ("Only return newly added code lines,
 * should not include deleted code"); `+++ b/x.go` is the diff header, not an
 * added line, so it is dropped.
 *
 * Scan shape: `<current_file_path>` names the file and `<current_file_content>`
 * holds it whole, so every non-blank line is a line a finding may sit on.
 */
export function reviewFilesOf(bodyText) {
  const text = String(bodyText || "");
  const files = [];

  const block = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
  let m;
  while ((m = block.exec(text))) {
    const added = m[2]
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .filter((line) => line.trim() !== "");
    files.push({ path: m[1], addedLines: added });
  }
  if (files.length) return files;

  const scanPath = /<current_file_path>([\s\S]*?)<\/current_file_path>/.exec(text);
  const scanBody = /<current_file_content>([\s\S]*?)<\/current_file_content>/.exec(text);
  if (scanPath) {
    const lines = (scanBody ? scanBody[1] : "")
      .split("\n")
      .filter((line) => line.trim() !== "");
    files.push({ path: scanPath[1].trim(), addedLines: lines });
  }
  return files;
}

/**
 * The files a second review pass already has findings on.
 *
 * Upstream's second pass lists them under `<confirmed_findings>` as
 * `N. <path>` followed by indented `code:` / `issue:` lines. Only the numbered
 * line carries the path; the indented lines are the finding's own body and may
 * contain anything, so they are not parsed. No block means "first pass".
 */
export function confirmedFilesOf(bodyText) {
  const block = /<confirmed_findings>([\s\S]*?)<\/confirmed_findings>/.exec(String(bodyText || ""));
  if (!block) return [];
  return block[1]
    .split("\n")
    .map((line) => /^\s*\d+\.\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** The files this pass may still report: the ones not already confirmed. */
export function newlyReviewable(files, confirmed) {
  const seen = new Set(confirmed);
  return files.filter((file) => !seen.has(file.path));
}

/** How many tool calls this conversation has already been through. A review task
 * is one conversation, so "none yet" means the finding has not been filed and
 * "some" means it has. Stateless on purpose: the CLI runs groups concurrently, so
 * a reply that depended on call order would be wrong under concurrency. */
export function roundsSoFar(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (m) => m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  ).length;
}

const toolCall = (name, args) => ({
  id: `call_${name}_${Math.random().toString(36).slice(2, 10)}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/**
 * The reply to one request, as a pure function of what was asked.
 *
 * Review shape: the first round files the findings, every later round closes the
 * task. A review round with nothing left to report (every file already in
 * `<confirmed_findings>`) closes the task too — that is what stops the second
 * pass from publishing the first pass's findings a second time. Filter shape:
 * approve everything, in one round. Plan shape: close at once. `unknown` throws
 * rather than guessing — a harness pointed at a phase this provider does not
 * speak should fail loudly, not publish invented findings.
 */
export function reviewReply(bodyText, { findingsPerFile = 1, usage } = {}) {
  const body = typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const phase = phaseOf(body);
  const round = roundsSoFar(messages);

  let calls;
  if (phase === "filter") {
    calls = [toolCall(PHASE_TOOLS.filter, {})];
  } else if (phase === "review") {
    const task = lastUserText(messages);
    const files = round === 0 ? newlyReviewable(reviewFilesOf(task), confirmedFilesOf(task)) : [];
    calls =
      files.length > 0
        ? [toolCall(PHASE_TOOLS.review, { comments: commentsFor(files, findingsPerFile) })]
        : [toolCall("task_done", { state: "DONE" })];
  } else if (phase === "plan") {
    calls = [toolCall("task_done", { state: "DONE" })];
  } else {
    throw new Error(`fake provider does not speak this phase (tools: ${toolNames(body).join(", ") || "none"})`);
  }

  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1,
    model: body.model || "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }],
    usage: usage || DEFAULT_USAGE,
  };
}

function toolNames(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools : [];
  return tools.map((t) => (t && t.function && t.function.name) || "").filter(Boolean);
}

/** One comment per file, `count` per file when asked, anchored on that file's own
 * first added line so the CLI's locator has something real to match. */
export function commentsFor(files, count = 1) {
  const comments = [];
  for (const file of files) {
    const lines = file.addedLines.length ? file.addedLines : ["package main"];
    for (let i = 0; i < count; i += 1) {
      comments.push({
        path: file.path,
        existing_code: lines[i % lines.length],
        content: count === 1 ? FINDING_CONTENT : `${FINDING_CONTENT} (#${i + 1})`,
        category: FINDING_CATEGORY,
        severity: FINDING_SEVERITY,
      });
    }
  }
  return comments;
}

/** The last user turn: the review task itself. Earlier turns are tool results. */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === "user") return String(messages[i].content || "");
  }
  return "";
}

const openAiEnvelope = (reply) => JSON.stringify(reply);

/**
 * Start the provider on a free loopback port.
 *
 * `port: 0` lets the OS pick, so two harnesses can run at once; the resolved
 * `url` is what the caller writes into the CLI's config. `requests` keeps every
 * body it was sent, so a harness can assert what the CLI actually asked for
 * rather than trusting that a reply implies a request.
 */
export async function startFakeProvider({ port = 0, findingsPerFile = 1, usage, refuse = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, method: req.method, body });
      if (refuse) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake provider is down" } }));
        return;
      }
      let reply;
      try {
        reply = openAiEnvelope(reviewReply(body, { findingsPerFile, usage }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String((err && err.message) || err) } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reply);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const { port: bound } = server.address();
  return {
    url: `http://127.0.0.1:${bound}/v1`,
    port: bound,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// Standalone, for looking at a run by hand:
//   node tools/fake-provider.mjs            → starts on :18099 and prints the URL
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 18099);
  startFakeProvider({ port }).then((p) => {
    console.log(`fake provider listening on ${p.url}`);
    console.log(`point a CLI entry at it:  ocr config set custom_providers.fake.url ${p.url}`);
  });
}
