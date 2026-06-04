"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { roleHasPlatformAdmin } from "@/lib/platform-role";
import { trpc } from "@/lib/trpc/client";

export default function AdminUsersPage() {
  const users = trpc.admin.listUsers.useQuery();
  const [q, setQ] = useState("");

  const filtered = (users.data ?? []).filter((u) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      u.name.toLowerCase().includes(needle) ||
      u.email.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">Users</h1>
          <p className="mt-1 text-muted-foreground">
            {users.data ? `${users.data.length} total` : "All users across every org."}
          </p>
        </div>
        <Input
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
      </header>

      {users.isPending && (
        <p className="text-sm text-muted-foreground">Loading users…</p>
      )}
      {users.error && (
        <p className="text-sm text-destructive">{users.error.message}</p>
      )}

      {users.data && (
        <Card>
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 text-center font-medium">Orgs</th>
                  <th className="pb-2 text-center font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="py-3 font-medium">
                      <span className="flex items-center gap-2">
                        {u.name}
                        {roleHasPlatformAdmin(u.role) && (
                          <Badge tone="admin">admin</Badge>
                        )}
                      </span>
                    </td>
                    <td className="py-3 text-muted-foreground">{u.email}</td>
                    <td className="py-3 text-center">{u.orgCount}</td>
                    <td className="py-3 text-center">
                      {u.banned ? (
                        <Badge tone="muted">banned</Badge>
                      ) : u.emailVerified ? (
                        <Badge tone="read">verified</Badge>
                      ) : (
                        <Badge tone="muted">unverified</Badge>
                      )}
                    </td>
                    <td className="py-3 text-right text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                No users match “{q}”.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
