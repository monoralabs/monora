import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import {
  BRAIN_ROOT_SLUG,
  createFolder,
  type Folder,
} from "../../domain/workspace/folder";
import { makeMountPath } from "../../domain/workspace/mount-path";
import { makeRepoName } from "../../domain/workspace/repo-name";

export interface EnsureBrainRootFolderDeps {
  uow: UnitOfWork;
  git: GitBackend;
  ids: IdGenerator;
  clock: Clock;
}

export interface EnsureBrainRootFolderInput {
  orgId: string;
  brainId: string;
  /** Grant this user admin on the root folder - i.e. make the brain visible to
   *  them. Omit for an unshared root (invisible until granted, like a plain
   *  top-level folder). */
  ownerUserId?: string | null;
  actorId?: string | null;
}

/**
 * Idempotently ensure a brain has its root folder: a normal folder (its own
 * bare repo + ACL) reserved with {@link BRAIN_ROOT_SLUG}, whose working tree the
 * connector mounts at the brain root (`<brainSlug>`) rather than a subpath (see
 * `generateManifest`). This is where brain-wide files live (CLAUDE.md, README,
 * ...) - versioned and shared like any folder, no special brain ACL table. The
 * bare repo is created before the row is persisted, mirroring `createFolder`.
 */
export function ensureBrainRootFolder(deps: EnsureBrainRootFolderDeps) {
  return (
    input: EnsureBrainRootFolderInput,
  ): Promise<Result<Folder, DomainError>> =>
    asResult(async () => {
      const prepared = await deps.uow.run(input.orgId, async (repos) => {
        const brain = await repos.brains.findById(input.brainId);
        if (!brain) {
          throw DomainError.notFound(`Brain not found: ${input.brainId}`);
        }
        const existing = await repos.folders.findBySlugInBrain(
          brain.id,
          BRAIN_ROOT_SLUG,
        );
        return {
          existing,
          repoName: makeRepoName(brain.id, BRAIN_ROOT_SLUG),
        };
      });
      if (prepared.existing) return prepared.existing;

      await deps.git.ensureBareRepo(prepared.repoName, "main");

      return deps.uow.run(input.orgId, async (repos) => {
        // Re-check inside the write tx in case a concurrent call won the race.
        const race = await repos.folders.findBySlugInBrain(
          input.brainId,
          BRAIN_ROOT_SLUG,
        );
        if (race) return race;

        const folder = createFolder({
          id: deps.ids.next(),
          orgId: input.orgId,
          brainId: input.brainId,
          parentFolderId: null,
          name: "Brain root",
          slug: BRAIN_ROOT_SLUG,
          // Stored path is just the slug; the manifest mounts it at the brain
          // root via the slug check, not this value.
          path: makeMountPath(BRAIN_ROOT_SLUG),
          repoName: prepared.repoName,
          defaultBranch: "main",
          createdAt: deps.clock.now(),
        });
        await repos.folders.add(folder);

        if (input.ownerUserId) {
          await repos.grants.grant({
            orgId: input.orgId,
            folderId: folder.id,
            userId: input.ownerUserId,
            permission: "admin",
          });
        }

        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "folder.create",
          target: folder.id,
          metadata: { repoName: folder.repoName, brainRoot: true },
        });
        return folder;
      });
    });
}
