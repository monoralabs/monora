import { DomainError } from "../../shared/errors";
import type { MountPath } from "./mount-path";
import type { RepoName } from "./repo-name";
import type { Slug } from "./slug";

/** A Folder = the unit of access. One folder = one bare git repo. The ACL lives
 *  here (folder_access). Files inside it inherit its access. */
export interface Folder {
  readonly id: string;
  readonly orgId: string;
  readonly brainId: string;
  /** The folder this one nests under, or null for a top-level folder. Nesting
   *  is structural only - each folder is still its own repo with its own ACL. */
  readonly parentFolderId: string | null;
  readonly name: string;
  readonly slug: Slug;
  readonly path: MountPath;
  readonly repoName: RepoName;
  readonly defaultBranch: string;
  /** Where the folder came from: "user" (created/added by a person) or "ingest"
   *  (materialized by the ingest job). Re-ingest only reconciles its own. */
  readonly source: FolderSource;
  /** Soft-delete tombstone. Null = live; a Date = archived (in the trash). The
   *  bare repo is kept either way, so restore (clearing this) brings it back
   *  with full git history. */
  readonly archivedAt: Date | null;
  /** Who archived it (user id), or null. */
  readonly archivedBy: string | null;
  readonly createdAt: Date;
}

export type FolderSource = "user" | "ingest";

/**
 * Reserved slug for a brain's root folder - a normal folder (one bare repo, its
 * own folder_access ACL) whose working tree mounts at the BRAIN ROOT itself
 * (`<brainSlug>`) instead of a subpath. Its ACL doubles as the brain's
 * visibility: a user not granted on it does not see the brain. The leading
 * underscore makes it impossible to create via `makeSlug` (kebab-case only), so
 * it can never collide with a user-created folder.
 */
export const BRAIN_ROOT_SLUG = "_root" as Slug;

/** True if `slug` is the reserved brain-root slug. */
export function isBrainRootSlug(slug: string): boolean {
  return slug === BRAIN_ROOT_SLUG;
}

export function createFolder(input: {
  id: string;
  orgId: string;
  brainId: string;
  parentFolderId?: string | null;
  name: string;
  slug: Slug;
  path: MountPath;
  repoName: RepoName;
  defaultBranch: string;
  source?: FolderSource;
  archivedAt?: Date | null;
  archivedBy?: string | null;
  createdAt: Date;
}): Folder {
  const name = input.name.trim();
  if (name === "") {
    throw DomainError.validation("Folder name cannot be empty");
  }
  const branch = input.defaultBranch.trim();
  if (branch === "") {
    throw DomainError.validation("defaultBranch cannot be empty");
  }
  return {
    id: input.id,
    orgId: input.orgId,
    brainId: input.brainId,
    parentFolderId: input.parentFolderId ?? null,
    name,
    slug: input.slug,
    path: input.path,
    repoName: input.repoName,
    defaultBranch: branch,
    source: input.source ?? "user",
    archivedAt: input.archivedAt ?? null,
    archivedBy: input.archivedBy ?? null,
    createdAt: input.createdAt,
  };
}
