/**
 * Brain versioning (the "undo" for agent-edited brains). A snapshot is a
 * point-in-time record of every folder in a brain + that folder's branch tip,
 * so the whole brain can be rolled back. Built on the per-folder git history:
 * the snapshot stores commit shas, and restore moves each branch back to its
 * recorded sha. Entries carry enough folder metadata to recreate a folder that
 * was deleted between snapshot and restore.
 */

export interface BrainSnapshotEntry {
  folderId: string;
  /** Bare-repo identity, used to address the repo on restore. */
  repoName: string;
  branch: string;
  /** The folder's branch tip at snapshot time. */
  commitSha: string;
  /** Folder metadata, so a deleted folder can be recreated on restore. */
  path: string;
  name: string;
  slug: string;
  parentFolderId: string | null;
}

export interface BrainSnapshot {
  id: string;
  orgId: string;
  brainId: string;
  /** Optional human label ("before the big rewrite"). */
  label: string | null;
  /** The user who created it (null = system, e.g. the auto pre-restore backup). */
  createdBy: string | null;
  entries: BrainSnapshotEntry[];
  createdAt: Date;
}

/** Repository port. Implemented by a Drizzle adapter, tenant-bound via the UoW. */
export interface BrainSnapshotRepository {
  add(snapshot: BrainSnapshot): Promise<void>;
  findById(id: string): Promise<BrainSnapshot | null>;
  /** Newest first. */
  listByBrain(brainId: string): Promise<BrainSnapshot[]>;
}
