import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import { createFolder } from "../../domain/workspace/folder";
import type { Slug } from "../../domain/workspace/slug";
import type { MountPath } from "../../domain/workspace/mount-path";
import type { RepoName } from "../../domain/workspace/repo-name";
import type {
  BrainSnapshot,
  BrainSnapshotEntry,
} from "../../domain/versioning/brain-snapshot";

export interface RestoreBrainSnapshotDeps {
  uow: UnitOfWork;
  git: GitBackend;
  ids: IdGenerator;
  clock: Clock;
}

export interface RestoreBrainSnapshotInput {
  orgId: string;
  snapshotId: string;
  actorId?: string | null;
}

export interface RestoreResult {
  brainId: string;
  restored: number;
  /** The auto-snapshot taken before restoring, so the restore is reversible. */
  backupSnapshotId: string;
}

/**
 * Roll a brain back to a snapshot: move each folder's branch to the recorded
 * commit. First takes an auto-snapshot of the current state (so restore is
 * itself reversible), and recreates any folder that was deleted since the
 * snapshot (its bare repo is never physically removed). Admin gate at interface.
 */
export function restoreBrainSnapshot(deps: RestoreBrainSnapshotDeps) {
  return (
    input: RestoreBrainSnapshotInput,
  ): Promise<Result<RestoreResult, DomainError>> =>
    asResult(async () => {
      const backupId = deps.ids.next();

      // 1. Load the target snapshot + the current folder set.
      const { snapshot, current } = await deps.uow.run(
        input.orgId,
        async (repos) => {
          const snap = await repos.snapshots.findById(input.snapshotId);
          if (!snap) {
            throw DomainError.notFound(`Snapshot not found: ${input.snapshotId}`);
          }
          const current = await repos.folders.listByBrain(snap.brainId);
          return { snapshot: snap, current };
        },
      );

      // 2. Auto-backup the current state (filesystem reads, outside the tx).
      const backupEntries: BrainSnapshotEntry[] = [];
      for (const f of current) {
        const commitSha = await deps.git.headCommit(f.repoName, f.defaultBranch);
        if (!commitSha) continue;
        await deps.git.setRef(
          f.repoName,
          `refs/monora/snapshots/${backupId}`,
          commitSha,
        );
        backupEntries.push({
          folderId: f.id,
          repoName: f.repoName,
          branch: f.defaultBranch,
          commitSha,
          path: f.path,
          name: f.name,
          slug: f.slug,
          parentFolderId: f.parentFolderId,
        });
      }

      // 3. Persist the backup + recreate any deleted folders + audit.
      await deps.uow.run(input.orgId, async (repos) => {
        const backup: BrainSnapshot = {
          id: backupId,
          orgId: input.orgId,
          brainId: snapshot.brainId,
          label: "Auto-backup before restore",
          createdBy: input.actorId ?? null,
          entries: backupEntries,
          createdAt: deps.clock.now(),
        };
        await repos.snapshots.add(backup);

        for (const e of snapshot.entries) {
          const existing = await repos.folders.findById(e.folderId);
          if (!existing) {
            await repos.folders.add(
              createFolder({
                id: e.folderId,
                orgId: input.orgId,
                brainId: snapshot.brainId,
                parentFolderId: e.parentFolderId,
                name: e.name,
                slug: e.slug as Slug,
                path: e.path as MountPath,
                repoName: e.repoName as RepoName,
                defaultBranch: e.branch,
                createdAt: deps.clock.now(),
              }),
            );
          }
        }

        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "brain.snapshot.restore",
          target: input.snapshotId,
          metadata: {
            brainId: snapshot.brainId,
            backupSnapshotId: backupId,
            folders: snapshot.entries.length,
          },
        });
      });

      // 4. Move each branch to its recorded commit (filesystem, after commit).
      for (const e of snapshot.entries) {
        await deps.git.setRef(
          e.repoName as RepoName,
          `refs/heads/${e.branch}`,
          e.commitSha,
        );
      }

      return {
        brainId: snapshot.brainId,
        restored: snapshot.entries.length,
        backupSnapshotId: backupId,
      };
    });
}
