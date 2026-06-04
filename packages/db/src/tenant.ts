import { sql } from "drizzle-orm";
import type { UnitOfWork } from "@monora/core";
import type { DB, Tx } from "./client";
import { makeRepositories } from "./adapters/repositories";

/**
 * Bind a unit of work to a single tenant: open a transaction, SET LOCAL
 * app.current_org_id (transaction-scoped, cannot leak across pooled
 * connections), and run the callback. RLS then scopes every query to this org.
 * `set_config(..., true)` => transaction-local; org id is a bound parameter,
 * never concatenated, so it cannot be injected.
 */
export function makeWithTenant(db: DB) {
  return function withTenant<T>(
    orgId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_org_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  };
}

/** The core UnitOfWork port, implemented over a tenant-bound transaction. This
 *  is what use-cases depend on. */
export function makeUnitOfWork(db: DB): UnitOfWork {
  const withTenant = makeWithTenant(db);
  return {
    run: (orgId, fn) => withTenant(orgId, (tx) => fn(makeRepositories(tx, orgId))),
  };
}
