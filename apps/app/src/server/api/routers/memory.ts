import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, orgProcedure } from "@/server/api/trpc";
import {
  userMemoryEvents,
  userMemoryObservations,
  userMemoryReflections,
} from "@/server/db/schema";
import {
  createUserDreamBrief,
  deleteUserMemory,
  getUserMemorySettings,
  processPendingUserMemoryEvents,
  updateUserMemorySettings,
} from "@monora/db";

export const memoryRouter = router({
  getSettings: orgProcedure.query(async ({ ctx }) => {
    return getUserMemorySettings(ctx.db, ctx.orgId, ctx.user.id);
  }),

  updateSettings: orgProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return updateUserMemorySettings(
        ctx.db,
        ctx.orgId,
        ctx.user.id,
        input.enabled,
      );
    }),

  listEvents: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(userMemoryEvents)
        .where(
          and(
            eq(userMemoryEvents.orgId, ctx.orgId),
            eq(userMemoryEvents.userId, ctx.user.id),
          ),
        )
        .orderBy(desc(userMemoryEvents.observedAt))
        .limit(input.limit);
    }),

  listObservations: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      await processPendingUserMemoryEvents(ctx.db, ctx.orgId, ctx.user.id);
      return ctx.db
        .select()
        .from(userMemoryObservations)
        .where(
          and(
            eq(userMemoryObservations.orgId, ctx.orgId),
            eq(userMemoryObservations.userId, ctx.user.id),
            eq(userMemoryObservations.status, "active"),
          ),
        )
        .orderBy(desc(userMemoryObservations.createdAt))
        .limit(input.limit);
    }),

  listReflections: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(userMemoryReflections)
        .where(
          and(
            eq(userMemoryReflections.orgId, ctx.orgId),
            eq(userMemoryReflections.userId, ctx.user.id),
          ),
        )
        .orderBy(desc(userMemoryReflections.createdAt))
        .limit(input.limit);
    }),

  createDreamBrief: orgProcedure.mutation(async ({ ctx }) => {
    return createUserDreamBrief(ctx.db, ctx.orgId, ctx.user.id);
  }),

  deleteMyMemory: orgProcedure.mutation(async ({ ctx }) => {
    return deleteUserMemory(ctx.db, ctx.orgId, ctx.user.id);
  }),
});
