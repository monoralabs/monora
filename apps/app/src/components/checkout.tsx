"use client";

import { useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Mirrors the landing plans (per-seat). Annual shows the discounted per-seat/mo.
const PLANS = [
  {
    slug: "starter",
    label: "Starter",
    monthly: 8,
    annual: 6,
    features: [
      "Up to 10 seats (humans + agents)",
      "Per-folder spaces, server-enforced",
      "Real git tree + MCP endpoint",
    ],
  },
  {
    slug: "teams",
    label: "Teams",
    monthly: 15,
    annual: 12,
    highlighted: true,
    features: [
      "Unlimited seats",
      "Nested + matrix permissions",
      "SSO and full audit log",
    ],
  },
] as const;

export function Checkout({
  plan: initialPlan,
  interval: initialInterval,
  seats: initialSeats,
  orgId,
}: {
  plan: string;
  interval: "monthly" | "annual";
  seats: number;
  orgId: string;
}) {
  const [slug, setSlug] = useState(
    PLANS.some((p) => p.slug === initialPlan) ? initialPlan : "teams",
  );
  const [annual, setAnnual] = useState(initialInterval === "annual");
  const [seats, setSeats] = useState(Math.max(1, initialSeats));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function pay() {
    setError(null);
    setLoading(true);
    try {
      const interval = annual ? "annual" : "monthly";
      const { data, error } = await authClient.subscription.upgrade({
        plan: slug,
        annual,
        seats,
        // Bill the org, not the user: any member of this org clears the paywall.
        referenceId: orgId,
        successUrl: `${window.location.origin}/brains`,
        cancelUrl: `${window.location.origin}/checkout?plan=${slug}&interval=${interval}&seats=${seats}`,
      });
      if (error) throw new Error(error.message);
      if (data?.url) window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout");
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-6 text-center">
        <span className="wordmark text-2xl">Monora</span>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a plan to activate your workspace
        </p>
      </div>

      {/* Billing toggle */}
      <div className="mb-6 flex justify-center">
        <div className="inline-flex items-center rounded-full border border-border bg-card p-1 text-sm font-semibold">
          <button
            type="button"
            onClick={() => setAnnual(false)}
            className={cn(
              "rounded-full px-4 py-1.5 transition-colors",
              !annual
                ? "text-white [background:var(--grad-warm)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setAnnual(true)}
            className={cn(
              "flex items-center gap-2 rounded-full px-4 py-1.5 transition-colors",
              annual
                ? "text-white [background:var(--grad-warm)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Annual
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[11px] font-bold",
                annual ? "bg-white/25 text-white" : "bg-accent-subtle text-accent",
              )}
            >
              −20%
            </span>
          </button>
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map((p) => {
          const selected = p.slug === slug;
          const perSeat = annual ? p.annual : p.monthly;
          return (
            <button
              key={p.slug}
              type="button"
              onClick={() => setSlug(p.slug)}
              className={cn(
                "rounded-2xl border bg-card p-6 text-left transition-all",
                selected
                  ? "border-accent shadow-[var(--shadow-soft)] ring-1 ring-accent"
                  : "border-border hover:border-border-strong",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-xl">{p.label}</span>
                {selected && <Check className="size-5 text-accent" />}
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span
                  className={cn(
                    "font-display text-3xl tabular-nums",
                    selected ? "text-accent" : "text-foreground",
                  )}
                >
                  ${perSeat}
                </span>
                <span className="text-sm text-muted-foreground">/ seat / mo</span>
              </div>
              <ul className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" />
                    {f}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      {/* Seats + total + pay */}
      <div className="mt-6 rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Seats</span>
            <div className="flex items-center gap-1 rounded-full border border-border p-1">
              <button
                type="button"
                onClick={() => setSeats((s) => Math.max(1, s - 1))}
                className="grid size-7 place-items-center rounded-full hover:bg-secondary"
                aria-label="Fewer seats"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="w-8 text-center font-display tabular-nums">
                {seats}
              </span>
              <button
                type="button"
                onClick={() => setSeats((s) => s + 1)}
                className="grid size-7 place-items-center rounded-full hover:bg-secondary"
                aria-label="More seats"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          </div>
          <div className="text-right">
            <div className="font-display text-2xl tabular-nums">
              $
              {(annual
                ? PLANS.find((p) => p.slug === slug)!.annual
                : PLANS.find((p) => p.slug === slug)!.monthly) * seats}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                / mo
              </span>
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              {annual ? "billed annually" : "billed monthly"}
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-md bg-accent-light p-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}

        <Button className="mt-5 w-full" onClick={pay} disabled={loading}>
          {loading ? "Redirecting to payment…" : "Continue to payment"}
        </Button>
        <p className="mt-3 text-center text-xs text-faint">
          Secure checkout via Stripe. Cancel anytime.
        </p>
      </div>
    </div>
  );
}
