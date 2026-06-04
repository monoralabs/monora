import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink, emailOTP, organization } from "better-auth/plugins";
import { stripe as stripePlugin } from "@better-auth/stripe";
import { and, asc, eq } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/server/db";
import * as authSchema from "@/server/db/auth-schema";
import { ensureDefaultBrainAccess } from "@/server/seed-default-brain";
import { reconcileSeats } from "@/server/billing";
import {
  sendInvitationEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendMagicLinkEmail,
  sendOtpEmail,
} from "@/server/email";
import { env } from "@/env";

// Billing is optional and OFF by default (BILLING_ENABLED). The open-source /
// self-hosted product is single-org with no paywall; the managed cloud turns it
// on, lighting up the Stripe plugin, the per-seat reconcile, and the dashboard
// paywall together. All transactional email goes through @/server/email (dev
// outbox vs Resend, on-brand card, throws on failure) - see that CLAUDE.md.
const billingEnabled = env.BILLING_ENABLED && Boolean(env.STRIPE_SECRET_KEY);
const stripeClient = billingEnabled ? new Stripe(env.STRIPE_SECRET_KEY!) : null;

/**
 * Better Auth on self-hosted Postgres (Drizzle adapter).
 *
 * The `organization` plugin IS our multi-tenancy primitive: it owns the
 * organization / member / invitation tables and stamps `activeOrganizationId`
 * onto the session. Domain tables (brains, audit_log, ...) are RLS-scoped to
 * that active org. See server/db/tenant.ts.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    // Self-serve email+password signups must confirm they own the address
    // before they can sign in. Invited users who come in via Google or the
    // email OTP code are already verified (the OTP/oauth proves ownership), so
    // this only adds a step to the password path.
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, resetUrl: url });
    },
  },

  // Branded "confirm your email" message. sendVerificationEmail() handles dev
  // (outbox) vs prod (Resend) and throws on failure, so we don't swallow it.
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, verifyUrl: url });
    },
  },

  socialProviders: {
    google: {
      clientId: env.GOOGLE_ID ?? "",
      clientSecret: env.GOOGLE_SECRET ?? "",
    },
  },

  // Auto-link a Google sign-in to an existing email/password user with the same
  // email. Google verifies email ownership, so it's safe to trust for linking;
  // without this, Better Auth returns `account_not_linked` to avoid takeover.
  // `requireLocalEmailVerified: false` is required because our email/password
  // users aren't forced to verify their email, so the local account would
  // otherwise still block linking even for a trusted provider.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      requireLocalEmailVerified: false,
    },
  },

  session: {
    // Cache the session in a short-lived signed cookie so getSession does not
    // hit the DB (and re-run every plugin's session logic) on each request.
    // Better Auth's default is 5 min; the session is still re-validated against
    // the DB when the cache expires. 3s effectively disabled the cache and made
    // nearly every page load pay the full session round trip.
    cookieCache: { enabled: true, maxAge: 300 },
  },

  // Better Auth's organization plugin does NOT stamp an active org onto a fresh
  // session - it stays null until something calls setActiveOrganization. With a
  // null active org, ctx.orgId is null and every RLS-scoped query returns zero
  // rows (orgProcedure can't bind app.current_org_id), so the user sees an empty
  // app even though they own brains. Default it here: on session create, point
  // the session at the user's oldest membership (deterministic for the common
  // single-org case). The org switcher can still change it later.
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const [m] = await db
            .select({ orgId: authSchema.member.organizationId })
            .from(authSchema.member)
            .where(eq(authSchema.member.userId, session.userId))
            .orderBy(asc(authSchema.member.createdAt))
            .limit(1);
          if (!m) return;
          return { data: { ...session, activeOrganizationId: m.orgId } };
        },
      },
    },
  },

  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      // Seed the default "Monora" guide brain into every new org, and grant read
      // to the creator + every member who joins. Both are idempotent and never
      // throw (a failure is logged, not fatal to org creation / joining).
      // NOTE: these MUST live under `organizationHooks` - Better Auth only invokes
      // them from there (see better-auth/.../routes/crud-org.mjs). As top-level
      // plugin options they are silently ignored and the brain is never seeded.
      organizationHooks: {
        afterCreateOrganization: async ({
          organization,
          user,
        }: {
          organization: { id: string };
          user: { id: string };
        }) => {
          await ensureDefaultBrainAccess(organization.id, user.id);
        },
        afterAddMember: async ({
          organization,
          user,
        }: {
          organization: { id: string };
          user: { id: string };
        }) => {
          await ensureDefaultBrainAccess(organization.id, user.id);
          // Per-seat billing: a new member may push the org past its paid seats.
          // Auto-bump the Stripe quantity (prorated) so the owner invites freely.
          // No-op when billing is off (open-source / self-host single-org).
          if (billingEnabled) await reconcileSeats(organization.id);
        },
      },
      sendInvitationEmail: async (data) => {
        // `data.id` is the invitation id; the accept page resolves it.
        const inviteId = data.id ?? data.invitation?.id;
        await sendInvitationEmail({
          to: data.email,
          inviteUrl: `${env.BETTER_AUTH_URL}/accept-invitation/${inviteId}`,
          orgName: data.organization?.name ?? "a team",
          inviterName:
            data.inviter?.user?.name ??
            data.inviter?.user?.email ??
            "A teammate",
        });
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendMagicLinkEmail({ to: email, signInUrl: url });
      },
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      sendVerificationOTP: async ({ email, otp }) => {
        await sendOtpEmail({ to: email, otp });
      },
    }),
    admin(),
    // Stripe plugin only when billing is enabled (managed cloud); omitted in
    // the open-source / self-hosted single-org build.
    ...(stripeClient
      ? [
          stripePlugin({
            stripeClient,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        // Billing is referenced to the ORG, not the user: checkout passes the
        // active org id as `referenceId`. This gate decides who may touch a
        // given org's billing - only its owner/admin. A regular member (or a
        // user passing someone else's org id) is rejected.
        authorizeReference: async ({ user, referenceId }) => {
          const [m] = await db
            .select({ role: authSchema.member.role })
            .from(authSchema.member)
            .where(
              and(
                eq(authSchema.member.organizationId, referenceId),
                eq(authSchema.member.userId, user.id),
              ),
            );
          return m?.role === "owner" || m?.role === "admin";
        },
        // Stripe Checkout defaults to `customer_update: { name: "auto" }` for
        // user customers, which OVERWRITES the Stripe customer name with the
        // billing name of the payment method used (e.g. the cardholder on a
        // shared/Link card). We keep `address: "auto"` (needed for tax) but drop
        // `name`, so the customer keeps the name set at sign-up (user.name).
        getCheckoutSessionParams: () => ({
          params: { customer_update: { address: "auto" } },
        }),
        // Plans mirror the landing (Starter / Teams). Per-seat, so the seat
        // count travels as `seats` (quantity) at checkout. annualDiscountPriceId
        // is used when subscription.upgrade is called with `annual: true`.
        plans: [
          {
            name: "starter",
            priceId: env.STARTER_PRICE_ID ?? "",
            annualDiscountPriceId: env.STARTER_ANNUAL_PRICE_ID ?? "",
          },
          {
            name: "teams",
            priceId: env.TEAMS_PRICE_ID ?? "",
            annualDiscountPriceId: env.TEAMS_ANNUAL_PRICE_ID ?? "",
          },
        ],
      },
          }),
        ]
      : []),
  ],
});

export type Session = typeof auth.$Infer.Session;
