"use client";

import { cn } from "@/lib/utils";

/** A single headline metric. Optional delta line for the last-N-days subtotal. */
export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-soft)]">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-2 font-display text-3xl leading-none">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Dependency-free daily bar chart (the app ships no chart lib). Each bar is a
 * flex column; height is a percentage of the series max. Hover shows the value
 * via the native title attribute.
 */
export function BarChart({
  data,
  className,
}: {
  data: { date: string; count: number }[];
  className?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className={cn("flex h-32 items-end gap-1", className)}>
      {data.map((d) => {
        const pct = (d.count / max) * 100;
        return (
          <div
            key={d.date}
            className="group relative flex flex-1 items-end"
            title={`${d.date}: ${d.count}`}
          >
            <div
              className="w-full rounded-t-sm bg-accent-subtle transition-colors group-hover:bg-accent"
              style={{ height: `${Math.max(pct, d.count > 0 ? 6 : 2)}%` }}
            />
          </div>
        );
      })}
      <span className="sr-only">{total} total over the window</span>
    </div>
  );
}
