import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { invitation, organization } from "@/server/db/auth-schema";
import { auth } from "@/server/auth";
import { AuthForm } from "@/components/auth-form";
import { AcceptInvitation } from "@/components/accept-invitation";
import { Card, CardContent } from "@/components/ui/card";
import { SunriseBg } from "@/components/sunrise-bg";

/**
 * Public landing for an org invitation link (outside the (app) gate, so it
 * works while signed out). Three states:
 *  - not signed in   -> sign in/up with the invited email, then come back here
 *  - signed in, match -> show the Accept button
 *  - signed in, mismatch / invalid -> explain
 */
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [inv] = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationId: invitation.organizationId,
      orgName: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.id, id));

  const session = await auth.api.getSession({ headers: await headers() });

  const expired = inv ? inv.expiresAt.getTime() < Date.now() : false;
  const invalid = !inv || inv.status !== "pending" || expired;

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-6">
      <SunriseBg />
      <div className="relative z-10 w-full max-w-sm">
        {invalid ? (
          <Card>
            <CardContent className="space-y-2 p-6 text-center">
              <p className="font-medium">This invitation isn’t valid</p>
              <p className="text-sm text-muted-foreground">
                {!inv
                  ? "We couldn’t find this invitation."
                  : expired
                    ? "It has expired. Ask for a new one."
                    : "It has already been used or revoked."}
              </p>
            </CardContent>
          </Card>
        ) : !session ? (
          <div className="space-y-4">
            <p className="text-center text-sm text-muted-foreground">
              You’ve been invited to join <strong>{inv.orgName}</strong> on
              Monora.
            </p>
            <AuthForm
              callbackURL={`/accept-invitation/${id}`}
              invitedEmail={inv.email}
            />
          </div>
        ) : session.user.email.toLowerCase() !== inv.email.toLowerCase() ? (
          <Card>
            <CardContent className="space-y-2 p-6 text-center">
              <p className="font-medium">Wrong account</p>
              <p className="text-sm text-muted-foreground">
                This invitation is for <strong>{inv.email}</strong>, but you’re
                signed in as <strong>{session.user.email}</strong>. Sign out and
                sign back in with the invited email.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-4 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                Join <strong>{inv.orgName}</strong> on Monora.
              </p>
              <AcceptInvitation
                invitationId={inv.id}
                organizationId={inv.organizationId}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
