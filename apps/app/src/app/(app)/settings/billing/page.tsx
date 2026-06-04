import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { member } from "@/server/db/auth-schema";
import { activeSubscriptionFor, seatsInUse } from "@/server/billing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BillingActions } from "@/components/billing-actions";

const PLAN_LABEL: Record<string, string> = { starter: "Starter", teams: "Teams" };
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Past due",
  canceled: "Canceled",
  incomplete: "Incomplete",
};

export default async function BillingPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const orgId = session?.session.activeOrganizationId ?? null;

  // Only the org owner/admin may manage billing (matches authorizeReference).
  let canManage = false;
  if (orgId && session) {
    const [m] = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
      );
    canManage = m?.role === "owner" || m?.role === "admin";
  }

  const sub = orgId ? await activeSubscriptionFor(orgId) : null;
  const used = orgId ? await seatsInUse(orgId) : 0;
  const isComp = sub?.stripeSubscriptionId?.startsWith("comp_") ?? false;

  return (
    <>
      <p className="text-muted-foreground">
        Your subscription covers the whole organization, billed per seat. Add
        members freely - seats adjust automatically.
      </p>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Subscription</CardTitle>
          {sub && (
            <Badge tone={sub.status === "active" ? "write" : "muted"}>
              {isComp ? "Complimentary" : (STATUS_LABEL[sub.status] ?? sub.status)}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {!sub ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This organization has no active plan yet.
              </p>
              <Button asChild>
                <a href="/checkout">Choose a plan</a>
              </Button>
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd className="mt-0.5 font-medium">
                    {PLAN_LABEL[sub.plan] ?? sub.plan}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Seats</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">
                    {used} used{" "}
                    {!isComp && (
                      <span className="text-muted-foreground">
                        / {sub.seats ?? used} paid
                      </span>
                    )}
                  </dd>
                </div>
                {sub.periodEnd && !isComp && (
                  <div>
                    <dt className="text-muted-foreground">
                      {sub.cancelAtPeriodEnd ? "Ends" : "Renews"}
                    </dt>
                    <dd className="mt-0.5 font-medium">
                      {sub.periodEnd.toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </dd>
                  </div>
                )}
              </dl>

              {isComp ? (
                <p className="text-sm text-muted-foreground">
                  Complimentary access - no payment required. Enjoy.
                </p>
              ) : canManage && orgId ? (
                <BillingActions orgId={orgId} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only an organization owner or admin can change billing.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
