import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * For every `text-*` class, tailwind-merge has to decide whether it sets a font
 * size or a colour, and it decides from the value. This project's type ramp
 * (`text-meta` / `text-body` / `text-strong` / `text-stat`, see `styles.css`)
 * and its colour tokens (`text-ink` / `text-muted` / `text-accent-ink`, …) are
 * both names it does not recognise, so it filed them under the same group and
 * silently dropped all but the last one.
 *
 * That is not a cosmetic detail. In `Button`, `size` is emitted after `variant`,
 * so `size="sm"`'s `text-body` erased the variant's colour on *every* small
 * button in the app:
 *
 *   primary size="sm"  ->  no colour of its own; it inherited the container's
 *
 * On the update banner that put `--ink` on `--accent-solid` — 3.2:1 in light and
 * 3.9:1 in dark, both under AA — and it flattened the `ghost` variant into
 * looking like a default button, which is the hierarchy the toolbar sizes exist
 * to express. Teaching the merger the ramp fixes every component at once,
 * instead of the one button where it happened to be noticed.
 *
 * If a size is ever added to the ramp in `styles.css`, add it here too; an
 * unknown name falls back to the heuristic that caused this.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["meta", "body", "strong", "stat"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
