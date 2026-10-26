// Says whether upstream's default branch still sits on the commit the sync doc
// was written against.
//
// The sync doc (`docs/OCR-UPSTREAM-SYNC.md`) records which upstream source rows
// have been re-read by hand, and that record is only meaningful while upstream
// stays on the same commit. Until now "check the HEAD" lived in prose, so a
// round could skip it and look identical to a round that checked and found
// nothing. This script turns that one fact into a sentence every run prints.
//
// It only *reports*. A moved HEAD is not an error — the doc's rows still need a
// human to re-read them — and an unreachable GitHub is not an error either: it
// prints "skipped" and exits 0, so no audit or release step is ever blocked by
// the network. Which also means a green `upstream:check` is *not* a safety net:
// the net is `audit:service` / `audit:config` / `audit:git` plus the four rows
// a human re-reads. The pure functions are exported so
// `tools/upstream-watch-smoke.mjs` can assert the three answers without network.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const UPSTREAM_URL = "https://github.com/alibaba/open-code-review.git";
export const UPSTREAM_REF = "refs/heads/main";

// A commit is 40 hex characters, and so is this pin — deliberately *not* the
// readable 7-character prefix the prose below uses.
//
// The reason is the only failure mode this comparison has: a short pin makes
// "same commit" and "same first seven characters" the same answer. Upstream
// moving from `375f64cd6f67…` to `375f64cf…` would then be reported as "与对照表
// 一致，无需重读" — the one direction this sentence must never be wrong in, since
// every row of the table would silently be stale. With the whole 40 characters
// pinned, that case is `moved`: over-reporting drift costs a re-read, under-
// reporting it costs correctness.
//
// The value is upstream `refs/heads/main` as of `v1.13.3`; `docs/OCR-UPSTREAM-SYNC.md`
// carries the same 40 characters on its fixed "本轮 HEAD 核对" line and the smoke
// test keeps the two exactly equal.
export const PINNED_UPSTREAM = Object.freeze({
  sha: "375f64cd6f67a48a135da83cfcf59c52669a09cb",
  tag: "v1.13.3",
});

// Exactly the rows the sync doc's table wants re-read when upstream moves. Kept
// here rather than in the doc so the warning and the table cannot drift apart:
// `tools/upstream-watch-smoke.mjs` checks that each label still appears in the
// table.
export const ROWS_TO_REREAD = Object.freeze([
  "provider 解析顺序 —— internal/llm/resolver.go（同步改 UPSTREAM_RESOLVER 与 MATCH_RULES）",
  "`config set` 的 key 语法 —— cmd/opencodereview/config_cmd.go",
  "内置服务表（列 / 表头 / 失败 stderr）—— `ocr llm providers`",
  "运行期失败分类 —— failure_class 两张表",
]);

const FULL_SHA = /^[0-9a-f]{40}$/i;

// Reads the SHA for `UPSTREAM_REF` out of `git ls-remote` output. A malformed
// line is ignored rather than trusted: a bad answer here would be reported as a
// moved HEAD (or worse, as "pinned"), and the whole point is that this sentence
// is trustworthy without a human re-checking it.
export const parseLsRemote = (stdout, ref = UPSTREAM_REF) => {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && FULL_SHA.test(sha || "")) return sha;
  }
  return null;
};

// The three answers: `pinned` (same as the doc), `moved` (re-read the rows),
// `skipped` (no answer this run — explicitly *not* "unchanged").
//
// A short `pinned` (or a short SHA from the runner) is refused as `skipped`
// rather than prefix-matched. Prefix matching would answer "pinned" for a
// different commit that happens to share the recorded prefix, and a wrong
// "pinned" is invisible: nobody re-reads a row that says nothing changed.
// `skipped` at least says the round did not really check.
export const upstreamDrift = ({ ok, sha, pinned = PINNED_UPSTREAM.sha, failure = "" }) => {
  if (!ok) return { state: "skipped", reason: failure || "git ls-remote 不可达" };
  if (!sha) return { state: "skipped", reason: "ls-remote 输出里没有 refs/heads/main" };
  if (!FULL_SHA.test(String(pinned))) {
    return {
      state: "skipped",
      reason: `pin 不是完整 40 位 SHA（${pinned}）：短于 40 位只能判「前几位相同」，不能判「同一个 commit」`,
      pinned,
    };
  }
  if (!FULL_SHA.test(String(sha))) {
    return { state: "skipped", reason: `ls-remote 的 SHA 不是完整 40 位（${sha}）`, sha, pinned };
  }
  return {
    state: String(sha).toLowerCase() === String(pinned).toLowerCase() ? "pinned" : "moved",
    sha,
    pinned,
  };
};

export const formatDrift = (verdict) => {
  if (verdict.state === "skipped") {
    return `上游 HEAD 核对：跳过（${verdict.reason}；本轮未核对，不等于上游没变）`;
  }
  if (verdict.state === "pinned") {
    return `上游 HEAD 核对：${verdict.pinned}（与对照表一致，无需重读）`;
  }
  // When the two commits share the readable 7-character prefix, the arrow alone
  // would print `375f64c → 375f64c` — technically "moved" but read as a typo. Say
  // out loud that the difference is further in, and keep the whole SHA on the
  // next line so the reader can compare character by character.
  const from = verdict.pinned.slice(0, 7);
  const to = verdict.sha.slice(0, 7);
  const arrow = from === to ? `${from} → ${to}（前 7 位相同，区别在后面）` : `${from} → ${to}`;
  return [
    `!! 上游 HEAD 已前进：${arrow}`,
    `   新 HEAD 全 40 位：${verdict.sha}`,
    "   这不是失败，但 docs/OCR-UPSTREAM-SYNC.md 下面四行需要重读源码，而不是只看 SHA：",
    ...ROWS_TO_REREAD.map((row) => `   - ${row}`),
  ].join("\n");
};

const defaultRunner = () =>
  spawnSync("git", ["ls-remote", UPSTREAM_URL, UPSTREAM_REF], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });

// `code` is always 0: a moved HEAD and an unreachable network are both answers,
// not failures, and this command must stay safe to call from any script.
export const runUpstreamWatch = (run = defaultRunner) => {
  let result;
  try {
    result = run();
  } catch (error) {
    return { verdict: upstreamDrift({ ok: false, failure: error && error.message }), code: 0 };
  }
  const ok = Boolean(result) && !result.error && result.status === 0;
  const failure = result && result.error ? result.error.message : "git ls-remote 退出码非 0";
  const verdict = upstreamDrift({ ok, sha: ok ? parseLsRemote(result.stdout) : null, failure });
  return { verdict, text: formatDrift(verdict), code: 0 };
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  const { text, code } = runUpstreamWatch();
  console.log(text);
  process.exitCode = code;
}
