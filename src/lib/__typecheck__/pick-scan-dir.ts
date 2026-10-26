// Compile-time pins for `PickScanDirAnswer`, checked by `npm run typecheck`.
//
// The union's third arm is `{}` — the dialog was cancelled. The failure it
// guards is silent rather than loud: a reader that forgets that arm sees
// `relPath` as a string, so "cancelled" is read as a path, and an empty path
// means 留空 = the whole repo. `?: never` on the other arms is what makes that
// omission a compile error; the `@ts-expect-error` lines below keep the `never`
// from being relaxed back to a plain `?` without anyone noticing.
import type { PickScanDirAnswer } from "../api";

// The reading order ReviewPanel uses: refusal first, then the one shape that
// carries a path, then the empty object as "the user changed their mind".
export const readAnswer = (answer: PickScanDirAnswer): string => {
  if (answer.error) return `refused: ${answer.error}`;
  if (answer.relPath !== undefined) return `path: ${answer.relPath}`;
  return "cancelled";
};

// A reader that skips the empty-object arm cannot treat the `undefined` it gets
// there as a path.
// @ts-expect-error — `relPath` is absent on the cancelled and refusal arms
export const relPathUnchecked = (answer: PickScanDirAnswer): string => answer.relPath;

// The three shapes are disjoint: a refusal carrying a path would make "outside
// the repo" readable as 留空, which is the widening this type exists to prevent.
// @ts-expect-error — a refusal must not carry `relPath`
export const refusalWithPath = (): PickScanDirAnswer => ({ relPath: "src", error: "所选目录不在该仓库内" });

// A path is a string; `null` is not "no path" — absence is.
// @ts-expect-error — `relPath` is never null
export const nullPath = (): PickScanDirAnswer => ({ relPath: null });

// The three legal shapes, so a union that rejects one of them fails here too.
export const cancelledAnswer: PickScanDirAnswer = {};
export const wholeRepoAnswer: PickScanDirAnswer = { relPath: "" };
export const refusedAnswer: PickScanDirAnswer = { error: "所选目录不在该仓库内" };
