/**
 * Monora admin CLI - operate the company brain from the terminal (or via Claude
 * Code) instead of the UI. Phase 1: organizations + members + email invites.
 *
 * Runs against whatever DATABASE_URL_OWNER points at (owner role bypasses RLS,
 * which we need to touch the auth tables and, later, domain tables). Locally:
 *   mise exec -- pnpm --filter @monora/app admin <command> [flags]
 * On prod (inside the box, builder image has this source + deps):
 *   docker compose -f docker-compose.prod.yml run --rm admin <command> [flags]
 *
 * Design note: invitations are inserted directly and emailed via Resend with
 * the same /accept-invitation/<id> link Better Auth's UI uses, so accepting
 * goes through Better Auth's normal acceptInvitation flow (it reads the row by
 * id - it does not care that the CLI, not the UI, created it).
 */
import { randomUUID } from "node:crypto";
import { rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createDb,
  makeUnitOfWork,
  brains,
  folders,
  folderAccess,
  brainSnapshots,
} from "@monora/db";
import {
  organization,
  user,
  member,
  invitation,
  session,
  subscription,
} from "@monora/db/auth-schema";
import {
  ensureBrain,
  ensureBrainRootFolder,
  createFolderUseCase,
  importFolderUseCase,
  grantAccess,
  systemClock,
  uuidIdGenerator,
} from "@monora/core";
import { GitShellBackend } from "@monora/git";
import { Resend } from "resend";
import { and, eq, inArray, like, or } from "drizzle-orm";

// ---------- env ----------
const DBURL = process.env.DATABASE_URL_OWNER;
if (!DBURL) {
  console.error("DATABASE_URL_OWNER is required (owner role bypasses RLS).");
  process.exit(1);
}
const db = createDb(DBURL);
const APP_URL =
  process.env.BETTER_AUTH_URL ??
  process.env.PUBLIC_APP_URL ??
  process.env.APP_BASE_URL ??
  "http://localhost:3000";
const isDev = process.env.NODE_ENV === "development";

// ---------- tiny flag parser ----------
// Usage: admin <command> --key value --flag (boolean)
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function need(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`missing required --${key}`);
  }
  return v.trim();
}

// ---------- resolvers ----------
async function resolveOrg(ref: string) {
  const [org] = await db
    .select()
    .from(organization)
    .where(or(eq(organization.id, ref), eq(organization.slug, ref)));
  if (!org) throw new Error(`org not found: ${ref} (by id or slug)`);
  return org;
}

async function resolveUser(email: string) {
  const [u] = await db
    .select()
    .from(user)
    .where(eq(user.email, email.toLowerCase()));
  return u ?? null;
}

async function ownerOf(orgId: string) {
  const [m] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")));
  return m?.userId ?? null;
}

// ---------- commands ----------
async function orgCreate(flags: Record<string, string | boolean>) {
  const name = need(flags, "name");
  const slug = need(flags, "slug");

  let [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, slug));
  if (org) {
    console.log(`org exists: ${org.name} (${org.slug}) id=${org.id}`);
  } else {
    const id = `org_${randomUUID()}`;
    [org] = await db
      .insert(organization)
      .values({ id, name, slug })
      .returning();
    console.log(`created org: ${org!.name} (${org!.slug}) id=${org!.id}`);
  }

  if (typeof flags.owner === "string") {
    await memberAdd({
      org: org!.id,
      email: flags.owner,
      role: "owner",
      activate: true,
    });
  }
}

async function orgList() {
  const orgs = await db.select().from(organization);
  if (!orgs.length) return console.log("(no organizations)");
  for (const o of orgs) {
    const members = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.organizationId, o.id));
    console.log(
      `${o.slug ?? "-"}\t${o.name}\t${members.length} member(s)\tid=${o.id}`,
    );
  }
}

async function memberAdd(opts: {
  org: string;
  email: string;
  role?: string;
  activate?: boolean;
}) {
  const org = await resolveOrg(opts.org);
  const role = opts.role ?? "member";
  const u = await resolveUser(opts.email);
  if (!u) {
    throw new Error(
      `no user with email ${opts.email}. They must sign in once (creates the user), or use \`invite\` to email them.`,
    );
  }

  const [existing] = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, org.id), eq(member.userId, u.id)));
  if (existing) {
    if (existing.role !== role) {
      await db
        .update(member)
        .set({ role })
        .where(eq(member.id, existing.id));
      console.log(`updated ${u.email} role -> ${role} in ${org.slug}`);
    } else {
      console.log(`already a member: ${u.email} (${role}) in ${org.slug}`);
    }
  } else {
    await db.insert(member).values({
      id: `mem_${randomUUID()}`,
      organizationId: org.id,
      userId: u.id,
      role,
    });
    console.log(`added ${u.email} as ${role} to ${org.slug}`);
  }

  // Better Auth's afterAddMember hook (which grants the Monora Guide) does NOT
  // fire for members inserted here, so do it explicitly - otherwise CLI-added
  // members open the guide brain to an empty page.
  await grantGuideRead(org.id, u.id);

  if (opts.activate) {
    // Point the user's sessions at this org so they land in it without needing
    // the org switcher.
    await db
      .update(session)
      .set({ activeOrganizationId: org.id })
      .where(eq(session.userId, u.id));
    console.log(`set ${u.email}'s active org -> ${org.slug}`);
  }
}

async function memberList(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const rows = await db
    .select({
      email: user.email,
      name: user.name,
      role: member.role,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, org.id));
  if (!rows.length) return console.log(`(no members in ${org.slug})`);
  for (const r of rows) {
    console.log(`${r.role}\t${r.email}\t${r.name}`);
  }
}

async function memberRole(flags: Record<string, string | boolean>) {
  await memberAdd({
    org: need(flags, "org"),
    email: need(flags, "email"),
    role: need(flags, "role"),
  });
}

// Platform-wide role (global user.role), NOT an org membership. "admin" makes
// the user a whole-app superadmin (the /admin dashboard); "none" clears it.
async function userRole(flags: Record<string, string | boolean>) {
  const email = need(flags, "email").toLowerCase();
  const role = need(flags, "role");
  const u = await resolveUser(email);
  if (!u) {
    throw new Error(
      `no user with email ${email}. They must sign in once before they can be made a platform admin.`,
    );
  }
  const next = role === "none" ? null : role;
  await db.update(user).set({ role: next }).where(eq(user.id, u.id));
  console.log(`set ${u.email} platform role -> ${next ?? "(none)"}`);
}

async function invite(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const email = need(flags, "email").toLowerCase();
  const role = typeof flags.role === "string" ? flags.role : "member";

  // inviter: explicit --inviter <email>, else the org's owner.
  let inviterId: string | null;
  if (typeof flags.inviter === "string") {
    const u = await resolveUser(flags.inviter);
    if (!u) throw new Error(`inviter not found: ${flags.inviter}`);
    inviterId = u.id;
  } else {
    inviterId = await ownerOf(org.id);
  }
  if (!inviterId) {
    throw new Error(
      `no inviter: org ${org.slug} has no owner. Pass --inviter <email> of an existing user.`,
    );
  }

  const id = `inv_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(invitation).values({
    id,
    organizationId: org.id,
    email,
    role,
    status: "pending",
    expiresAt,
    inviterId,
  });

  const url = `${APP_URL}/accept-invitation/${id}`;
  if (isDev) {
    console.log(`[DEV] invitation for ${email} -> ${url}`);
  } else {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.log(
        `invitation row created but RESEND_API_KEY is unset; share this link manually:\n${url}`,
      );
    } else {
      const resend = new Resend(key);
      await resend.emails.send({
        from: "Monora <noreply@monora.ai>",
        to: [email],
        subject: `You're invited to ${org.name} on Monora`,
        text: `You've been invited to join ${org.name} on Monora.\n\nAccept the invitation: ${url}\n\nIf you didn't expect this, you can ignore this email.`,
      });
      console.log(`invited ${email} (${role}) to ${org.slug}; email sent.`);
    }
  }
}

// Comp (courtesy) subscription: grant a whole org full access with no Stripe,
// no payment. One row keyed to the org clears the per-org paywall for every
// member. The `comp_` stripeSubscriptionId marks it so the app never calls
// Stripe for it and it can be wiped in one query when real billing takes over.
async function comp(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const plan = typeof flags.plan === "string" ? flags.plan : "teams";
  const seats =
    typeof flags.seats === "string" && Number(flags.seats) > 0
      ? Number(flags.seats)
      : 999;

  const [existing] = await db
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.referenceId, org.id),
        like(subscription.stripeSubscriptionId, "comp_%"),
      ),
    );

  if (existing) {
    await db
      .update(subscription)
      .set({ plan, status: "active", seats })
      .where(eq(subscription.id, existing.id));
    console.log(`updated comp for ${org.slug}: plan=${plan} seats=${seats}`);
  } else {
    await db.insert(subscription).values({
      id: `sub_${randomUUID()}`,
      plan,
      referenceId: org.id,
      stripeSubscriptionId: `comp_${randomUUID()}`,
      status: "active",
      seats,
    });
    console.log(`comped ${org.slug}: plan=${plan} seats=${seats} (no Stripe)`);
  }
}

async function uncomp(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const deleted = await db
    .delete(subscription)
    .where(
      and(
        eq(subscription.referenceId, org.id),
        like(subscription.stripeSubscriptionId, "comp_%"),
      ),
    )
    .returning({ id: subscription.id });
  console.log(`removed ${deleted.length} comp subscription(s) from ${org.slug}`);
}

// ---------- repo identity migration ----------
// Repos are now keyed by brain id (`<brainId>/<folderSlug>.git`), org-independent.
// Brains created under the old scheme have `<orgId>/<brainSlug>/<folderSlug>.git`
// repo names and on-disk dirs. This one-off rewrites every folder's repo_name to
// the new form and moves its bare repo on disk to match. Idempotent: a folder
// already in the new form is skipped, so it is safe to re-run. Owner role bypasses
// RLS, so we sweep folders across all orgs directly.
async function brainRelocateRepos(flags: Record<string, string | boolean>) {
  const gitRoot = path.resolve(process.env.GIT_ROOT ?? "/data/git");
  const dryRun = flags["dry-run"] === true;
  const all = await db
    .select({ id: folders.id, brainId: folders.brainId, slug: folders.slug, repoName: folders.repoName })
    .from(folders);
  let moved = 0;
  let skipped = 0;
  for (const f of all) {
    const next = `${f.brainId}/${f.slug}.git`;
    if (f.repoName === next) {
      skipped++;
      continue;
    }
    const oldDir = path.resolve(gitRoot, f.repoName);
    const newDir = path.resolve(gitRoot, next);
    // Defensive: both must stay under gitRoot (no traversal via a bad row).
    if (!oldDir.startsWith(gitRoot + path.sep) || !newDir.startsWith(gitRoot + path.sep)) {
      throw new Error(`path escapes GIT_ROOT for folder ${f.id}: ${f.repoName} -> ${next}`);
    }
    console.log(`${dryRun ? "[dry] " : ""}${f.repoName}  ->  ${next}`);
    if (dryRun) continue;
    // Move the bare repo if it exists on disk (a row may predate its repo).
    const hasOld = await stat(oldDir).then(() => true).catch(() => false);
    const hasNew = await stat(newDir).then(() => true).catch(() => false);
    if (hasOld && !hasNew) {
      await mkdir(path.dirname(newDir), { recursive: true });
      await rename(oldDir, newDir);
    } else if (!hasOld && !hasNew) {
      console.log(`  WARN: no bare repo at ${oldDir} (row updated anyway)`);
    }
    await db.update(folders).set({ repoName: next }).where(eq(folders.id, f.id));
    moved++;
  }
  console.log(`relocate done: ${moved} moved, ${skipped} already current (of ${all.length})`);
}

// brain:move --brain <id> --to-org <slug|id>
// Move a whole brain (and its folders, ACL rows and snapshots) to another org.
// Because repos are keyed by brain id, this is purely a re-pointing of org_id -
// no repo name changes, nothing moves on disk. Access follows org membership, so
// members of the source org lose sight of the brain and members of the target
// org gain it (subject to their folder grants, which travel with the move).
async function brainMove(flags: Record<string, string | boolean>) {
  const brainId = need(flags, "brain");
  const toOrg = await resolveOrg(need(flags, "to-org"));
  const [brain] = await db.select().from(brains).where(eq(brains.id, brainId));
  if (!brain) throw new Error(`brain not found: ${brainId}`);
  if (brain.orgId === toOrg.id) {
    console.log(`brain ${brain.slug} (${brainId}) is already in ${toOrg.slug}`);
    return;
  }
  const from = brain.orgId;
  // Re-key every table that carries the org pointer for this brain's data.
  await db.update(brains).set({ orgId: toOrg.id }).where(eq(brains.id, brainId));
  const f = await db.update(folders).set({ orgId: toOrg.id }).where(eq(folders.brainId, brainId)).returning({ id: folders.id });
  const movedFolderIds = f.map((r) => r.id);
  if (movedFolderIds.length) {
    await db.update(folderAccess).set({ orgId: toOrg.id }).where(inArray(folderAccess.folderId, movedFolderIds));
  }
  await db.update(brainSnapshots).set({ orgId: toOrg.id }).where(eq(brainSnapshots.brainId, brainId));
  console.log(`moved brain ${brain.slug} (${brainId}) from ${from} -> ${toOrg.slug} (${toOrg.id})`);
  console.log(`  re-keyed ${movedFolderIds.length} folder(s) + their access rows + snapshots`);
}

// ---------- brain commands ----------
// These touch the domain tables (brains/folders/folder_access) through the core
// use-cases - the same path the app and the ingest CLI use - so a folder is a
// real bare repo + ACL row, not a hand-written insert. We run with the owner DB
// role (RLS bypassed), so the tenant binding is bookkeeping, not the guard here.
function brainDeps() {
  const gitRoot = process.env.GIT_ROOT ?? "/tmp/monora-git";
  return {
    uow: makeUnitOfWork(db),
    git: new GitShellBackend({ gitRoot }),
    ids: uuidIdGenerator,
    clock: systemClock,
  };
}

/** "slug:Human Name" | "slug" (name derived) - comma-separated in --folders. */
function parseFolderSpecs(spec: string): { slug: string; name: string }[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      const slug = (i >= 0 ? s.slice(0, i) : s).trim();
      const name =
        i >= 0 && s.slice(i + 1).trim()
          ? s.slice(i + 1).trim()
          : slug.replace(/[-/]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return { slug, name };
    });
}

// brain:create --org <ref> --name <Name> [--folders "slug:Name,slug2"] [--owner <email>]
// Grants the owner (explicit --owner, else the org's owner) admin on each new
// folder; the model grants nothing by default, so without this the brain is
// invisible to everyone until shared.
async function brainCreate(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const name = need(flags, "name");
  const deps = brainDeps();

  const brainRes = await ensureBrain(deps)({ orgId: org.id, name });
  if (!brainRes.ok) throw new Error(`ensureBrain: ${brainRes.error.message}`);
  const brain = brainRes.value;
  console.log(`brain ready: ${brain.name} (${brain.slug}) id=${brain.id}`);

  let ownerUserId: string | null;
  let ownerLabel: string;
  if (typeof flags.owner === "string") {
    const u = await resolveUser(flags.owner);
    if (!u)
      throw new Error(
        `no user with email ${flags.owner} (they must sign in once first).`,
      );
    ownerUserId = u.id;
    ownerLabel = flags.owner;
  } else {
    ownerUserId = await ownerOf(org.id);
    ownerLabel = "org owner";
  }

  // Every brain gets its shared root folder (`_root`), like the proxy's /brains.
  const rootRes = await ensureBrainRootFolder(deps)({
    orgId: org.id,
    brainId: brain.id,
    ownerUserId,
    actorId: ownerUserId,
  });
  if (!rootRes.ok) throw new Error(`ensure root: ${rootRes.error.message}`);
  console.log(`  root folder ${rootRes.value.repoName} (owner: ${ownerLabel})`);

  const specs =
    typeof flags.folders === "string" ? parseFolderSpecs(flags.folders) : [];
  if (!specs.length) return;

  const createFolder = createFolderUseCase(deps);
  const grant = grantAccess(deps);
  for (const f of specs) {
    const r = await createFolder({
      orgId: org.id,
      brainId: brain.id,
      name: f.name,
      slug: f.slug,
    });
    if (!r.ok) throw new Error(`folder ${f.slug}: ${r.error.message}`);
    console.log(`  folder ${r.value.repoName} -> ${r.value.path}`);
    if (ownerUserId) {
      const g = await grant({
        orgId: org.id,
        folderId: r.value.id,
        userId: ownerUserId,
        permission: "admin",
        actorId: ownerUserId,
      });
      if (!g.ok) throw new Error(`grant ${f.slug}: ${g.error.message}`);
    }
  }
  console.log(
    ownerUserId
      ? `granted ${ownerLabel} admin on ${specs.length} folder(s)`
      : `WARNING: no owner to grant - ${specs.length} folder(s) are unshared (invisible until granted)`,
  );
}

// brain:list --org <ref>
async function brainList(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const deps = brainDeps();
  const rows = await deps.uow.run(org.id, async (repos) => {
    const brains = await repos.brains.listByOrg();
    return Promise.all(
      brains.map(async (b) => ({
        b,
        folders: (await repos.folders.listByBrain(b.id)).length,
      })),
    );
  });
  if (!rows.length) return console.log(`(no brains in ${org.slug})`);
  for (const { b, folders } of rows) {
    console.log(`${b.slug}\t${b.name}\t${folders} folder(s)\tid=${b.id}`);
  }
}

// brain:ensure-roots --org <ref> [--owner <email>]
// Backfill the per-brain root folder (mounts at the brain root) for every brain
// in the org that lacks one. Idempotent. Grants the owner (explicit --owner,
// else the org owner) admin on each root so the brain stays visible.
async function brainEnsureRoots(flags: Record<string, string | boolean>) {
  const org = await resolveOrg(need(flags, "org"));
  const deps = brainDeps();

  let ownerUserId: string | null;
  if (typeof flags.owner === "string") {
    const u = await resolveUser(flags.owner);
    if (!u) throw new Error(`no user with email ${flags.owner}`);
    ownerUserId = u.id;
  } else {
    ownerUserId = await ownerOf(org.id);
  }

  const brains = await deps.uow.run(org.id, (repos) => repos.brains.listByOrg());
  const ensureRoot = ensureBrainRootFolder(deps);
  for (const b of brains) {
    const r = await ensureRoot({
      orgId: org.id,
      brainId: b.id,
      ownerUserId,
      actorId: ownerUserId,
    });
    if (!r.ok) throw new Error(`brain ${b.slug}: ${r.error.message}`);
    console.log(`  ${b.slug}: root folder ${r.value.repoName}`);
  }
  console.log(
    `ensured root folder on ${brains.length} brain(s)${ownerUserId ? "" : " (unshared - no owner)"}`,
  );
}

// brain:seed-guide [--org <ref>] [--all]
// Backfill the default "Monora Guide" brain into orgs that predate the seeding
// hook (or whose seeding failed). Mirrors src/server/seed-default-brain.ts:
// ensure the `monora-guide` brain + `guide` folder (ingesting the shipped seed
// snapshot once), then grant READ to every current member. Idempotent: existing
// brains are reused; re-running only tops up the read grants.
const GUIDE_BRAIN_NAME = "Monora Guide";
const GUIDE_BRAIN_SLUG = "monora-guide";
const GUIDE_FOLDER_SLUG = "guide";

function guideSeedDir(): string {
  return (
    process.env.DEFAULT_BRAIN_SEED_DIR ??
    path.resolve(process.cwd(), "../../seed/default-brain")
  );
}

/** The guide folder's id if the `monora-guide` brain + `guide` folder exist. */
async function findGuideFolderId(orgId: string): Promise<string | null> {
  const deps = brainDeps();
  return deps.uow.run(orgId, async (repos) => {
    const brains = await repos.brains.listByOrg();
    const brain = brains.find((b) => b.slug === GUIDE_BRAIN_SLUG);
    if (!brain) return null;
    const folders = await repos.folders.listByBrain(brain.id);
    return folders.find((f) => f.slug === GUIDE_FOLDER_SLUG)?.id ?? null;
  });
}

/** Grant one user READ on the org's Monora Guide folder. Mirrors the
 *  `afterAddMember` Better Auth hook for members added via this CLI (which
 *  inserts the `member` row directly and so never fires that hook). Idempotent;
 *  no-op with a hint if the guide brain isn't seeded yet. */
async function grantGuideRead(orgId: string, userId: string): Promise<void> {
  const folderId = await findGuideFolderId(orgId);
  if (!folderId) {
    console.warn(
      "note: no Monora Guide brain in this org yet - run `brain:seed-guide --org <ref>` to give members the guide.",
    );
    return;
  }
  const g = await grantAccess(brainDeps())({
    orgId,
    folderId,
    userId,
    permission: "read",
    actorId: userId,
  });
  if (!g.ok) throw new Error(`grant guide: ${g.error.message}`);
}

async function seedGuideForOrg(orgId: string, orgSlug: string) {
  const deps = brainDeps();

  // Find the guide folder if the brain already exists in this org.
  let folderId = await findGuideFolderId(orgId);

  if (!folderId) {
    const brainRes = await ensureBrain(deps)({
      orgId,
      name: GUIDE_BRAIN_NAME,
    });
    if (!brainRes.ok) throw new Error(`ensureBrain: ${brainRes.error.message}`);
    const imp = await importFolderUseCase(deps)({
      orgId,
      brainId: brainRes.value.id,
      name: "Guide",
      slug: GUIDE_FOLDER_SLUG,
      path: GUIDE_FOLDER_SLUG,
      sourceDir: guideSeedDir(),
      excludeMedia: true,
      message: "seed Monora guide",
    });
    if (!imp.ok) throw new Error(`importFolder: ${imp.error.message}`);
    folderId = imp.value.folder.id;
    console.log(`${orgSlug}: created guide brain + folder ${imp.value.folder.repoName}`);
  } else {
    console.log(`${orgSlug}: guide brain already present`);
  }

  // Grant read to every current member (the hook only grants on join, so a
  // backfill must catch everyone already in the org).
  const members = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, orgId));
  const grant = grantAccess(deps);
  for (const m of members) {
    const g = await grant({
      orgId,
      folderId,
      userId: m.userId,
      permission: "read",
      actorId: m.userId,
    });
    if (!g.ok) throw new Error(`grant ${m.userId}: ${g.error.message}`);
  }
  console.log(`${orgSlug}: read granted to ${members.length} member(s)`);
}

async function brainSeedGuide(flags: Record<string, string | boolean>) {
  if (flags.all === true) {
    const orgs = await db.select().from(organization);
    for (const o of orgs) {
      await seedGuideForOrg(o.id, o.slug ?? o.id);
    }
    console.log(`done: processed ${orgs.length} org(s)`);
    return;
  }
  const org = await resolveOrg(need(flags, "org"));
  await seedGuideForOrg(org.id, org.slug ?? org.id);
}

// ---------- dispatch ----------
const HELP = `Monora admin CLI

Commands:
  org:create   --name <name> --slug <slug> [--owner <email>]
  org:list
  member:add   --org <slug|id> --email <email> [--role owner|admin|member] [--activate]
  member:list  --org <slug|id>
  member:role  --org <slug|id> --email <email> --role <role>
  brain:create --org <slug|id> --name <Name> [--folders "slug:Name,slug2"] [--owner <email>]
  brain:list   --org <slug|id>
  brain:ensure-roots --org <slug|id> [--owner <email>]   (backfill per-brain root folders)
  brain:seed-guide [--org <slug|id> | --all]             (backfill the default "Monora Guide" brain + read grants)
  brain:relocate-repos [--dry-run]                       (one-off: re-key repos to <brainId>/<slug>.git + move on disk)
  brain:move   --brain <id> --to-org <slug|id>           (move a brain to another org; org_id only, no disk change)
  invite       --org <slug|id> --email <email> [--role member|admin] [--inviter <email>]
  user:role    --email <email> --role admin|none   (platform-wide superadmin)
  comp         --org <slug|id> [--plan teams|starter] [--seats N]   (free full access, no Stripe)
  uncomp       --org <slug|id>                                      (remove the comp)
`;

async function main() {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "org:create":
      return orgCreate(flags);
    case "org:list":
      return orgList();
    case "member:add":
      return memberAdd({
        org: need(flags, "org"),
        email: need(flags, "email"),
        role: typeof flags.role === "string" ? flags.role : undefined,
        activate: flags.activate === true,
      });
    case "member:list":
      return memberList(flags);
    case "member:role":
      return memberRole(flags);
    case "brain:create":
      return brainCreate(flags);
    case "brain:list":
      return brainList(flags);
    case "brain:ensure-roots":
      return brainEnsureRoots(flags);
    case "brain:seed-guide":
      return brainSeedGuide(flags);
    case "brain:relocate-repos":
      return brainRelocateRepos(flags);
    case "brain:move":
      return brainMove(flags);
    case "user:role":
      return userRole(flags);
    case "invite":
      return invite(flags);
    case "comp":
      return comp(flags);
    case "uncomp":
      return uncomp(flags);
    case undefined:
    case "help":
    case "--help":
      return console.log(HELP);
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
