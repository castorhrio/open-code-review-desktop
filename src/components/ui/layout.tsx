import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Layout & design spec — the only sanctioned way to lay out a screen.
 *
 * WHY THIS FILE EXISTS
 * The UI had drifted: three panels used three different content widths, five
 * different "card" recipes, ad-hoc margins (mb-4 / mt-4 / mt-3 / mb-2.5) and
 * ten font sizes between 10 and 14px. Each individual change was reasonable;
 * the aggregate was not, because nothing owned the decisions. This module owns
 * them. If you are adding a page, compose it from these parts instead of
 * re-deriving padding, widths and heading styles.
 *
 * THE RULES
 * 1. Measure. Every scrolling page centres one measure: `--page-max` (1080px).
 *    Never let a form or a list run edge to edge — at 1920px that turns a
 *    label/value pair into two elements 900px apart. The single exception is a
 *    master-detail view (Results), which legitimately fills the window; it may
 *    use `PageBody` only for its empty / running states.
 * 2. Rhythm. Only the documented 4px-step scale (4 / 8 / 12 / 16 / 24). Section
 *    gaps are `mb-6`, card padding is `p-4`, field gaps are `gap-x-4 gap-y-4`,
 *    button rows are `gap-2`, label↔control is `gap-1.5`.
 * 3. Surfaces. One card recipe (`Card`) with one header row. Do not hand-roll
 *    `rounded-md border border-line bg-surface` again.
 * 4. Type. Four steps, from the ramp in `styles.css`: `text-meta` (11px),
 *    `text-body` (12px), `text-strong` (13px), `text-stat` (20px). Section
 *    titles are `text-strong font-semibold text-ink`; hints are
 *    `text-meta text-faint`; metadata rows are `text-meta`.
 * 5. Responsiveness. Form grids respond to their own container
 *    (`FieldGrid`), not to viewport breakpoints, so the layout behaves the same
 *    whether the window is narrow or the sidebar is wide.
 * 6. Scroll affordance. A scroll region that ends flush against a fixed band
 *    uses `ScrollArea`, not a bare `overflow-y-auto`: a clipped half-row with
 *    nothing to explain it is indistinguishable from a broken render.
 */

/** A whole scrolling page: the scroller plus the centred measure. */
export function Page({
  children,
  narrow,
  className,
}: {
  children: React.ReactNode;
  narrow?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("h-full overflow-y-auto", className)}>
      <PageBody narrow={narrow}>{children}</PageBody>
    </div>
  );
}

/**
 * Just the centred measure, for callers that own their own scroller (the
 * master-detail grid in Results, a panel with a sticky toolbar above it).
 *
 * The body is a `gap-6` stack, so children never carry their own vertical
 * margins — that is how the old `mb-4` / `mt-4` / `mt-3` / `mb-2.5` mixture
 * accumulated in the first place.
 */
export function PageBody({
  children,
  narrow,
  className,
}: {
  children: React.ReactNode;
  narrow?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("mx-auto flex w-full flex-col gap-6 px-6 py-5", className)}
      style={{ maxWidth: narrow ? "var(--page-max-narrow)" : "var(--page-max)" }}
    >
      {children}
    </div>
  );
}

/**
 * Just the centred measure, for a band that keeps its full-bleed background but
 * whose *content* still belongs on the page column.
 *
 * The review page's file list and its pinned action bar are the case: the
 * background has to reach the window edges for them to read as bands, but the
 * rows and the run button must line up with the form above them. They did not,
 * and at 1920px the page had three left edges — the form at 152px, the rows at
 * 32px — so a row's diff stat landed ~1770px from the filename it describes,
 * which is the exact failure rule 1 of this file forbids. At 1440px the same
 * mistake is a 90px offset that reads as a margin, which is why every shot
 * before the 1920 one missed it.
 */
export function Measure({
  children,
  narrow,
  className,
}: {
  children: React.ReactNode;
  narrow?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("mx-auto w-full", className)}
      style={{ maxWidth: narrow ? "var(--page-max-narrow)" : "var(--page-max)" }}
    >
      {children}
    </div>
  );
}

/**
 * A scroll region that admits it scrolls.
 *
 * WHY THIS EXISTS
 * The file region ends flush against the pinned action bar. When the list is
 * taller than the region — always, at the 1000x660 floor — the bottom row is
 * sliced horizontally through its middle. The region does have a scrollbar, and
 * a visible one: the app styles `::-webkit-scrollbar`, which makes Chromium
 * reserve 9px for it (measured in the shipped Electron build; the headless
 * audit forces overlay scrollbars, so it cannot answer this). So a reader *can*
 * tell the region scrolls — but a row cut through its glyphs still reads as
 * damage rather than as a deliberate boundary, and the half-line is exactly the
 * one the reader was about to read. The region therefore fades its content into
 * the surface at whichever edge still has content beyond it, and shows nothing
 * at an edge you have reached. That restraint is the point: the fade never
 * claims there is more to read when there is not.
 *
 * The measurement runs after every render (a content change always comes with
 * one), on scroll, and on a ResizeObserver — a window resize does not re-render
 * this component, and it is exactly when the region gets shorter that the fade
 * has to appear.
 *
 * The overlay is `pointer-events-none` and `aria-hidden`: it is decoration over
 * content that stays selectable, and it must not eat a click on the last row.
 */
export function ScrollArea({
  children,
  className,
  bodyClassName,
  tone = "surface",
  grow = true,
}: {
  children: React.ReactNode;
  /** Sizing for the wrapper (the flex/grid item), not for the scroller. */
  className?: string;
  /** Padding and the like, which belong *inside* the scroller so they scroll. */
  bodyClassName?: string;
  tone?: "surface" | "canvas" | "raised";
  /** `flex-1` by default; pass `false` for a region with its own cap (max-h). */
  grow?: boolean;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ top: false, bottom: false });

  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  });

  const from = `var(--${tone})`;
  return (
    <div className={cn("relative flex min-h-0 flex-col", grow ? "flex-1" : "shrink-0", className)}>
      <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>
        {children}
      </div>
      {edges.top && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-6"
          style={{ background: `linear-gradient(to bottom, ${from}, transparent)` }}
        />
      )}
      {edges.bottom && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
          style={{ background: `linear-gradient(to top, ${from}, transparent)` }}
        />
      )}
    </div>
  );
}

/** A titled group of content. Rhythm comes from the parent stack, not from here. */
export function Section({
  title,
  hint,
  icon,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center gap-2">
          {icon}
          {title && <h2 className="text-strong font-semibold text-ink">{title}</h2>}
          {hint && <span className="text-meta text-faint">{hint}</span>}
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

const CARD_TONES = {
  default: { box: "border-line bg-surface", head: "border-line" },
  accent: { box: "border-accent/25 bg-accent-soft/40", head: "border-accent/15" },
  warn: { box: "border-warn/35 bg-warn/5", head: "border-warn/25" },
} as const;

/**
 * The one surface recipe. A header row (optional) plus a padded body.
 * `padded={false}` is for cards whose body is a table or a list that draws its
 * own row padding.
 */
export function Card({
  title,
  hint,
  icon,
  actions,
  tone = "default",
  padded = true,
  children,
  className,
  bodyClassName,
  headerClassName,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: keyof typeof CARD_TONES;
  padded?: boolean;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  headerClassName?: string;
}) {
  const t = CARD_TONES[tone];
  return (
    <section className={cn("overflow-hidden rounded-md border", t.box, className)}>
      {(title || actions) && (
        <div className={cn("flex items-center gap-2 border-b px-4 py-2.5", t.head, headerClassName)}>
          {icon}
          {/* A card title is often fed by something with no length bound — a
              file path, a model id. A flex child defaults to `min-width: auto`,
              which refuses to shrink below its min-content width, so an
              unbreakable title pushes the whole header past the card and the
              card clips it. Both need `min-w-0` before `truncate` can do
              anything; the full value belongs in a `title`. */}
          {title && <h3 className="min-w-0 truncate text-strong font-semibold text-ink">{title}</h3>}
          {hint && <span className="min-w-0 truncate text-meta text-faint">{hint}</span>}
          {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cn(padded && "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Form field grid. Two columns when the measure allows, one when it does not.
 * Wide children use `col-span-full` — never `col-span-2`, which would create an
 * implicit track and overflow once the grid collapses to a single column.
 *
 * `auto-fill`, not `auto-fit`. They are identical for two or more children, and
 * differ for exactly one: `auto-fit` collapses the empty track and stretches the
 * lone child across the whole measure, so 单个提交's single commit field ran
 * 1032px of a 1080px measure while 分支对比's two refs each took a column — and
 * the tick that confirms the resolved SHA landed ~700px from the hash it
 * confirms. That is rule 1 of this file, and it also contradicted the sentence
 * above: one lone field is not "two columns when the measure allows".
 */
export function FieldGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(var(--field-min),1fr))] gap-x-4 gap-y-4", className)}>
      {children}
    </div>
  );
}

/** A full-bleed toolbar strip, for master-detail panels that keep the window width. */
export function PanelHeader({
  children,
  tone = "surface",
  className,
}: {
  children: React.ReactNode;
  tone?: "surface" | "canvas";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2",
        tone === "surface" ? "bg-surface" : "bg-canvas",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Centered empty / loading / error state. Keeps its own prose at a readable measure. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-3 px-6 text-center", className)}>
      {icon}
      <div className="max-w-[var(--page-max-narrow)] space-y-1.5">
        {title && <p className="text-strong text-muted">{title}</p>}
        {description}
      </div>
      {action}
    </div>
  );
}
