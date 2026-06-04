"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc/client";

export default function ActivityPage() {
  const activity = trpc.org.recentActivity.useQuery({ limit: 100 });

  return (
    <>
      <p className="text-muted-foreground">
        The append-only audit trail: every brain, folder, access and git event.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 font-medium">Action</th>
                <th className="pb-2 font-medium">Target</th>
                <th className="pb-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {activity.data?.map((a) => (
                <tr
                  key={a.id}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="py-2.5">
                    <span className="font-mono text-foreground">{a.action}</span>
                  </td>
                  <td className="py-2.5 text-muted-foreground">
                    {a.target ?? "-"}
                  </td>
                  <td className="py-2.5 text-right text-faint">
                    {new Date(a.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {activity.data?.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">Nothing yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
