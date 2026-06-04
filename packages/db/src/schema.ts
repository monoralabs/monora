import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  pgRole,
  pgPolicy,
  text,
  uuid,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { BrainSnapshotEntry } from "@monora/core";
import { organization, user } from "./auth-schema";

/**
 * Domain tables (tenant-scoped). Auth/orgs/members/invitations live in
 * auth-schema.ts (Better Auth). Here we model the Drive hierarchy Monora is
 * about: Brain (a workspace) -> Folder (the per-repo unit of access) -> files
 * (in git, not modeled here). Plus the folder ACL and the audit trail. Every
 * row carries org_id + RLS from day one.
 *
 * org_id is TEXT because Better Auth uses text IDs (organization.id is text).
 */

/** The role the running app connects as (DATABASE_URL). NON-superuser and NOT
 *  the table owner, so RLS is enforced. Created by init/00-bootstrap.sql. */
export const appRole = pgRole("app_user").existing();

/** Tenant-isolation policy: a row is only visible/writable when its org_id
 *  matches the org bound to the current transaction (SET LOCAL, see tenant.ts). */
const tenantPolicy = (name: string) =>
  pgPolicy(name, {
    as: "permissive",
    for: "all",
    to: appRole,
    using: sql`org_id = current_setting('app.current_org_id', true)`,
    withCheck: sql`org_id = current_setting('app.current_org_id', true)`,
  });

export const permission = pgEnum("permission", ["read", "write", "admin"]);

/** A brain = a workspace / shared drive inside an org. Groups folders. */
export const brains = pgTable(
  "brains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("brains_org_slug_uniq").on(t.orgId, t.slug),
    tenantPolicy("brains_tenant_isolation"),
  ],
).enableRLS();

/** A folder = the unit of access. One folder = one bare git repo. */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brainId: uuid("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    /** The folder this nests under (self-FK), or null for a top-level folder.
     *  Each folder is still its own repo + ACL; this is structure only. */
    parentFolderId: uuid("parent_folder_id").references(
      (): AnyPgColumn => folders.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Mount point in the composed workspace tree. */
    path: text("path").notNull(),
    /** Bare repo identity: <brainId>/<folderSlug>.git (org-independent, so
     *  moving a brain between orgs never rewrites this or moves the repo). */
    repoName: text("repo_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** Where this folder came from: a user-created folder vs one materialized by
     *  the ingest job. Lets re-ingest tell its own folders apart and lets a
     *  delete of an ingest folder also mean "stop producing it". */
    source: text("source").notNull().default("user"),
    /** Soft-delete tombstone (the recoverable trash). When set, the folder is
     *  hidden from the manifest and inert at the git chokepoint, but its bare
     *  repo is never physically removed - restore just clears these two and the
     *  folder comes back with full history. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: text("archived_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("folders_brain_slug_uniq").on(t.brainId, t.slug),
    uniqueIndex("folders_org_repo_uniq").on(t.orgId, t.repoName),
    index("folders_brain_idx").on(t.brainId),
    tenantPolicy("folders_tenant_isolation"),
  ],
).enableRLS();

/** The ACL row (per folder, per user). Today a dumb table; tomorrow OpenFGA.
 *  The authz adapter reads this, so swapping the backend is a single-file change. */
export const folderAccess = pgTable(
  "folder_access",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    permission: permission("permission").notNull().default("read"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("folder_access_uniq").on(t.folderId, t.userId),
    index("folder_access_user_idx").on(t.orgId, t.userId),
    tenantPolicy("folder_access_tenant_isolation"),
  ],
).enableRLS();

/** A brain version: a point-in-time record of every folder + its branch tip,
 *  so the whole brain can be rolled back (the "undo" for agentic edits). The
 *  per-folder commit shas live in `entries` (jsonb); git keeps the actual data. */
export const brainSnapshots = pgTable(
  "brain_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brainId: uuid("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    label: text("label"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    entries: jsonb("entries").$type<BrainSnapshotEntry[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("brain_snapshots_brain_idx").on(t.orgId, t.brainId, t.createdAt),
    tenantPolicy("brain_snapshots_tenant_isolation"),
  ],
).enableRLS();

/** Git + MCP credentials for a principal (user or agent). The plaintext is
 *  shown once at issue; only `hashed_secret` + the public `token_prefix` (the
 *  proxy's lookup key) are stored. */
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    hashedSecret: text("hashed_secret").notNull(),
    scopes: jsonb("scopes").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("access_tokens_prefix_idx").on(t.tokenPrefix),
    index("access_tokens_subject_idx").on(t.orgId, t.subjectId),
    tenantPolicy("access_tokens_tenant_isolation"),
  ],
).enableRLS();

/** Append-only audit trail. Every authz-relevant action lands here. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
    tenantPolicy("audit_log_tenant_isolation"),
  ],
).enableRLS();

/**
 * Device Authorization Grant (RFC 8628) for the connector CLI: lets a machine
 * obtain an access token without the user ever pasting one on the command line.
 *
 * The CLI requests a flow (proxy mints `device_code` + `user_code`), the user
 * approves it in the browser where they're logged in (which stamps `user_id` +
 * `org_id`), and the CLI then exchanges the `device_code` for a freshly minted
 * access token. The token plaintext is NEVER stored - it's minted at claim time
 * from the approved user/org and handed straight to the CLI.
 *
 * Deliberately NOT tenant-scoped / NO RLS: the flow starts anonymous (no org
 * yet), and rows are looked up by the secret `device_code` (CLI) or the short
 * `user_code` (an authenticated approver), not by tenant.
 */
export const deviceStatus = pgEnum("device_flow_status", [
  "pending",
  "approved",
  "claimed",
  "denied",
]);

export const deviceFlows = pgTable(
  "device_flows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // High-entropy secret held only by the requesting CLI.
    deviceCode: text("device_code").notNull(),
    // Short, human-typable code the user confirms in the browser.
    userCode: text("user_code").notNull(),
    status: deviceStatus("status").notNull().default("pending"),
    // Null until approved; then the subject the token is minted for.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("device_flows_device_code_uniq").on(t.deviceCode),
    uniqueIndex("device_flows_user_code_uniq").on(t.userCode),
  ],
);
