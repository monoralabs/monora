import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-sm border border-border bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-faint focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Select({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 rounded-sm border border-border bg-card px-2 text-sm text-foreground outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Select };
