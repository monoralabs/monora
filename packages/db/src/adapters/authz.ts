import { and, eq } from "drizzle-orm";
import type { Authz, Permission } from "@monora/core";
import { permissionSatisfies } from "@monora/core";
import type { DB } from "../client";
import { makeWithTenant } from "../tenant";
import { folderAccess } from "../schema";

/**
 * The Postgres-backed authz adapter: reads the folder_access ACL. Swap this one
 * factory for an OpenFGA adapter when the matrix grows - no call site changes,
 * because everyone depends on the core `Authz` port, not on this.
 */
export function makePostgresAuthz(db: DB): Authz {
  const withTenant = makeWithTenant(db);
  return {
    can: (subject, action, folderId) =>
      withTenant(subject.orgId, async (tx) => {
        const [row] = await tx
          .select({ permission: folderAccess.permission })
          .from(folderAccess)
          .where(
            and(
              eq(folderAccess.folderId, folderId),
              eq(folderAccess.userId, subject.userId),
              eq(folderAccess.orgId, subject.orgId),
            ),
          )
          .limit(1);
        if (!row) return false;
        return permissionSatisfies(row.permission as Permission, action);
      }),
  };
}
