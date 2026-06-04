"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard, BarChart } from "@/components/admin-charts";
import { trpc } from "@/lib/trpc/client";

export default function AdminOverviewPage() {
  const metrics = trpc.admin.metrics.useQuery();

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl">Overview</h1>
        <p className="mt-1 text-muted-foreground">
          How Monora is growing across every tenant.
        </p>
      </header>

      {metrics.isPending && (
        <p className="text-sm text-muted-foreground">Loading metrics…</p>
      )}

      {metrics.error && (
        <p className="text-sm text-destructive">
          {metrics.error.message ?? "Failed to load metrics."}
        </p>
      )}

      {metrics.data && (
        <>
          <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Users"
              value={metrics.data.totals.users}
              hint={`${metrics.data.totals.verifiedUsers} verified`}
            />
            <StatCard
              label="Organizations"
              value={metrics.data.totals.orgs}
              hint={`${metrics.data.totals.members} memberships`}
            />
            <StatCard
              label="Active subs"
              value={metrics.data.totals.activeSubscriptions}
              hint="active · trialing · past_due"
            />
            <StatCard
              label={`New (${metrics.data.windowDays}d)`}
              value={metrics.data.totals.newUsers}
              hint={`${metrics.data.totals.newOrgs} new orgs`}
            />
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Signups</CardTitle>
                <CardDescription>
                  New users · last {metrics.data.windowDays} days
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarChart data={metrics.data.signupsByDay} />
                <DateAxis points={metrics.data.signupsByDay} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Organizations created</CardTitle>
                <CardDescription>
                  New orgs · last {metrics.data.windowDays} days
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarChart data={metrics.data.orgsByDay} />
                <DateAxis points={metrics.data.orgsByDay} />
              </CardContent>
            </Card>
          </section>

          <section className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Subscriptions</CardTitle>
                <CardDescription>By plan and status</CardDescription>
              </CardHeader>
              <CardContent>
                {metrics.data.plans.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No subscriptions yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {metrics.data.plans.map((p) => (
                      <Badge
                        key={`${p.plan}-${p.status}`}
                        tone={p.status === "active" ? "admin" : "muted"}
                      >
                        {p.plan} · {p.status} · {p.count}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

/** First / middle / last date labels under a bar chart. */
function DateAxis({ points }: { points: { date: string }[] }) {
  if (points.length === 0) return null;
  const first = points[0]!.date.slice(5);
  const mid = points[Math.floor(points.length / 2)]!.date.slice(5);
  const last = points[points.length - 1]!.date.slice(5);
  return (
    <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
      <span>{first}</span>
      <span>{mid}</span>
      <span>{last}</span>
    </div>
  );
}
