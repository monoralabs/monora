import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { organization, member } from "@/server/db/auth-schema";
import { hasActiveSubscription } from "@/server/billing";
import { env } from "@/env";
import { isPlatformAdmin } from "@/server/authz/platform";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarUser } from "@/components/sidebar-user";
import { OrgSwitcher, type OrgSummary } from "@/components/org-switcher";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Gate: must be signed in AND your active org must have a subscription (hard
  // paywall). Billing is per-org, so any member of a paid org gets in. Platform
  // admins (Monora staff) bypass the paywall entirely - they need to operate the
  // product regardless of any org's billing state.
  const preview = process.env.MONORA_PREVIEW === "1"; // TEMP: screenshot preview
  const session = preview
    ? {
        user: { id: "user_preview", name: "Preview User", email: "preview@monora.local" },
        session: { activeOrganizationId: "org_preview" },
      }
    : await auth.api.getSession({ headers: await headers() });

  // Platform admins (Monora staff) get an extra entry into /admin - and skip the
  // paywall below.
  const isAdmin = !preview && session
    ? await isPlatformAdmin(session.user.id)
    : false;

  if (!preview) {
    if (!session) redirect("/");
    const orgId = session.session.activeOrganizationId;
    // Paywall only when billing is enabled (managed cloud). Self-host / OSS runs
    // single-org with no subscription gate.
    if (env.BILLING_ENABLED && !isAdmin && !(await hasActiveSubscription(orgId)))
      redirect("/checkout");
  }

  // Every org the user belongs to, for the sidebar switcher. `organization` /
  // `member` are Better Auth core tables (not RLS-gated domain tables), so it's
  // safe to read directly here. A user can belong to several orgs; switching
  // sets session.activeOrganizationId. Logo is a data URL set in Settings.
  const activeOrgId = session?.session.activeOrganizationId ?? null;
  const orgs: OrgSummary[] = preview
    ? [{ id: "org_preview", name: "Monora", logo: null }]
    : session
      ? (
          await db
            .select({
              id: organization.id,
              name: organization.name,
              logo: organization.logo,
            })
            .from(member)
            .innerJoin(organization, eq(member.organizationId, organization.id))
            .where(eq(member.userId, session.user.id))
            .orderBy(asc(member.createdAt))
        ).map((o) => ({ id: o.id, name: o.name, logo: o.logo ?? null }))
      : [];

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface-soft px-3 py-5">
        <div className="px-3 pb-6">
          <span className="wordmark text-lg">Monora</span>
        </div>

        <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />

        <DashboardNav isAdmin={isAdmin} />

        <SidebarUser name={session?.user.name} email={session?.user.email} />
      </aside>

      <main className="flex-1 bg-background">{children}</main>
    </div>
  );
}
