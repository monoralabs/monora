import "server-only";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/server/db";
import { member, subscription } from "@/server/db/auth-schema";
import { env } from "@/env";

const ACTIVE = new Set(["active", "trialing", "past_due"]);

// A comp (courtesy) subscription is written by the admin CLI, not Stripe. Its
// stripeSubscriptionId carries this prefix so we never call Stripe for it and
// can wipe every comp in one query when real billing takes over.
const COMP_PREFIX = "comp_";

// Lazy/nullable: billing is optional, so there may be no key. Only reconcileSeats
// touches Stripe, and only for orgs that already have a real subscription.
const stripeClient = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null;

/**
 * Whether an organization has a usable subscription. Drives the hard paywall in
 * front of the dashboard.
 *
 * Billing is referenced to the ORG (`subscription.referenceId = org.id`), so any
 * member of a paid org passes the gate - the owner pays once for the whole team.
 * `referenceId` is null when a user has no active org yet; treat that as unpaid.
 */
export async function hasActiveSubscription(
  referenceId: string | null | undefined,
): Promise<boolean> {
  if (!referenceId) return false;
  const subs = await db
    .select({ status: subscription.status })
    .from(subscription)
    .where(eq(subscription.referenceId, referenceId));
  return subs.some((s) => ACTIVE.has(s.status));
}

/** The active subscription row for an org, if any (prefers an active status). */
export async function activeSubscriptionFor(orgId: string) {
  const subs = await db
    .select()
    .from(subscription)
    .where(eq(subscription.referenceId, orgId));
  return subs.find((s) => ACTIVE.has(s.status)) ?? subs[0] ?? null;
}

/** Current member count of an org (= seats in use). */
export async function seatsInUse(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(member)
    .where(eq(member.organizationId, orgId));
  return row?.n ?? 0;
}

/**
 * Keep the org's paid seat count >= its real member count (overage / auto-bump).
 *
 * Called whenever a member joins an org. If the org outgrows its paid seats we
 * raise the Stripe subscription quantity (prorated) so the owner can invite
 * freely and we bill the difference - no hard cap, no asking us for permission.
 *
 * Never throws: a billing hiccup must not block someone from joining a team.
 * Comp subscriptions and dev/local rows (no real Stripe id) only bump the local
 * seat count.
 */
export async function reconcileSeats(orgId: string): Promise<void> {
  try {
    const sub = await activeSubscriptionFor(orgId);
    if (!sub) return; // unpaid org (or comp not set up): nothing to reconcile

    const used = await seatsInUse(orgId);
    if (used <= (sub.seats ?? 0)) return; // still within paid seats

    const isComp = sub.stripeSubscriptionId?.startsWith(COMP_PREFIX) ?? false;
    if (!isComp && sub.stripeSubscriptionId && stripeClient) {
      // Bump the quantity on the Stripe subscription's licensed item, prorated.
      const stripeSub = await stripeClient.subscriptions.retrieve(
        sub.stripeSubscriptionId,
      );
      const item = stripeSub.items.data[0];
      if (item) {
        await stripeClient.subscriptions.update(sub.stripeSubscriptionId, {
          items: [{ id: item.id, quantity: used }],
          proration_behavior: "create_prorations",
        });
      }
    }

    // Mirror the new seat count locally (the Stripe webhook also syncs this, but
    // we update eagerly so the billing page is correct immediately).
    await db
      .update(subscription)
      .set({ seats: used })
      .where(eq(subscription.id, sub.id));
  } catch (e) {
    console.error(`[billing] reconcileSeats failed for org ${orgId}:`, e);
  }
}
