/**
 * End-to-end auth/invite harness. Drives the REAL running dev server over HTTP
 * (Better Auth + tRPC), reads codes/links from the dev outbox (/api/dev/outbox),
 * and asserts side effects against the DB (owner connection). No browser, no
 * SMTP - a fully automatable feedback loop for the invitation + verification
 * flows.
 *
 * Prereqs: dev server on E2E_BASE (default :3000) with NODE_ENV=development, and
 * Postgres reachable via DATABASE_URL_OWNER.
 *
 *   mise exec -- pnpm --filter @monora/app exec tsx scripts/e2e-auth.ts
 */
import { createDb } from "@monora/db";
import {
  organization,
  user,
  member,
  invitation,
  session,
  account,
} from "@monora/db/auth-schema";
import { and, eq, inArray, like, or } from "drizzle-orm";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const DOMAIN = "e2e.monora.test";
const ORG_SLUG = "e2e-acme";

const DBURL = process.env.DATABASE_URL_OWNER;
if (!DBURL) {
  console.error("DATABASE_URL_OWNER required");
  process.exit(1);
}
const db = createDb(DBURL);

// ---------- tiny assert framework ----------
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (detail ? ` - ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
function section(t: string) {
  console.log(`\n── ${t}`);
}

// ---------- cookie-jar fetch ----------
type Jar = Map<string, string>;
function newJar(): Jar {
  return new Map();
}
function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Jar, res: Response) {
  // Node fetch exposes getSetCookie(); fall back to single header.
  const raw: string[] =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie") as string]
        : [];
  for (const line of raw) {
    const first = line.split(";")[0]!;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const val = first.slice(eq + 1).trim();
    if (val === "" || val === "deleted") jar.delete(name);
    else jar.set(name, val);
  }
}

async function api(
  jar: Jar,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      cookie: cookieHeader(jar),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(jar, res);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json (redirects) */
  }
  return { status: res.status, json, text };
}

// Better Auth helpers
const auth = {
  sendOtp: (jar: Jar, email: string) =>
    api(jar, "/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    }),
  signInOtp: (jar: Jar, email: string, otp: string) =>
    api(jar, "/api/auth/sign-in/email-otp", { email, otp }),
  signUpPassword: (jar: Jar, email: string, password: string, name: string) =>
    api(jar, "/api/auth/sign-up/email", { email, password, name }),
  signInPassword: (jar: Jar, email: string, password: string) =>
    api(jar, "/api/auth/sign-in/email", { email, password }),
  createOrg: (jar: Jar, name: string, slug: string) =>
    api(jar, "/api/auth/organization/create", { name, slug }),
  setActive: (jar: Jar, organizationId: string) =>
    api(jar, "/api/auth/organization/set-active", { organizationId }),
  invite: (jar: Jar, email: string, organizationId: string, role = "member") =>
    api(jar, "/api/auth/organization/invite-member", {
      email,
      role,
      organizationId,
    }),
  accept: (jar: Jar, invitationId: string) =>
    api(jar, "/api/auth/organization/accept-invitation", { invitationId }),
};

// tRPC mutation over httpBatchLink (superjson): body {"0":{"json":<input>}}
async function trpcMutate(jar: Jar, proc: string, input: unknown) {
  const res = await api(jar, `/api/trpc/${proc}?batch=1`, {
    "0": { json: input },
  });
  const entry = Array.isArray(res.json) ? res.json[0] : res.json;
  if (entry?.error) {
    return { ok: false as const, error: entry.error.json ?? entry.error, status: res.status };
  }
  return { ok: true as const, data: entry?.result?.data?.json, status: res.status };
}

// ---------- outbox ----------
type OutEmail = {
  id: number;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  kind: string;
  otp?: string;
  url?: string;
};
async function outbox(): Promise<OutEmail[]> {
  const res = await fetch(`${BASE}/api/dev/outbox`);
  if (!res.ok) throw new Error(`outbox ${res.status} (is NODE_ENV=development?)`);
  return (await res.json()).emails as OutEmail[];
}
async function clearOutbox() {
  await fetch(`${BASE}/api/dev/outbox`, { method: "DELETE" });
}
async function latestTo(to: string, kind?: string): Promise<OutEmail | undefined> {
  const all = await outbox();
  const match = all.filter((e) => e.to === to && (!kind || e.kind === kind));
  return match[match.length - 1];
}

// ---------- DB helpers ----------
async function cleanup() {
  const e2eUsers = await db
    .select({ id: user.id })
    .from(user)
    .where(like(user.email, `%@${DOMAIN}`));
  const e2eOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.slug, "e2e-%"));
  const userIds = e2eUsers.map((u) => u.id);
  const orgIds = e2eOrgs.map((o) => o.id);

  await db
    .delete(invitation)
    .where(
      or(
        orgIds.length ? inArray(invitation.organizationId, orgIds) : undefined,
        like(invitation.email, `%@${DOMAIN}`),
      ),
    );
  if (orgIds.length || userIds.length) {
    await db
      .delete(member)
      .where(
        or(
          orgIds.length ? inArray(member.organizationId, orgIds) : undefined,
          userIds.length ? inArray(member.userId, userIds) : undefined,
        ),
      );
  }
  if (userIds.length) {
    await db.delete(session).where(inArray(session.userId, userIds));
    await db.delete(account).where(inArray(account.userId, userIds));
  }
  if (orgIds.length) {
    await db.delete(organization).where(inArray(organization.id, orgIds));
  }
  if (userIds.length) {
    await db.delete(user).where(inArray(user.id, userIds));
  }
}

async function getUser(email: string) {
  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  return u;
}
async function getMember(orgId: string, userId: string) {
  const [m] = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return m;
}
async function getInvitation(id: string) {
  const [i] = await db
    .select()
    .from(invitation)
    .where(eq(invitation.id, id))
    .limit(1);
  return i;
}

// Sign a user in via OTP (creates a verified account if new). Returns the jar.
async function otpSignIn(email: string): Promise<Jar> {
  const jar = newJar();
  const sent = await auth.sendOtp(jar, email);
  if (sent.status !== 200) throw new Error(`sendOtp ${email}: ${sent.status} ${sent.text}`);
  const mail = await latestTo(email, "otp");
  if (!mail?.otp) throw new Error(`no OTP captured for ${email}`);
  const signed = await auth.signInOtp(jar, email, mail.otp);
  if (signed.status !== 200) throw new Error(`signInOtp ${email}: ${signed.status} ${signed.text}`);
  return jar;
}

// ---------- run ----------
async function main() {
  console.log(`E2E auth harness against ${BASE}\n`);
  await clearOutbox();
  await cleanup();

  const inviterEmail = `inviter@${DOMAIN}`;
  const inviteeEmail = `invitee@${DOMAIN}`;
  const cancelEmail = `cancel@${DOMAIN}`;
  const pwEmail = `pw@${DOMAIN}`;

  // ===== 1. OTP sign-in creates a verified account =====
  section("OTP sign-in (invitee mechanic)");
  const inviterJar = await otpSignIn(inviterEmail);
  const inviterUser = await getUser(inviterEmail);
  check("inviter user created", !!inviterUser);
  check("inviter email auto-verified", !!inviterUser?.emailVerified);

  // ===== 2. Inviter creates an org over HTTP =====
  section("Org create + activate");
  const created = await auth.createOrg(inviterJar, "E2E Acme", ORG_SLUG);
  const orgId =
    created.json?.id ?? created.json?.organization?.id ?? created.json?.data?.id;
  check("org created", !!orgId, `status ${created.status} ${created.text.slice(0, 200)}`);
  if (!orgId) return finish();
  await auth.setActive(inviterJar, orgId);
  check("inviter is owner", (await getMember(orgId, inviterUser!.id))?.role === "owner");

  // ===== 3. Invite a teammate -> branded email in outbox =====
  section("Invite -> branded email");
  const inv = await auth.invite(inviterJar, inviteeEmail, orgId);
  const invitationId = inv.json?.id ?? inv.json?.invitation?.id;
  check("invitation created", !!invitationId, `status ${inv.status} ${inv.text.slice(0, 200)}`);
  const inviteMail = await latestTo(inviteeEmail, "invitation");
  check("invitation email sent to invitee", !!inviteMail);
  check(
    "invitation email is branded HTML",
    !!inviteMail?.html &&
      inviteMail.html.includes("Monora") &&
      inviteMail.html.includes("Accept invitation"),
  );
  check(
    "invitation email links to accept page",
    !!inviteMail?.url && inviteMail.url.includes(`/accept-invitation/${invitationId}`),
  );

  // ===== 4. Already-invited guard =====
  section("Already-invited guard");
  const dup = await auth.invite(inviterJar, inviteeEmail, orgId);
  check("second invite to same email is rejected", dup.status >= 400, `status ${dup.status}`);

  // ===== 5. Resend (tRPC) bumps expiry + re-sends =====
  section("Resend invitation");
  await clearOutbox();
  const before = await getInvitation(invitationId!);
  const resend = await trpcMutate(inviterJar, "members.resendInvitation", {
    invitationId,
  });
  check("resend ok", resend.ok, JSON.stringify(resend.ok ? {} : resend.error));
  const resendMail = await latestTo(inviteeEmail, "invitation");
  check("resend produced a fresh invitation email", !!resendMail);
  const after = await getInvitation(invitationId!);
  check(
    "resend bumped the expiry",
    !!after && !!before && after.expiresAt.getTime() > before.expiresAt.getTime(),
  );

  // ===== 6. Invitee signs in via OTP, then accepts =====
  section("Invitee OTP sign-in + accept");
  const inviteeJar = await otpSignIn(inviteeEmail);
  const inviteeUser = await getUser(inviteeEmail);
  check("invitee account created + verified", !!inviteeUser?.emailVerified);
  const accept = await auth.accept(inviteeJar, invitationId!);
  check("accept ok", accept.status === 200, `status ${accept.status} ${accept.text.slice(0, 200)}`);
  check("invitee is now a member", !!(await getMember(orgId, inviteeUser!.id)));

  // ===== 7. Wrong OTP is rejected =====
  section("Wrong OTP rejected");
  const wjar = newJar();
  await auth.sendOtp(wjar, cancelEmail);
  const wrong = await auth.signInOtp(wjar, cancelEmail, "000000");
  check("invalid code rejected", wrong.status >= 400, `status ${wrong.status}`);

  // ===== 8. Cancel frees re-invite =====
  section("Cancel invitation frees re-invite");
  const inv2 = await auth.invite(inviterJar, cancelEmail, orgId);
  const inv2Id = inv2.json?.id ?? inv2.json?.invitation?.id;
  check("second invitee invited", !!inv2Id, `status ${inv2.status}`);
  const cancel = await trpcMutate(inviterJar, "members.cancelInvitation", {
    invitationId: inv2Id,
  });
  check("cancel ok", cancel.ok, JSON.stringify(cancel.ok ? {} : cancel.error));
  check("invitation row deleted", !(await getInvitation(inv2Id!)));
  const reinvite = await auth.invite(inviterJar, cancelEmail, orgId);
  check("re-invite after cancel succeeds", reinvite.status === 200, `status ${reinvite.status}`);

  // ===== 9. Email mismatch can't accept =====
  section("Email mismatch on accept");
  // inviteeJar (invitee@) tries to accept the invitation addressed to cancel@.
  const mismatchInv = await getInvitation(
    (await db
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.organizationId, orgId), eq(invitation.email, cancelEmail)))
      .limit(1))[0]!.id,
  );
  const mismatch = await auth.accept(inviteeJar, mismatchInv!.id);
  check("accept by wrong account rejected", mismatch.status >= 400, `status ${mismatch.status}`);

  // ===== 10. Password signup requires email verification =====
  section("Password signup requires verification");
  await clearOutbox();
  const pwJar = newJar();
  const signup = await auth.signUpPassword(pwJar, pwEmail, "supersecret", "PW User");
  check("signup accepted", signup.status === 200, `status ${signup.status} ${signup.text.slice(0, 160)}`);
  const verifyMail = await latestTo(pwEmail, "verification");
  check("verification email sent", !!verifyMail);
  check(
    "verification email is branded",
    !!verifyMail?.html && verifyMail.html.includes("Confirm email"),
  );
  const preVerify = await auth.signInPassword(newJar(), pwEmail, "supersecret");
  check("sign-in blocked before verification", preVerify.status >= 400, `status ${preVerify.status}`);
  // Visit the verification link.
  if (verifyMail?.url) {
    await fetch(verifyMail.url, { redirect: "manual" });
  }
  const pwUser = await getUser(pwEmail);
  check("email verified after clicking link", !!pwUser?.emailVerified);
  const postVerify = await auth.signInPassword(newJar(), pwEmail, "supersecret");
  check("sign-in works after verification", postVerify.status === 200, `status ${postVerify.status}`);

  finish();
}

function finish(): never {
  console.log(`\n${"=".repeat(48)}`);
  console.log(`PASS ${passed}   FAIL ${failures.length}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("\nharness crashed:", e);
  process.exit(1);
});
