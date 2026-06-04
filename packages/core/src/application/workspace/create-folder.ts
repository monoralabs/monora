import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import { createFolder, type Folder } from "../../domain/workspace/folder";
import { makeSlug } from "../../domain/workspace/slug";
import { makeMountPath } from "../../domain/workspace/mount-path";
import { makeRepoName } from "../../domain/workspace/repo-name";

export interface CreateFolderDeps {
  uow: UnitOfWork;
  git: GitBackend;
  ids: IdGenerator;
  clock: Clock;
}

export interface CreateFolderInput {
  orgId: string;
  brainId: string;
  /** Nest under this folder (its own repo + ACL). Omit/null for a top-level
   *  folder. The mount path is then derived as `<parent.path>/<slug>`. */
  parentFolderId?: string | null;
  name: string;
  slug: string;
  /** Mount path for a top-level folder. Ignored when `parentFolderId` is set
   *  (derived from the parent). Defaults to the slug. */
  path?: string;
  defaultBranch?: string;
  actorId?: string | null;
}

/**
 * Create an empty folder = one bare git repo + its row. Enforces: the brain
 * exists, the parent (if any) is in the same brain, and the slug + mount path
 * are unique within the brain. A nested folder is still its own repo with its
 * own ACL; we just seed that ACL by copying the parent's grants (copy-on-create
 * inheritance - no recursive ancestor walk anywhere on the read/auth path). The
 * bare repo is created (idempotently) before the row is persisted, so a
 * rolled-back transaction leaves at most a harmless empty repo.
 */
export function createFolderUseCase(deps: CreateFolderDeps) {
  return (input: CreateFolderInput): Promise<Result<Folder, DomainError>> =>
    asResult(async () => {
      const slug = makeSlug(input.slug);
      const branch = (input.defaultBranch ?? "main").trim() || "main";

      // Read + validate inside the tenant transaction.
      const prepared = await deps.uow.run(input.orgId, async (repos) => {
        const brain = await repos.brains.findById(input.brainId);
        if (!brain) {
          throw DomainError.notFound(`Brain not found: ${input.brainId}`);
        }

        let parent: Folder | null = null;
        if (input.parentFolderId) {
          parent = await repos.folders.findById(input.parentFolderId);
          if (!parent || parent.brainId !== brain.id) {
            throw DomainError.notFound(
              `Parent folder not found: ${input.parentFolderId}`,
            );
          }
        }

        // Slug is unique per brain (keeps the repo name flat: <brainId>/<slug>).
        const clash = await repos.folders.findBySlugInBrain(brain.id, slug);
        if (clash) {
          throw DomainError.conflict(
            `A folder with slug "${slug}" already exists in this brain`,
          );
        }

        // Derive the mount path: nested = parent's path + slug; else the given
        // path (or the slug). A child legitimately nests under its parent, so
        // we no longer reject overlaps - only an exact path collision.
        const path = parent
          ? makeMountPath(`${parent.path}/${slug}`)
          : makeMountPath(input.path ?? slug);
        const siblings = await repos.folders.listByBrain(brain.id);
        if (siblings.some((f) => f.path === path)) {
          throw DomainError.conflict(`A folder already mounts at "${path}"`);
        }

        return {
          repoName: makeRepoName(brain.id, slug),
          brainId: brain.id,
          parentFolderId: parent?.id ?? null,
          path,
        };
      });

      await deps.git.ensureBareRepo(prepared.repoName, branch);

      return deps.uow.run(input.orgId, async (repos) => {
        const folder = createFolder({
          id: deps.ids.next(),
          orgId: input.orgId,
          brainId: prepared.brainId,
          parentFolderId: prepared.parentFolderId,
          name: input.name,
          slug,
          path: prepared.path,
          repoName: prepared.repoName,
          defaultBranch: branch,
          createdAt: deps.clock.now(),
        });
        await repos.folders.add(folder);

        // Copy-on-create inheritance: a nested folder starts shared with the
        // same people as its parent (then diverges independently).
        if (prepared.parentFolderId) {
          const parentGrants = await repos.grants.listByFolder(
            prepared.parentFolderId,
          );
          for (const g of parentGrants) {
            await repos.grants.grant({
              orgId: input.orgId,
              folderId: folder.id,
              userId: g.userId,
              permission: g.permission,
            });
          }
        }

        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "folder.create",
          target: folder.id,
          metadata: {
            repoName: folder.repoName,
            path: folder.path,
            parentFolderId: folder.parentFolderId,
          },
        });
        return folder;
      });
    });
}
