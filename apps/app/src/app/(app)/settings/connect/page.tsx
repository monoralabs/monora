"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OnboardingStepper } from "@/components/onboarding-stepper";
import { trpc } from "@/lib/trpc/client";

export default function ConnectPage() {
  const tokens = trpc.tokens.list.useQuery();
  const utils = trpc.useUtils();
  const revoke = trpc.tokens.revoke.useMutation({
    onSuccess: () => utils.tokens.list.invalidate(),
  });

  return (
    <>
      <p className="text-muted-foreground">
        Bring your brain to your computer. Run one command and your AI reads and
        edits your folders like any other file - the same folders you can
        access, nothing more.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Set up your computer</CardTitle>
        </CardHeader>
        <CardContent>
          <OnboardingStepper />
        </CardContent>
      </Card>

      {tokens.data?.length ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Your keys</CardTitle>
            <p className="text-sm text-muted-foreground">
              Each connected computer or read-only setup is a key. Revoke one to
              cut its access right away.
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Prefix</th>
                  <th className="pb-2 font-medium">Last used</th>
                  <th className="pb-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {tokens.data.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="py-3 font-medium">{t.name}</td>
                    <td className="py-3">
                      <span className="font-mono text-faint">
                        {t.tokenPrefix}…
                      </span>
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {t.lastUsedAt
                        ? new Date(t.lastUsedAt).toLocaleDateString()
                        : "never"}
                    </td>
                    <td className="py-3 text-right">
                      {t.revokedAt ? (
                        <Badge tone="muted">revoked</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => revoke.mutate({ tokenId: t.id })}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
