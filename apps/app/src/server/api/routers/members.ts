import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure, orgAdminProcedure } from "@/server/api/trpc";
import { invitation, member, organization, user } from "@/server/db/auth-schema";
import { sendInvitationEmail } from "@/server/email";
import { env } from "@/env";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

/** Org roster + pending invitations. New invites are created client-side via
 *  Better Auth (authClient.organization.inviteMember); here we surface the
 *  pending ones and let an admin resend or cancel them - Better Auth's org
 *  client doesn't expose those. */
export const membersRouter = router({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        userId: member.userId,
        name: user.name,
        email: user.email,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, ctx.orgId));
  }),

  /** Pending invitations for the active org (anyone in the org can see them). */
  listInvitations: orgProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        inviterName: user.name,
        inviterEmail: user.email,
      })
      .from(invitation)
      .innerJoin(user, eq(user.id, invitation.inviterId))
      .where(
        and(
          eq(invitation.organizationId, ctx.orgId),
          eq(invitation.status, "pending"),
        ),
      )
      .orderBy(desc(invitation.createdAt));
  }),

  /** Re-send the email for an existing pending invitation, reusing its link.
   *  Bumps the expiry so a stale invite becomes usable again. Admin-only. */
  resendInvitation: orgAdminProcedure
    .input(z.object({ invitationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [inv] = await ctx.db
        .select({
          id: invitation.id,
          email: invitation.email,
          status: invitation.status,
          orgName: organization.name,
          inviterName: user.name,
          inviterEmail: user.email,
        })
        .from(invitation)
        .innerJoin(
          organization,
          eq(organization.id, invitation.organizationId),
        )
        .innerJoin(user, eq(user.id, invitation.inviterId))
        .where(
          and(
            eq(invitation.id, input.invitationId),
            eq(invitation.organizationId, ctx.orgId),
          ),
        )
        .limit(1);

      if (!inv) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
      }
      if (inv.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invitation is already ${inv.status}`,
        });
      }

      // Refresh the expiry so resending an old invite actually works on accept.
      await ctx.db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() + SEVEN_DAYS) })
        .where(eq(invitation.id, inv.id));

      // Throws (and rolls back the bump) if Resend rejects - no silent success.
      const result = await sendInvitationEmail({
        to: inv.email,
        inviteUrl: `${env.BETTER_AUTH_URL}/accept-invitation/${inv.id}`,
        orgName: inv.orgName ?? "a team",
        inviterName: inv.inviterName ?? inv.inviterEmail ?? "A teammate",
      });
      return { ok: true, email: inv.email, emailId: result.id };
    }),

  /** Cancel (delete) a pending invitation, which also unblocks re-inviting that
   *  email (Better Auth refuses a new invite while a pending one exists). */
  cancelInvitation: orgAdminProcedure
    .input(z.object({ invitationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db
        .delete(invitation)
        .where(
          and(
            eq(invitation.id, input.invitationId),
            eq(invitation.organizationId, ctx.orgId),
          ),
        )
        .returning({ id: invitation.id, email: invitation.email });

      if (deleted.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
      }
      return { ok: true, email: deleted[0]!.email };
    }),
});
