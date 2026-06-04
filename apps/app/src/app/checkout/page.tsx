import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { Checkout } from "@/components/checkout";
import { SunriseBg } from "@/components/sunrise-bg";

// The paywall. You must be signed in to reach it; if not, bounce to the auth
// page carrying the plan intent so we come straight back here after sign-up.
//
// Billing is per-ORG: the subscription attaches to the user's active org, so
// the owner pays once and every member of that org clears the paywall.
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const plan = typeof sp.plan === "string" ? sp.plan : "teams";
  const interval = sp.interval === "monthly" ? "monthly" : "annual";
  const seats =
    typeof sp.seats === "string" && Number(sp.seats) > 0 ? Number(sp.seats) : 1;

  const hdrs = await headers();
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session) {
    const qs = new URLSearchParams({ plan, interval, seats: String(seats) });
    redirect(`/?${qs.toString()}`);
  }

  // Attach billing to the active org. Orgs are normally provisioned before this
  // (via invite or the admin CLI), but if a user reaches checkout without one,
  // spin up a personal workspace so there's something to pay for.
  let orgId = session.session.activeOrganizationId;
  if (!orgId) {
    const name = session.user.name
      ? `${session.user.name}'s workspace`
      : "My workspace";
    const slug = `w-${session.user.id.slice(0, 8)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const org = await auth.api.createOrganization({
      body: { name, slug },
      headers: hdrs,
    });
    orgId = org?.id ?? null;
    if (orgId) {
      await auth.api.setActiveOrganization({
        body: { organizationId: orgId },
        headers: hdrs,
      });
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-6">
      <SunriseBg />
      <div className="relative z-10">
        <Checkout
          plan={plan}
          interval={interval}
          seats={seats}
          orgId={orgId!}
        />
      </div>
    </main>
  );
}
