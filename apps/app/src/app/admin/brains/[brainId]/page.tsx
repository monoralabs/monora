"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Folder } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc/client";

export default function AdminBrainDetailPage() {
  const params = useParams<{ brainId: string }>();
  const brain = trpc.admin.getBrain.useQuery({ brainId: params.brainId });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <Link
        href="/admin/brains"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All brains
      </Link>

      {brain.isPending && (
        <p className="text-sm text-muted-foreground">Loading brain…</p>
      )}
      {brain.error && (
        <p className="text-sm text-destructive">{brain.error.message}</p>
      )}

      {brain.data && (
        <>
          <header className="mb-6">
            <h1 className="font-display text-2xl">{brain.data.brain.name}</h1>
            <p className="mt-1 flex items-center gap-2 text-muted-foreground">
              <span>{brain.data.org.name}</span>
              {brain.data.org.slug && (
                <span className="font-mono text-xs text-faint">
                  /{brain.data.org.slug}
                </span>
              )}
              <Badge tone="muted">{brain.data.folders.length} folders</Badge>
            </p>
          </header>

          <Card>
            <CardHeader>
              <CardTitle>Folders</CardTitle>
            </CardHeader>
            <CardContent>
              {brain.data.folders.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This brain has no folders yet.
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {brain.data.folders.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center gap-3 py-2.5 text-sm"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{f.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {f.path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-4 text-xs text-faint">
                Read-only structure. File contents are not exposed in the admin
                view.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
