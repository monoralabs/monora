"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc/client";

/**
 * Approval page for the connector's device login. The CLI shows the user a
 * short code and sends them here; they confirm it, which binds the pending
 * flow to this user + active org. The CLI's next poll gets the token. We never
 * show a token on this page.
 */
export default function DeviceApprovalPage() {
  // useSearchParams needs a Suspense boundary to keep `next build` happy.
  return (
    <Suspense fallback={null}>
      <DeviceApproval />
    </Suspense>
  );
}

function DeviceApproval() {
  const params = useSearchParams();
  const initial = (params.get("code") ?? "").toUpperCase();
  const [code, setCode] = useState(initial);
  const [approved, setApproved] = useState(false);

  const status = trpc.device.status.useQuery(
    { userCode: code },
    { enabled: code.trim().length >= 8, retry: false },
  );

  const approve = trpc.device.approve.useMutation({
    onSuccess: () => setApproved(true),
  });

  if (approved) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <span className="grid size-10 place-items-center rounded-full text-white [background:var(--grad-warm)]">
            <Check className="size-5" />
          </span>
          <h3 className="font-display text-xl">You&apos;re connected</h3>
          <p className="text-sm text-muted-foreground">
            Head back to your terminal - it&apos;s already finishing up. You can
            close this tab.
          </p>
        </div>
      </Shell>
    );
  }

  const resolved = status.data?.alreadyResolved;
  const valid = status.data?.valid;

  return (
    <Shell>
      <p className="mb-4 text-sm text-muted-foreground">
        Your terminal is asking to connect to{" "}
        <span className="font-medium text-foreground">
          {status.data?.orgName ?? "your brain"}
        </span>
        . Check the code below matches the one shown there, then approve.
      </p>

      <label className="mb-1 block text-sm font-medium">Code from your terminal</label>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-lg tracking-widest outline-none focus:border-accent"
      />

      {code.trim().length >= 8 && resolved ? (
        <p className="mt-2 text-sm text-destructive">
          That code was already used or has expired. Start again in your terminal.
        </p>
      ) : null}
      {approve.error ? (
        <p className="mt-2 text-sm text-destructive">{approve.error.message}</p>
      ) : null}

      <Button
        className="mt-4 w-full"
        disabled={!valid || approve.isPending}
        onClick={() => approve.mutate({ userCode: code })}
      >
        {approve.isPending ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Approving…
          </>
        ) : (
          `Approve and connect`
        )}
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        Only approve a code you started yourself. It grants your terminal the
        same access you have, until you revoke the key in Settings.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md">
      <Card className="mt-10">
        <CardHeader>
          <CardTitle>Connect your terminal</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
