"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc/client";

export default function AdminBrainsPage() {
  const brains = trpc.admin.listBrains.useQuery();
  const [q, setQ] = useState("");

  const filtered = (brains.data ?? []).filter((b) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      b.name.toLowerCase().includes(needle) ||
      (b.slug ?? "").toLowerCase().includes(needle) ||
      b.orgName.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">Brains</h1>
          <p className="mt-1 text-muted-foreground">
            {brains.data
              ? `${brains.data.length} total across every org`
              : "Every brain across every tenant."}
          </p>
        </div>
        <Input
          placeholder="Search brain or org…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
      </header>

      {brains.isPending && (
        <p className="text-sm text-muted-foreground">Loading brains…</p>
      )}
      {brains.error && (
        <p className="text-sm text-destructive">{brains.error.message}</p>
      )}

      {brains.data && (
        <Card>
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Brain</th>
                  <th className="pb-2 font-medium">Organization</th>
                  <th className="pb-2 text-center font-medium">Folders</th>
                  <th className="pb-2 text-right font-medium">Created</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <tr
                    key={b.id}
                    className="group border-b border-border/60 last:border-0 hover:bg-secondary/40"
                  >
                    <td className="py-3 font-medium">
                      <Link
                        href={`/admin/brains/${b.id}`}
                        className="hover:underline"
                      >
                        {b.name}
                      </Link>
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {b.orgName}
                      {b.orgSlug && (
                        <span className="ml-1 font-mono text-xs text-faint">
                          /{b.orgSlug}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-center">
                      <Badge tone="muted">{b.folderCount}</Badge>
                    </td>
                    <td className="py-3 text-right text-muted-foreground">
                      {new Date(b.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-3 text-right">
                      <Link
                        href={`/admin/brains/${b.id}`}
                        className="inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={`Open ${b.name}`}
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                No brains match “{q}”.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
