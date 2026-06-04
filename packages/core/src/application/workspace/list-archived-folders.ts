import { asResult } from "../../shared/errors";
import type { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { Authz, Subject } from "../../domain/access/authz";
import type { Folder } from "../../domain/workspace/folder";

export interface ListArchivedFoldersDeps {
  uow: UnitOfWork;
  authz: Authz;
}

export interface ListArchivedFoldersInput {
  subject: Subject;
}

/**
 * The trash: every archived folder in the org the subject can still administer.
 * The manifest hides archived folders, so this is the one read path that
 * surfaces them - for the "Archived" UI and for `monora restore` to resolve a
 * mount path back to a folder id. Gated by the same admin grant a restore needs,
 * so the list never reveals a folder the caller could not bring back.
 */
export function listArchivedFolders(deps: ListArchivedFoldersDeps) {
  return (
    input: ListArchivedFoldersInput,
  ): Promise<Result<Folder[], DomainError>> =>
    asResult(async () => {
      return deps.uow.run(input.subject.orgId, async (repos) => {
        const all = await repos.folders.listByOrg();
        const archived = all.filter((f) => f.archivedAt);
        const visible: Folder[] = [];
        for (const f of archived) {
          if (await deps.authz.can(input.subject, "admin", f.id)) {
            visible.push(f);
          }
        }
        return visible;
      });
    });
}
