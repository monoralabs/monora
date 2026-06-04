import "server-only";
import { makePostgresAuthz } from "@monora/db";
import { db } from "@/server/db";

/**
 * The app's authorization instance. The port (`Authz`) and the Postgres adapter
 * live in @monora/core / @monora/db; this binds the adapter to the singleton db.
 * Swap to OpenFGA by changing the factory in @monora/db - no call site changes.
 *
 * Do not inline permission checks anywhere else; always go through `authz.can`.
 */
export const authz = makePostgresAuthz(db);
export type { Authz, Subject, Action } from "@monora/core";
