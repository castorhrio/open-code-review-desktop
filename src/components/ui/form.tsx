import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const base =
  "w-full rounded-sm border border-line bg-raised px-2.5 text-strong text-ink " +
  "transition-colors duration-150 placeholder:text-faint hover:border-line-strong " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-45";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(base, "h-8", className)} {...props} />
  )
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(base, "min-h-[58px] py-1.5", className)} {...props} />
  )
);
Textarea.displayName = "Textarea";

/**
 * One labelled control, stacked label-over-value.
 *
 * This deliberately is NOT a `<label>` wrapper. Several call sites put a
 * `Select` trigger, a `Checkbox` or a `<Button>` inside it, and interactive
 * content nested in a `<label>` is invalid and confuses assistive tech (one
 * click on the caption would fire the inner button). When `htmlFor` is given we
 * emit a real `<label>`; otherwise the field becomes a named group so the
 * caption is still announced.
 */
export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const autoId = React.useId();
  const groupLabelId = htmlFor || !label ? undefined : `${autoId}-label`;
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      role={groupLabelId ? "group" : undefined}
      aria-labelledby={groupLabelId}
    >
      {label &&
        (htmlFor ? (
          <label htmlFor={htmlFor} className="text-body font-medium text-muted">
            {label}
          </label>
        ) : (
          <span className="text-body font-medium text-muted">{label}</span>
        ))}
      {children}
      {hint && <span className="text-meta text-faint">{hint}</span>}
    </div>
  );
}

// Radix forbids an empty-string item value, so "unset" options travel through a
// sentinel and are converted back at the boundary.
const NONE = "\u0000none";

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  id,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string; group?: string }[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const groups = [...new Set(options.map((o) => o.group || ""))];
  return (
    <SelectPrimitive.Root
      value={value === "" ? NONE : value}
      onValueChange={(v) => onValueChange(v === NONE ? "" : v)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        className={cn(
          base,
          "flex h-8 min-w-0 items-center justify-between gap-2 data-[disabled]:opacity-45",
          // The selected value is arbitrary user/vendor text (a custom provider
          // model id can easily be 60+ chars with no break opportunity). As a
          // plain flex item it refuses to shrink below its min-content width and
          // pushes straight out of the trigger. Radix renders Value as the first
          // child span, so constrain that one and leave the chevron alone.
          "[&>span:first-child]:min-w-0 [&>span:first-child]:truncate",
          className
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3.5 text-faint" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-surface shadow-lg shadow-black/30"
        >
          <SelectPrimitive.Viewport className="p-1">
            {groups.map((g) => (
              <SelectPrimitive.Group key={g || "default"}>
                {g && <SelectPrimitive.Label className="px-2 pt-2 pb-1 text-meta text-faint">{g}</SelectPrimitive.Label>}
                {options
                  .filter((o) => (o.group || "") === g)
                  .map((o) => (
                    <SelectPrimitive.Item
                      key={o.value || "none"}
                      value={o.value === "" ? NONE : o.value}
                      className="relative flex cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-body text-ink outline-none data-[highlighted]:bg-hover"
                    >
                      <SelectPrimitive.ItemIndicator className="absolute left-0.5 flex size-4 items-center justify-center">
                        <Check className="size-3 text-accent" />
                      </SelectPrimitive.ItemIndicator>
                      <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                    </SelectPrimitive.Item>
                  ))}
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="relative h-[18px] w-8 shrink-0 rounded-full border border-line bg-raised transition-colors duration-150 data-[state=checked]:border-accent data-[state=checked]:bg-accent-solid"
    >
      <SwitchPrimitive.Thumb className="block size-3 translate-x-[2px] rounded-full bg-muted transition-transform duration-150 data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-white" />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-2 text-body text-ink select-none", className)}>
      <CheckboxPrimitive.Root
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-line bg-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent-solid"
      >
        <CheckboxPrimitive.Indicator className="text-white">
          <Check className="size-3" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span>{label}</span>
    </label>
  );
}
