import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import type {
  BrainSnapshot,
  BrainSnapshotEntry,
} from "../../domain/versioning/brain-snapshot";

export interface CreateBrainSnapshotDeps {
  uow: UnitOfWork;
  git: GitBackend;
  ids: IdGenerator;
  clock: Clock;
}

export interface CreateBrainSnapshotInput {
  /** orgId scopes the tenant transaction. Admin gate is at the interface layer. */
  orgId: string;
  brainId: string;
  label?: string | null;
  /** The user creating it; null for system snapshots. */
  actorId?: string | null;
}

/**
 * Snapshot a brain: record every folder's branch tip so the brain can be rolled
 * back later. Reuses git history - it stores commit shas and pins them under
 * `refs/monora/snapshots/<id>` so a rolled-back commit can't be gc-ed. Folders
 * with an unborn repo (no commits yet) are skipped (nothing to restore).
 */
export function createBrainSnapshot(deps: CreateBrainSnapshotDeps) {
  return (
    input: CreateBrainSnapshotInput,
  ): Promise<Result<BrainSnapshot, DomainError>> =>
    asResult(async () => {
      const id = deps.ids.next();

      // 1. Read the folder set inside the tenant transaction.
      const folders = await deps.uow.run(input.orgId, async (repos) => {
        const brain = await repos.brains.findById(input.brainId);
        if (!brain) throw DomainError.notFound(`Brain not found: ${input.brainId}`);
        return repos.folders.listByBrain(input.brainId);
      });

      // 2. Read each folder's tip + pin it (filesystem, outside the tx).
      const entries: BrainSnapshotEntry[] = [];
      for (const f of folders) {
        const commitSha = await deps.git.headCommit(f.repoName, f.defaultBranch);
        if (!commitSha) continue; // unborn repo - nothing to snapshot
        await deps.git.setRef(
          f.repoName,
          `refs/monora/snapshots/${id}`,
          commitSha,
        );
        entries.push({
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

      // 3. Persist the snapshot + audit.
      const snapshot: BrainSnapshot = {
        id,
        orgId: input.orgId,
        brainId: input.brainId,
        label: input.label?.trim() || null,
        createdBy: input.actorId ?? null,
        entries,
        createdAt: deps.clock.now(),
      };
      await deps.uow.run(input.orgId, async (repos) => {
        await repos.snapshots.add(snapshot);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "brain.snapshot.create",
          target: id,
          metadata: { brainId: input.brainId, folders: entries.length },
        });
      });
      return snapshot;
    });
}
