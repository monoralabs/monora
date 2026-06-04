import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import { collectSubtree } from "../../domain/workspace/descendants";

export interface ArchiveFolderDeps {
  uow: UnitOfWork;
  clock: Clock;
}

export interface ArchiveFolderInput {
  orgId: string;
  folderId: string;
  actorId?: string | null;
}

export interface ArchiveFolderResult {
  /** Folder ids that were archived by this call (the target + its descendants
   *  that were still live). Already-archived folders are not listed again. */
  archived: string[];
}

/**
 * Soft-delete a folder = move it (and everything nested under it) to the trash.
 * Sets the `archivedAt` tombstone so the folder drops out of the manifest and
 * is inert at the git chokepoint - but the bare repo is NEVER touched, so a
 * restore brings it back with full git history.
 *
 * Cascades to descendants like grant/revoke: a parent's nested folders are their
 * own repos, so archiving a parent must archive its whole current subtree (or
 * children would be orphaned mounts with no parent to nest under). A one-time
 * bulk over the CURRENT tree, mirroring `collectSubtree` everywhere else.
 *
 * Authorization of the actor (folder admin) is enforced at the interface edge
 * (proxy route / orgAdminProcedure), like grantAccess - not re-checked here.
 */
export function archiveFolderUseCase(deps: ArchiveFolderDeps) {
  return (
    input: ArchiveFolderInput,
  ): Promise<Result<ArchiveFolderResult, DomainError>> =>
    asResult(async () => {
      const now = deps.clock.now();
      return deps.uow.run(input.orgId, async (repos) => {
        const root = await repos.folders.findById(input.folderId);
        if (!root) throw DomainError.notFound("Folder not found");

        const siblings = await repos.folders.listByBrain(root.brainId);
        const subtree = collectSubtree(siblings, input.folderId);
        const byId = new Map(siblings.map((f) => [f.id, f]));

        const archived: string[] = [];
        for (const id of subtree) {
          // Skip folders already in the trash so a re-run is idempotent and the
          // audit trail stays honest (we only log what this call actually moved).
          const f = id === root.id ? root : byId.get(id);
          if (f?.archivedAt) continue;
          await repos.folders.archive(id, now, input.actorId ?? null);
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: "folder.archive",
            target: id,
            metadata: {
              repoName: f?.repoName,
              path: f?.path,
              viaParent: id !== root.id ? root.id : undefined,
            },
          });
          archived.push(id);
        }
        return { archived };
      });
    });
}
