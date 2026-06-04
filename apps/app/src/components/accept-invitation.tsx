"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/**
 * The "accept" action for an org invitation. Rendered only when the viewer is
 * signed in with the invited email (the server component gates that). On accept
 * we join the org, make it the active org (so orgProcedure has an orgId), and
 * land on the dashboard.
 */
export function AcceptInvitation({
  invitationId,
  organizationId,
}: {
  invitationId: string;
  organizationId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setLoading(true);
    setError(null);
    const res = await authClient.organization.acceptInvitation({
      invitationId,
    });
    if (res.error) {
      setError(res.error.message ?? "Could not accept the invitation");
      setLoading(false);
      return;
    }
    // Make the joined org active so the dashboard (orgProcedure) resolves.
    await authClient.organization.setActive({ organizationId });
    router.push("/brains");
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md bg-accent-light p-2 text-center text-xs text-destructive">
          {error}
        </p>
      )}
      <Button className="w-full" onClick={accept} disabled={loading}>
        {loading ? "Joining…" : "Accept invitation"}
      </Button>
    </div>
  );
}
