import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { Authz, Subject } from "../../domain/access/authz";
import type { Folder } from "../../domain/workspace/folder";

export interface ListAccessibleFoldersDeps {
  uow: UnitOfWork;
  authz: Authz;
}

export interface ListAccessibleFoldersInput {
  subject: Subject;
}

/**
 * Every folder in the org the subject can READ - the Drive-style listing for the
 * explorer. Authorization is baked in: a folder you can't read is simply absent
 * from the result (not empty), in both the listing and a direct URL hit. This is
 * what makes a nested folder you weren't granted invisible while you still see
 * its (authorized) siblings/parent.
 */
export function listAccessibleFolders(deps: ListAccessibleFoldersDeps) {
  return (
    input: ListAccessibleFoldersInput,
  ): Promise<Result<Folder[], DomainError>> =>
    asResult(async () => {
      const folders = await deps.uow.run(input.subject.orgId, (repos) =>
        repos.folders.listByOrg(),
      );
      const visible: Folder[] = [];
      for (const f of folders) {
        // Archived (soft-deleted) folders live in the trash, not the Drive
        // listing - same rule as the manifest. (Without this, a collapsed
        // brain showed its 22 archived granular folders as duplicates.)
        if (f.archivedAt) continue;
        if (await deps.authz.can(input.subject, "read", f.id)) visible.push(f);
      }
      return visible;
    });
}
