import { router, createCallerFactory } from "@/server/api/trpc";
import { orgRouter } from "@/server/api/routers/org";
import { brainRouter } from "@/server/api/routers/brain";
import { tokensRouter } from "@/server/api/routers/tokens";
import { accessRouter } from "@/server/api/routers/access";
import { membersRouter } from "@/server/api/routers/members";
import { onboardingRouter } from "@/server/api/routers/onboarding";
import { versioningRouter } from "@/server/api/routers/versioning";
import { adminRouter } from "@/server/api/routers/admin";
import { deviceRouter } from "@/server/api/routers/device";
import { memoryRouter } from "@/server/api/routers/memory";

export const appRouter = router({
  org: orgRouter,
  brain: brainRouter,
  tokens: tokensRouter,
  access: accessRouter,
  members: membersRouter,
  onboarding: onboardingRouter,
  versioning: versioningRouter,
  admin: adminRouter,
  device: deviceRouter,
  memory: memoryRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
