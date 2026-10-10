import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border text-[13px] font-medium " +
    "transition-[background-color,border-color,color,transform] duration-150 ease-out " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
    "disabled:pointer-events-none disabled:opacity-45 active:translate-y-[0.5px] [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-line bg-raised text-ink hover:bg-hover hover:border-line-strong",
        primary: "border-transparent bg-accent text-accent-ink hover:brightness-110",
        ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink",
        outline: "border-line bg-transparent text-ink hover:bg-hover",
        danger: "border-bad/35 bg-bad/10 text-bad hover:bg-bad/20",
        link: "border-transparent bg-transparent text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-8 px-3",
        lg: "h-9 px-4",
        icon: "h-8 w-8 px-0",
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
