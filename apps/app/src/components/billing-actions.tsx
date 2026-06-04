"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * Owner/admin billing actions for the active org. "Manage" opens the Stripe
 * customer portal (payment method, invoices, cancel); "Change plan or seats"
 * goes back to checkout, which calls subscription.upgrade with the new seats.
 */
export function BillingActions({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState<null | "portal">(null);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setError(null);
    setLoading("portal");
    try {
      const { data, error } = await authClient.subscription.billingPortal({
        referenceId: orgId,
        returnUrl: `${window.location.origin}/settings/billing`,
      });
      if (error) throw new Error(error.message);
      if (data?.url) window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open billing portal");
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={openPortal} disabled={loading === "portal"}>
        {loading === "portal" ? "Opening…" : "Manage payment & invoices"}
      </Button>
      <Button variant="outline" asChild>
        <a href="/checkout">Change plan or seats</a>
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </div>
  );
}
