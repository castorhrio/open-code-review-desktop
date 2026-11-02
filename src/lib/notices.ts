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
 * Which of two things a `run:log` line is: something this app says about itself,
 * or a line of a run's transcript.
 *
 * The prefix alone is not enough, and that is not a hypothetical. `run:log`
 * carries three kinds of line and they share one channel:
 *
 *   - the CLI's own progress lines, streamed while a review runs;
 *   - the end-of-run lines, filed under the id the CLI gave the run;
 *   - the two sentences `main.js` writes about work *it* could not do.
 *
 * The first two come from stdout-ish text this app does not compose, and a CLI
 * line that happens to begin with `[notice]` — a future upstream warning, a
 * file of that name quoted in a tool call, anything — would be lifted onto the
 * screen as a permanent notice about the app's own failure, which it is not.
 * Dismissing it would then be the only way to get the app to stop claiming
 * something it never said.
 *
 * The second condition is already in the payload: the run lines carry the run's
 * id (`run-handler.js` files every line it writes under `(line, id)`, and
 * `main.js` points that sink at `run:log`), while `main-wiring.js`'s two
 * sentences are sent as `{ line }` and nothing else — they belong to no run.
 * So a notice is a line that carries the mark **and** belongs to no run.
 */
export type LogSource = "app" | "run";

/**
 * The source of a `run:log` payload, read from the run id it carries.
 *
 * A line filed under a run is that run's transcript, whatever it says; a line
 * with no id was written by the app about itself. An id that is present but not
 * a non-empty string is treated as absent, because the id is only ever used to
 * file lines under a run — `undefined` is how "no run yet" already looks on the
 * wire, and treating it as a run would make the same line change class the
 * moment the CLI answered.
 */
export function logSource(payload: { id?: unknown } | null | undefined): LogSource {
  const id = payload?.id;
  return typeof id === "string" && id ? "run" : "app";
}

/**
 * The sentence a marked line carries, or `null` for anything that must stay in
 * the drawer.
 *
 * Both halves of the rule are required arguments-shaped on purpose: the caller
 * has to say where the line came from (`logSource`), so "the prefix is enough"
 * is not something a future call site can drift back into without a type error.
 *
 * A bare marker answers with the line itself: a marker with nothing after it is
 * a bug in the sender, and the honest rendering of a bug is the line as it
 * arrived, not a silent drop. The marker is never stripped from the drawer's
 * copy — the drawer shows every line verbatim, which is what makes it the place
 * to look after a notice has been dismissed.
 */
export function noticeText(line: string, source: LogSource): string | null {
  if (source !== "app") return null;
  const text = String(line ?? "").trim();
  if (!text.startsWith(NOTICE_MARK)) return null;
  return text.slice(NOTICE_MARK.length).trim() || text;
}
