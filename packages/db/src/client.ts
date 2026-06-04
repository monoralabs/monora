import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as domain from "./schema";
import * as authSchema from "./auth-schema";

/** Domain + auth tables merged, for Drizzle's relational query layer and for
 *  the Better Auth drizzle adapter. */
export const schema = { ...domain, ...authSchema };

export function createDb(connectionString: string, opts?: { max?: number }) {
  const pool = new Pool({ connectionString, max: opts?.max ?? 10 });
  return drizzle(pool, { schema });
}

export type DB = ReturnType<typeof createDb>;

/** The transaction handle Drizzle hands to `db.transaction(tx => ...)`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
