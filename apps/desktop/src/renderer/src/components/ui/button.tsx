import { type VariantProps, cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-all duration-150 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:brightness-110",
        accent: "bg-accent text-accent-foreground shadow-sm hover:brightness-110",
        tint: "bg-primary/10 text-primary hover:bg-primary/15",
        teal: "bg-teal/10 text-teal hover:bg-teal/15",
        outline: "border border-border bg-card shadow-xs hover:border-primary/40 hover:bg-muted",
        ghost: "hover:bg-muted",
        destructive: "text-destructive hover:bg-destructive/10",
      },
      size: { default: "h-10 px-4", sm: "h-8 px-3 text-xs" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
