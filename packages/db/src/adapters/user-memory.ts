import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB, Tx } from "../client";
import { makeWithTenant } from "../tenant";
import {
  userMemoryEvents,
  userMemoryObservations,
  userMemoryReflections,
  userMemorySettings,
} from "../schema";

export type MemoryEventType =
  | "brain.created"
  | "folder.browsed"
  | "file.read"
  | "folder.created"
  | "folder.archived"
  | "folder.restored"
  | "key.issued"
  | "key.revoked";

export interface DreamBrief {
  briefId: string;
  title: string;
  instructions: string;
  observations: { id: string; body: string; createdAt: Date }[];
}

type MemoryTx = Pick<Tx, "select" | "insert" | "update" | "delete">;

async function isEnabled(tx: MemoryTx, orgId: string, userId: string) {
  const [row] = await tx
    .select({ enabled: userMemorySettings.enabled })
    .from(userMemorySettings)
    .where(
      and(
        eq(userMemorySettings.orgId, orgId),
        eq(userMemorySettings.userId, userId),
      ),
    )
    .limit(1);
  return row?.enabled ?? true;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function observationFor(event: {
  eventType: string;
  metadata: Record<string, unknown> | null;
}): string {
  const m = event.metadata ?? {};
  const brain = str(m.brainName) ?? str(m.brainId) ?? "a brain";
  const folder = str(m.folderName) ?? str(m.folderId) ?? "a folder";
  const path = str(m.path);
  const keyName = str(m.keyName) ?? "a key";

  switch (event.eventType) {
    case "brain.created":
      return `You created Brain ${brain}.`;
    case "folder.browsed":
      return path
        ? `You browsed ${path} in ${folder}.`
        : `You browsed ${folder}.`;
    case "file.read":
      return path
        ? `You read ${path} in ${folder}.`
        : `You read a file in ${folder}.`;
    case "folder.created":
      return `You created folder ${folder} in Brain ${brain}.`;
    case "folder.archived":
      return `You archived folder ${folder}.`;
    case "folder.restored":
      return `You restored folder ${folder}.`;
    case "key.issued":
      return `You issued key ${keyName}.`;
    case "key.revoked":
      return `You revoked key ${keyName}.`;
    default:
      return `You used ${event.eventType}.`;
  }
}

export async function getUserMemorySettings(
  tx: MemoryTx,
  orgId: string,
  userId: string,
) {
  return { enabled: await isEnabled(tx, orgId, userId) };
}

export async function updateUserMemorySettings(
  tx: MemoryTx,
  orgId: string,
  userId: string,
  enabled: boolean,
) {
  const now = new Date();
  await tx
    .insert(userMemorySettings)
    .values({ orgId, userId, enabled, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [userMemorySettings.orgId, userMemorySettings.userId],
      set: { enabled, updatedAt: now },
    });
  return { enabled };
}

export async function recordUserMemoryEvent(
  tx: MemoryTx,
  input: {
    orgId: string;
    userId: string;
    actorUserId?: string | null;
    eventType: MemoryEventType;
    metadata?: Record<string, unknown>;
    observedAt?: Date;
  },
) {
  if (!(await isEnabled(tx, input.orgId, input.userId))) return null;
  const [row] = await tx
    .insert(userMemoryEvents)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      actorUserId: input.actorUserId ?? input.userId,
      eventType: input.eventType,
      metadata: input.metadata ?? null,
      observedAt: input.observedAt ?? new Date(),
    })
    .returning({ id: userMemoryEvents.id });
  return row ?? null;
}

export async function processPendingUserMemoryEvents(
  tx: MemoryTx,
  orgId: string,
  userId: string,
  limit = 100,
) {
  const rows = await tx
    .select({
      id: userMemoryEvents.id,
      eventType: userMemoryEvents.eventType,
      metadata: userMemoryEvents.metadata,
    })
    .from(userMemoryEvents)
    .where(
      and(
        eq(userMemoryEvents.orgId, orgId),
        eq(userMemoryEvents.userId, userId),
        isNull(userMemoryEvents.processedAt),
      ),
    )
    .orderBy(asc(userMemoryEvents.observedAt))
    .limit(limit);

  if (!rows.length) return { processed: 0 };

  const now = new Date();
  let processed = 0;
  for (const row of rows) {
    const claimed = await tx
      .update(userMemoryEvents)
      .set({ processedAt: now })
      .where(
        and(
          eq(userMemoryEvents.id, row.id),
          eq(userMemoryEvents.orgId, orgId),
          eq(userMemoryEvents.userId, userId),
          isNull(userMemoryEvents.processedAt),
        ),
      )
      .returning({ id: userMemoryEvents.id });
    if (!claimed.length) continue;
    processed += 1;
    await tx.insert(userMemoryObservations).values({
      orgId,
      userId,
      body: observationFor(row),
      sourceEventIds: [row.id],
      status: "active",
      createdAt: now,
    });
  }
  return { processed };
}

export async function createUserDreamBrief(
  tx: MemoryTx,
  orgId: string,
  userId: string,
): Promise<DreamBrief> {
  await processPendingUserMemoryEvents(tx, orgId, userId);
  const observations = await tx
    .select({
      id: userMemoryObservations.id,
      body: userMemoryObservations.body,
      createdAt: userMemoryObservations.createdAt,
    })
    .from(userMemoryObservations)
    .where(
      and(
        eq(userMemoryObservations.orgId, orgId),
        eq(userMemoryObservations.userId, userId),
        eq(userMemoryObservations.status, "active"),
      ),
    )
    .orderBy(desc(userMemoryObservations.createdAt))
    .limit(25);

  return {
    briefId: randomUUID(),
    title: "Private memory dream",
    observations,
    instructions: [
      "You are helping this user reflect on their private Monora activity.",
      "Use only the observations in this brief.",
      "Return a concise markdown reflection with useful patterns, reminders, and possible follow-up actions.",
    ].join("\n"),
  };
}

export async function recordUserMemoryReflection(
  tx: MemoryTx,
  input: {
    orgId: string;
    userId: string;
    briefId: string;
    title: string;
    bodyMarkdown: string;
    sourceObservationIds: string[];
    proposedActions?: string[];
    promptMetadata?: Record<string, unknown>;
  },
) {
  const sourceObservationIds = input.sourceObservationIds.length
    ? (
        await tx
          .select({ id: userMemoryObservations.id })
          .from(userMemoryObservations)
          .where(
            and(
              eq(userMemoryObservations.orgId, input.orgId),
              eq(userMemoryObservations.userId, input.userId),
              inArray(userMemoryObservations.id, input.sourceObservationIds),
            ),
          )
      ).map((row) => row.id)
    : [];

  const [row] = await tx
    .insert(userMemoryReflections)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      briefId: input.briefId,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      sourceObservationIds,
      proposedActions: input.proposedActions ?? null,
      promptMetadata: input.promptMetadata ?? null,
    })
    .returning({ id: userMemoryReflections.id });
  return row;
}

export async function deleteUserMemory(tx: MemoryTx, orgId: string, userId: string) {
  await tx
    .delete(userMemoryReflections)
    .where(
      and(
        eq(userMemoryReflections.orgId, orgId),
        eq(userMemoryReflections.userId, userId),
      ),
    );
  await tx
    .delete(userMemoryObservations)
    .where(
      and(
        eq(userMemoryObservations.orgId, orgId),
        eq(userMemoryObservations.userId, userId),
      ),
    );
  await tx
    .delete(userMemoryEvents)
    .where(
      and(eq(userMemoryEvents.orgId, orgId), eq(userMemoryEvents.userId, userId)),
    );
  return { ok: true as const };
}

export interface UserMemoryStore {
  createDreamBriefForUser(input: {
    orgId: string;
    userId: string;
  }): Promise<DreamBrief>;
  recordReflectionForUser(input: {
    orgId: string;
    userId: string;
    briefId: string;
    title: string;
    bodyMarkdown: string;
    sourceObservationIds: string[];
    proposedActions?: string[];
    promptMetadata?: Record<string, unknown>;
  }): Promise<{ id: string } | undefined>;
}

export function makeUserMemoryStore(db: DB): UserMemoryStore {
  const withTenant = makeWithTenant(db);
  const bindUser = (tx: Tx, userId: string) =>
    tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
  return {
    createDreamBriefForUser: ({ orgId, userId }) =>
      withTenant(orgId, async (tx) => {
        await bindUser(tx, userId);
        return createUserDreamBrief(tx, orgId, userId);
      }),
    recordReflectionForUser: (input) =>
      withTenant(input.orgId, async (tx) => {
        await bindUser(tx, input.userId);
        return recordUserMemoryReflection(tx, input);
      }),
  };
}
