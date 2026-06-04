"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc/client";

export default function AdminOrgsPage() {
  const orgs = trpc.admin.listOrgs.useQuery();
  const [q, setQ] = useState("");

  const filtered = (orgs.data ?? []).filter((o) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      o.name.toLowerCase().includes(needle) ||
      (o.slug ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">Organizations</h1>
          <p className="mt-1 text-muted-foreground">
            {orgs.data ? `${orgs.data.length} total` : "Every tenant on Monora."}
          </p>
        </div>
        <Input
          placeholder="Search name or slug…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
      </header>

      {orgs.isPending && (
        <p className="text-sm text-muted-foreground">Loading organizations…</p>
      )}
      {orgs.error && (
        <p className="text-sm text-destructive">{orgs.error.message}</p>
      )}

      {orgs.data && (
        <Card>
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Slug</th>
                  <th className="pb-2 text-center font-medium">Members</th>
                  <th className="pb-2 text-right font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="py-3 font-medium">{o.name}</td>
                    <td className="py-3 font-mono text-xs text-muted-foreground">
                      {o.slug ?? "-"}
                    </td>
                    <td className="py-3 text-center">{o.memberCount}</td>
                    <td className="py-3 text-right text-muted-foreground">
                      {new Date(o.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                No organizations match “{q}”.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
