import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * Four sizes, and each one has exactly one job:
 *   sm   h-7  dense chrome only — panel toolbars, card headers, table rows
 *   md   h-8  default, and anything sitting inline with an h-8 input
 *   lg   h-9  the page's action row (the one or two buttons that move work forward)
 *   icon h-8  square, icon-only
 * Do not patch a size with `className="h-8"`; pick the size that already fits.
 *
 * The icon size belongs to the size step too, and for the same reason. It used
 * to be a blanket `[&_svg]:size-3.5` on the base class, which is specificity
 * (0,1,1) — a class plus the `svg` type — so it beat every explicit `size-4`
 * (0,1,0) at the call sites. The source said 16px on the action row and every
 * other button and the screen drew 14px, on all seven `lg` buttons and both the
 * settings `md` ones. Nothing could show it: 14px is entirely plausible, which
 * is why `tools/ui-audit` now measures it. Sizes: 14px for dense chrome, 16px
 * for the action row — the step is the hierarchy.
 */
const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border text-strong font-medium " +
    "transition-[background-color,border-color,color,transform] duration-150 ease-out " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
    "disabled:pointer-events-none disabled:opacity-45 active:translate-y-[0.5px] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-line bg-raised text-ink hover:bg-hover hover:border-line-strong",
        primary: "border-transparent bg-accent-solid text-accent-ink hover:brightness-110",
        ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink",
        outline: "border-line bg-transparent text-ink hover:bg-hover",
        danger: "border-bad/35 bg-bad/10 text-bad hover:bg-bad/20",
        link: "border-transparent bg-transparent text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-body [&_svg]:size-3.5",
        md: "h-8 px-3 [&_svg]:size-3.5",
        lg: "h-9 px-4 [&_svg]:size-4",
        icon: "h-8 w-8 px-0 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(button({ variant, size }), className)} {...props} />;
  }
);
Button.displayName = "Button";
