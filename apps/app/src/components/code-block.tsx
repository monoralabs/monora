"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** A copy-able code block on brand tokens. Used by onboarding and Connect. */
export function CodeBlock({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`relative ${className ?? ""}`}>
      <pre className="overflow-x-auto rounded-md border border-border bg-card p-3 pr-10 font-mono text-xs leading-relaxed text-foreground">
        {text}
      </pre>
      <button
        type="button"
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label="Copy"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
