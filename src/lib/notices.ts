/**
 * The one marker that turns a run-log line into a notice.
 *
 * The main process says two things that are not progress: that the bounded
 * event queue dropped lines before the window was ready (`main-wiring.js`
 * `reportSenderLoss`), and that the version probe threw (`reportProbeError`).
 * Both were only ever handed to `run:log`, which meant they existed in a drawer
 * that is collapsed by default and that nobody opens unless something looks
 * wrong — so the app telling the user about its own failure depended on the
 * user going to look for it.
 *
 * The channel, the payload (`{ line }`) and the drawer are unchanged: the line
 * is still written where it was always written. What was added is a marker the
 * renderer recognises, so the same sentence is *also* put on screen as a
 * notice the reader can close. The marker lives in the text and not in the
 * payload on purpose — `window-sender.js`'s contract stays `{ line }`, and a
 * second key would be a second thing for every sender test to learn.
 *
 * `tools/ui-audit/fixtures.mjs` builds its notice lines by *calling* the two
 * reports, so the producer's marker and the parser below cannot drift apart
 * without a shot going red: a bar that never appears is a failed assertion, not
 * a screenshot nobody compares.
 */
export const NOTICE_MARK = "[notice]";

/**
 * The sentence a marked line carries, or `null` for an ordinary log line.
 *
 * A bare marker answers with the line itself: a marker with nothing after it is
 * a bug in the sender, and the honest rendering of a bug is the line as it
 * arrived, not a silent drop. The marker is never stripped from the drawer's
 * copy — the drawer shows every line verbatim, which is what makes it the place
 * to look after a notice has been dismissed.
 */
export function noticeText(line: string): string | null {
  const text = String(line ?? "").trim();
  if (!text.startsWith(NOTICE_MARK)) return null;
  return text.slice(NOTICE_MARK.length).trim() || text;
}
