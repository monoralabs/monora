import { and, eq, gt } from "drizzle-orm";
import type { DB, Tx } from "../client";
import { deviceFlows } from "../schema";

export type DeviceFlowRow = typeof deviceFlows.$inferSelect;

/**
 * Data access for the Device Authorization Grant (RFC 8628). NOT tenant-scoped
 * (the table has no RLS): the proxy creates/claims flows with its owner role,
 * the app approves them with the logged-in user's role. Accepts a `DB` or a
 * transaction handle so both services can use it.
 */
export function makeDeviceFlows(db: DB | Tx) {
  return {
    /** Record a freshly minted flow (pending). */
    create: async (input: {
      deviceCode: string;
      userCode: string;
      expiresAt: Date;
    }): Promise<DeviceFlowRow> => {
      const [row] = await db
        .insert(deviceFlows)
        .values({
          deviceCode: input.deviceCode,
          userCode: input.userCode,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("device flow insert returned no row");
      return row;
    },

    /** Look up a still-valid flow by the CLI's secret device code. */
    findActiveByDeviceCode: async (
      deviceCode: string,
      now: Date,
    ): Promise<DeviceFlowRow | null> => {
      const [row] = await db
        .select()
        .from(deviceFlows)
        .where(
          and(
            eq(deviceFlows.deviceCode, deviceCode),
            gt(deviceFlows.expiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /** Look up a still-valid flow by the short user code (for the approver). */
    findActiveByUserCode: async (
      userCode: string,
      now: Date,
    ): Promise<DeviceFlowRow | null> => {
      const [row] = await db
        .select()
        .from(deviceFlows)
        .where(
          and(
            eq(deviceFlows.userCode, userCode),
            gt(deviceFlows.expiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /** Stamp the approving user + org. Only flips a still-pending row. */
    approve: async (
      id: string,
      input: { userId: string; orgId: string; at: Date },
    ): Promise<boolean> => {
      const rows = await db
        .update(deviceFlows)
        .set({
          status: "approved",
          userId: input.userId,
          orgId: input.orgId,
          approvedAt: input.at,
        })
        .where(and(eq(deviceFlows.id, id), eq(deviceFlows.status, "pending")))
        .returning({ id: deviceFlows.id });
      return rows.length > 0;
    },

    /** Mark an approved flow as claimed (single use). Returns false if it was
     *  already claimed - the guard against minting two tokens from one flow. */
    claim: async (id: string, at: Date): Promise<boolean> => {
      const rows = await db
        .update(deviceFlows)
        .set({ status: "claimed", claimedAt: at })
        .where(and(eq(deviceFlows.id, id), eq(deviceFlows.status, "approved")))
        .returning({ id: deviceFlows.id });
      return rows.length > 0;
    },
  };
}

export type DeviceFlows = ReturnType<typeof makeDeviceFlows>;
