import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import { collectSubtree } from "../../domain/workspace/descendants";

export interface RestoreFolderDeps {
  uow: UnitOfWork;
}

export interface RestoreFolderInput {
  orgId: string;
  folderId: string;
  actorId?: string | null;
}

export interface RestoreFolderResult {
  /** Folder ids brought back out of the trash by this call. */
  restored: string[];
}

/**
 * Bring an archived folder back from the trash: clears the `archivedAt`
 * tombstone, so the folder reappears in the manifest and the next `sync`
 * re-clones it with full git history (the bare repo was never removed).
 *
 * Cascades to the subtree, mirroring archiveFolderUseCase: restoring a parent
 * restores the children that went down with it. Only currently-archived folders
 * are touched, so restoring a parent never resurrects a child that was already
 * archived on its own beforehand.
 *
 * Authorization of the actor (folder admin) is enforced at the interface edge.
 */
export function restoreFolderUseCase(deps: RestoreFolderDeps) {
  return (
    input: RestoreFolderInput,
  ): Promise<Result<RestoreFolderResult, DomainError>> =>
    asResult(async () => {
      return deps.uow.run(input.orgId, async (repos) => {
        const root = await repos.folders.findById(input.folderId);
        if (!root) throw DomainError.notFound("Folder not found");

        const siblings = await repos.folders.listByBrain(root.brainId);
        const subtree = collectSubtree(siblings, input.folderId);
        const byId = new Map(siblings.map((f) => [f.id, f]));

        const restored: string[] = [];
        for (const id of subtree) {
          const f = id === root.id ? root : byId.get(id);
          if (!f?.archivedAt) continue;
          await repos.folders.restore(id);
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: "folder.restore",
            target: id,
            metadata: { repoName: f.repoName, path: f.path },
          });
          restored.push(id);
        }
        return { restored };
      });
    });
}
