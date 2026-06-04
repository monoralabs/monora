import "server-only";
import { makeWithTenant } from "@monora/db";
import { db } from "./index";

/**
 * The app's tenant-bound transaction helper, wired to the singleton db. The
 * implementation lives in @monora/db (makeWithTenant); this binds it. Still the
 * ONLY sanctioned way to touch tenant tables from bespoke queries (orgProcedure
 * uses it under the hood). Use-cases use the UnitOfWork (see @/server/usecases).
 */
export const withTenant = makeWithTenant(db);
