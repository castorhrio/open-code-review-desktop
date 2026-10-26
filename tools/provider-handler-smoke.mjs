// Pins the `app:providers` payload, which the settings page reads as a list and
// a banner.
//
// The handler body used to be three lines in `main.js`:
//
//   const table = await ocr.providerTable();
//   if (!table.ok) return { ok: false, error: ocr.withHint(table.error), value: [] };
//   return { ok: true, value: table.rows };
//
// A registration cannot be called, so nothing checked either half: that the
// failing answer still carries an array in `value` (the renderer lists
// `providers` without asking `ok` first, so `undefined` there is a blank settings
// page instead of a banner), and that the error keeps the hint `withHint` appends
// (the hint is the only part of the sentence the user can act on).
//
// `provider-handler.js` now holds the translation and this suite drives it with
// plain table objects — no CLI, no process, no network. The real `ocr.withHint`
// is handed in for the hint cases, because "the hint is attached" is a claim
// about the production wiring, not about this module's default.
//
// Run with `npm run audit:providers`.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { providersAnswer, PROVIDERS_UNREAD } = require(path.join(ROOT, "provider-handler.js"));
const ocr = require(path.join(ROOT, "ocr-service.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- a table that could be read ---- */
{
  const rows = [
    { name: "DeepSeek", protocol: "openai", url: "https://api.deepseek.com" },
    { name: "Moonshot", protocol: "openai", url: "https://api.moonshot.cn" },
  ];
  const answer = providersAnswer({ ok: true, rows, matched: rows.length, error: "" });
  check(
    "a readable table answers `{ ok: true, value }` with the rows themselves",
    answer.ok === true && JSON.stringify(answer.value) === JSON.stringify(rows),
    JSON.stringify(answer)
  );
  check(
    "...and the payload has exactly those two keys",
    JSON.stringify(Object.keys(answer).sort()) === JSON.stringify(["ok", "value"]),
    JSON.stringify(Object.keys(answer).sort())
  );
  // The table is the *only* source: a handler that also invented a `matched`
  // count or copied `error: ""` into the payload would give the page a second
  // place to read the same fact from, and the two could disagree.
  check(
    "...and no extra field (no `error`, no `matched`) leaks into the answer",
    !("error" in answer) && !("matched" in answer),
    JSON.stringify(Object.keys(answer))
  );
  const empty = providersAnswer({ ok: true, rows: [], matched: 0, error: "" });
  check(
    "a successful read with no rows answers ok with an empty list",
    empty.ok === true && Array.isArray(empty.value) && empty.value.length === 0,
    JSON.stringify(empty)
  );
}

/* ---- every row must be an object, or the whole read is unreadable ----
 * `providerTable()` builds `{ name, protocol, url }` rows itself, so a null, a
 * string or an array in `rows` is not something the CLI can produce — it is a
 * parser or caller mistake. The settings page reads `p.name` off each element
 * (`providers.find`, `.some`, `.filter`), so "pass it through as-is" would be a
 * crash on the page instead of the banner. The contract is therefore "reject
 * the read", not "hand the mistake on", and one bad element is enough: a
 * filtered list would tell the page it had seen every built-in service.
 */
{
  const mixed = [null, "x", { name: "DeepSeek" }];
  const answer = providersAnswer({ ok: true, rows: mixed, matched: mixed.length, error: "" });
  check(
    "a rows list with a non-object element is a failure, not a list the renderer will crash on",
    answer.ok === false && Array.isArray(answer.value) && answer.value.length === 0,
    JSON.stringify(answer)
  );
  check(
    "...and the sentence is the unread one, not the element's text",
    answer.error === PROVIDERS_UNREAD,
    JSON.stringify(answer.error)
  );
  const arrayRow = providersAnswer({ ok: true, rows: [[]], matched: 1, error: "" });
  check(
    "an array is not a row either",
    arrayRow.ok === false && arrayRow.error === PROVIDERS_UNREAD,
    JSON.stringify(arrayRow)
  );
  check(
    "a table whose rows are all objects is still passed through whole",
    (() => {
      const rows = [{ name: "DeepSeek" }, { name: "Moonshot" }];
      const ok = providersAnswer({ ok: true, rows, matched: rows.length, error: "" });
      return ok.ok === true && ok.value === rows;
    })(),
    "the same list, not a filtered copy — nothing is dropped silently"
  );
}

/* ---- a table that could not be read ---- */
{
  const said = "ocr llm providers 的输出里没有可识别的服务行";
  const answer = providersAnswer({ ok: false, rows: [], matched: 0, error: said });
  check(
    "a failed read answers ok:false with the table's own words",
    answer.ok === false && answer.error === said,
    JSON.stringify(answer)
  );
  check(
    "...and `value` is still an array, so the renderer's list never becomes undefined",
    Array.isArray(answer.value) && answer.value.length === 0,
    JSON.stringify(answer.value)
  );
  // `providerTable()` caches the failure and can hand back rows that were read
  // before the failure (the cached-failure branch spreads the previous result).
  // Those rows belong to an older read; showing them beside the banner would put
  // a service list on screen that the sentence above it says is unavailable.
  const staleRows = providersAnswer({
    ok: false,
    rows: [{ name: "DeepSeek" }],
    matched: 1,
    error: said,
  });
  check(
    "a failure does not leak rows that were read before it",
    staleRows.ok === false && staleRows.value.length === 0,
    JSON.stringify(staleRows.value)
  );
}

/* ---- the shapes a caller mistake can produce ---- */
{
  const missing = providersAnswer(undefined);
  check(
    "no table at all answers a failure, not an empty successful list",
    missing.ok === false && missing.error === PROVIDERS_UNREAD && Array.isArray(missing.value),
    JSON.stringify(missing)
  );
  check(
    "...the same as null",
    JSON.stringify(providersAnswer(null)) === JSON.stringify(missing),
    JSON.stringify(providersAnswer(null))
  );
  const hollow = providersAnswer({ ok: true, rows: null, matched: 0, error: "" });
  check(
    "ok:true with a non-list `rows` is a failure, not an empty registry",
    hollow.ok === false && hollow.error === PROVIDERS_UNREAD && hollow.value.length === 0,
    JSON.stringify(hollow)
  );
  const blankError = providersAnswer({ ok: false, rows: [], matched: 0, error: "   " });
  check(
    "a failure that says nothing gets a sentence rather than an empty banner",
    blankError.ok === false && blankError.error === PROVIDERS_UNREAD,
    JSON.stringify(blankError)
  );
}

/* ---- the real hint table, handed in the way `main.js` hands it in ---- */
{
  // `ocr llm providers --color never` is one of the invocations whose flags the
  // desktop guesses; a CLI that dropped or renamed one fails with an `unknown
  // flag` line, which is exactly the shape `withHint` has a hint for. Asserting
  // through the real function is what says the wiring — not just this module —
  // keeps the hint.
  const noFlag = "Error: unknown flag: --color";
  const hinted = providersAnswer(
    { ok: false, rows: [], matched: 0, error: noFlag },
    { withHint: ocr.withHint }
  );
  check(
    "the error carries the hint the service appends",
    hinted.error.startsWith(noFlag) && hinted.error.includes("\n→ "),
    JSON.stringify(hinted.error)
  );
  check(
    "...and the hint is the one written for that failure, not a generic line",
    hinted.error.includes("该模式不支持这个参数"),
    JSON.stringify(hinted.error)
  );
  const plain = "ocr llm providers 的输出里没有可识别的服务行";
  const unhinted = providersAnswer(
    { ok: false, rows: [], matched: 0, error: plain },
    { withHint: ocr.withHint }
  );
  check(
    "a failure with no hint for it keeps the CLI's words unchanged",
    unhinted.error === plain,
    JSON.stringify(unhinted.error)
  );
  const invent = providersAnswer(undefined, { withHint: ocr.withHint });
  check(
    "the fallback sentence goes through the hint table too",
    invent.error.startsWith(PROVIDERS_UNREAD),
    JSON.stringify(invent.error)
  );
}

/* ---- `main.js` only registers ---- */
{
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  check(
    "the handler registration calls providersAnswer with the real withHint",
    /require\("\.\/provider-handler"\)/.test(mainSrc) &&
      /providersAnswer\(await ocr\.providerTable\(\), \{ withHint: ocr\.withHint \}\)/.test(mainSrc),
    "main.js"
  );
  check(
    "...and main.js no longer spells the translation itself",
    !/if \(!table\.ok\) return \{ ok: false, error: ocr\.withHint\(table\.error\)/.test(mainSrc) &&
      !/return \{ ok: true, value: table\.rows \}/.test(mainSrc),
    "the two decisions this suite pins must not be duplicated back into the registration"
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all provider-handler checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
