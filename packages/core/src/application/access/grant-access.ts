import { asResult } from "../../shared/errors";
import { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { Permission } from "../../domain/access/permission";
import { collectSubtree } from "../../domain/workspace/descendants";

export interface GrantAccessDeps {
  uow: UnitOfWork;
}

export interface GrantAccessInput {
  orgId: string;
  folderId: string;
  userId: string;
  permission: Permission;
  actorId?: string | null;
  /** Also grant the same permission on every folder nested under `folderId` in
   *  its brain (the CURRENT tree). A one-time bulk-apply, not live inheritance:
   *  folders created later stay private. */
  includeDescendants?: boolean;
}

/** Grant (or change) a user's permission on a folder. Idempotent upsert.
 *  Authorization of the ACTOR (must be an org/folder admin) is enforced at the
 *  interface edge. */
export function grantAccess(deps: GrantAccessDeps) {
  return (input: GrantAccessInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        let targets = [input.folderId];
        if (input.includeDescendants) {
          const root = await repos.folders.findById(input.folderId);
          if (!root) throw DomainError.notFound("Folder not found");
          const siblings = await repos.folders.listByBrain(root.brainId);
          targets = collectSubtree(siblings, input.folderId);
        }
        for (const folderId of targets) {
          const existing = await repos.grants.find(folderId, input.userId);
          await repos.grants.grant({
            orgId: input.orgId,
            folderId,
            userId: input.userId,
            permission: input.permission,
          });
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: existing ? "access.change" : "access.grant",
            target: folderId,
            metadata: { userId: input.userId, permission: input.permission },
          });
        }
      });
    });
}
