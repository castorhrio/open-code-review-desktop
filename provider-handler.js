// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * The `app:providers` answer: the built-in service list the settings page picks
 * from, and the sentence it shows when that list could not be read.
 *
 * The body used to live in `main.js` as three lines:
 *
 *   const table = await ocr.providerTable();
 *   if (!table.ok) return { ok: false, error: ocr.withHint(table.error), value: [] };
 *   return { ok: true, value: table.rows };
 *
 * Three lines, but two decisions, and both are user-visible:
 *
 *  1. **`value` is an array in every answer, including the failing one.** The
 *     renderer consumes it as a list (`providers.some(...)`,
 *     `providers.filter(...)`) without asking `ok` first, so a failure that
 *     answered `undefined` would be a crash on the settings page rather than the
 *     banner the failure is supposed to draw.
 *  2. **The error carries its hint.** `ocr llm providers` failing is usually not
 *     a sentence the user can act on; `withHint` appends the one line written for
 *     exactly that failure. Dropping it turns a fixable install into "something
 *     went wrong", and nothing in the handler's shape would make the loss
 *     visible — the page still renders an `error` string.
 *
 * `withHint` is injected rather than required from `ocr-service.js` so this
 * module stays a pure translation of a table into a payload, and so
 * `tools/provider-handler-smoke.mjs` can drive every branch (and the real hint
 * table, by handing in the real function) without spawning a CLI.
 *
 * The shapes it accepts are the ones `providerTable()` actually returns:
 * `{ ok: true, rows, matched, error: "" }` and
 * `{ ok: false, rows: [], matched: 0, error }`. A missing table, or a
 * `rows` that is not a list, is answered as a failure rather than as "this
 * install has no built-in services": the settings page reads an empty list as
 * "every name on screen is custom", so hollow data must not be able to arrive
 * dressed as a successful read.
 */

// The answer when there is no usable table. `providerTable()` always returns an
// object with a list, so this is a caller mistake (`undefined` from a future
// refactor) or a parser that stopped returning rows, not a state the CLI
// produces — and it must not read as "no built-in service exists".
const PROVIDERS_UNREAD = "还没有读取过内置服务名单";

const errorTextOf = (table) => {
  const said = String((table && table.error) || "").trim();
  return said || PROVIDERS_UNREAD;
};

/**
 * @param {object|null|undefined} table what `ocr.providerTable()` answered
 * @param {{ withHint?: (text: string) => string }} [options]
 *   `withHint` is `ocr.withHint` in production: one `→` line appended under the
 *   CLI's own words. The default passes the text through unchanged, which is
 *   what a caller with no hint table (a smoke test asserting the shape only)
 *   wants, and what keeps this module free of the service's dependencies.
 * @returns {{ ok: true, value: object[] } | { ok: false, error: string, value: object[] }}
 */
function providersAnswer(table, { withHint = (text) => text } = {}) {
  const rows = table && Array.isArray(table.rows) ? table.rows : null;
  if (!table || table.ok !== true || !rows) {
    return { ok: false, error: withHint(errorTextOf(table)), value: [] };
  }
  return { ok: true, value: rows };
}

module.exports = { providersAnswer, PROVIDERS_UNREAD };
