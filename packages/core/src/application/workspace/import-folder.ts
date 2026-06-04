import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import { createFolder, type Folder } from "../../domain/workspace/folder";
import { makeSlug } from "../../domain/workspace/slug";
import { makeMountPath } from "../../domain/workspace/mount-path";
import { makeRepoName } from "../../domain/workspace/repo-name";

export interface ImportFolderDeps {
  uow: UnitOfWork;
  git: GitBackend;
  ids: IdGenerator;
  clock: Clock;
}

export interface ImportFolderInput {
  orgId: string;
  brainId: string;
  name: string;
  slug: string;
  path: string;
  /** Local directory whose contents become the folder's initial snapshot. */
  sourceDir: string;
  /** Nest under this folder (its own repo + ACL). Omit/null for a top-level
   *  folder. The mount path is then derived as `<parent.path>/<slug>` and the
   *  parent's grants are copied to seed this folder's ACL (copy-on-create). */
  parentFolderId?: string | null;
  /** Subpaths (relative to sourceDir) carved into nested child folders, so this
   *  snapshot excludes them - the child repo owns that content. */
  excludeSubpaths?: string[];
  /** Drop images/videos from the snapshot (Phase 4.7 moves them to R2). */
  excludeMedia?: boolean;
  defaultBranch?: string;
  message?: string;
  actorId?: string | null;
}

export interface ImportFolderResult {
  folder: Folder;
  commit: string;
  created: boolean;
}

/**
 * Ingest a local directory into a folder repo: ensure the bare repo, push a
 * snapshot commit, and upsert the folder row. Idempotent - re-running updates
 * the repo content and reuses the existing row. Used by the ingest CLI.
 *
 * Disjointness across the whole import set is the caller's job (it has the full
 * list); here we only validate this folder's own value objects.
 */
export function importFolderUseCase(deps: ImportFolderDeps) {
  return (
    input: ImportFolderInput,
  ): Promise<Result<ImportFolderResult, DomainError>> =>
    asResult(async () => {
      const slug = makeSlug(input.slug);
      const branch = (input.defaultBranch ?? "main").trim() || "main";
      const repoName = makeRepoName(input.brainId, slug);

      await deps.git.ensureBareRepo(repoName, branch);
      const { commit } = await deps.git.importSnapshot({
        repoName,
        sourceDir: input.sourceDir,
        branch,
        message: input.message ?? `ingest ${slug}`,
        excludeSubpaths: input.excludeSubpaths,
        excludeMedia: input.excludeMedia,
      });

      return deps.uow.run(input.orgId, async (repos) => {
        const brain = await repos.brains.findById(input.brainId);
        if (!brain) {
          throw DomainError.notFound(`Brain not found: ${input.brainId}`);
        }

        // Resolve the parent (if nesting) and derive the mount path from it; a
        // top-level folder mounts at the given path (or its slug). Computed up
        // front because re-ingest reconciles an existing folder to these too.
        let parent = null;
        if (input.parentFolderId) {
          parent = await repos.folders.findById(input.parentFolderId);
          if (!parent || parent.brainId !== brain.id) {
            throw DomainError.notFound(
              `Parent folder not found: ${input.parentFolderId}`,
            );
          }
        }
        const parentFolderId = parent?.id ?? null;
        // Prefer the explicit mount path (the ingest CLI computes the correct
        // nested path); only derive `<parent>/<slug>` when none is given. The
        // slug is the repo identity and may be prefixed for uniqueness, so it
        // must NOT dictate the mount path.
        const path = makeMountPath(
          input.path ?? (parent ? `${parent.path}/${slug}` : slug),
        );
        if (parent && !path.startsWith(`${parent.path}/`)) {
          throw DomainError.validation(
            `Nested folder path "${path}" must sit under its parent "${parent.path}"`,
          );
        }
        const name = input.name.trim();

        // Idempotent re-ingest: the repo content was already refreshed above.
        // If the row exists, reconcile its mutable structure (name, mount path,
        // parent) to the map, so a corrected map heals a drifted folder - e.g.
        // adding a `departments` parent re-nests departments that were first
        // imported as loose top-level mounts. Identity (slug, repoName) is kept.
        const existing = await repos.folders.findBySlugInBrain(brain.id, slug);
        if (existing) {
          const drifted =
            existing.name !== name ||
            existing.path !== path ||
            existing.parentFolderId !== parentFolderId;
          let folder = existing;
          if (drifted) {
            folder = createFolder({
              id: existing.id,
              orgId: existing.orgId,
              brainId: existing.brainId,
              parentFolderId,
              name,
              slug: existing.slug,
              path,
              repoName: existing.repoName,
              defaultBranch: existing.defaultBranch,
              createdAt: existing.createdAt,
            });
            await repos.folders.update(folder);
          }
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: "folder.ingest",
            target: existing.id,
            metadata: {
              repoName: existing.repoName,
              path: folder.path,
              parentFolderId,
              commit,
              created: false,
              reconciled: drifted,
            },
          });
          return { folder, commit, created: false };
        }

        const folder = createFolder({
          id: deps.ids.next(),
          orgId: input.orgId,
          brainId: brain.id,
          parentFolderId,
          name,
          slug,
          path,
          repoName,
          defaultBranch: branch,
          createdAt: deps.clock.now(),
        });
        await repos.folders.add(folder);

        // Copy-on-create inheritance: a nested folder starts shared with the
        // same people as its parent, then diverges independently.
        if (parentFolderId) {
          const parentGrants = await repos.grants.listByFolder(parentFolderId);
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
          action: "folder.ingest",
          target: folder.id,
          metadata: {
            repoName: folder.repoName,
            path: folder.path,
            parentFolderId,
            commit,
            created: true,
          },
        });
        return { folder, commit, created: true };
      });
    });
}
