import type { Permission } from "../access/permission";

/** One folder mounted into the composed workspace tree. The wire shape the
 *  connector consumes; repoName/cloneUrl/mountPath are plain strings. */
export interface MountEntry {
  folderId: string;
  repoName: string;
  /** Path under the workspace root where this folder is cloned. */
  mountPath: string;
  /** Full git clone URL (proxy base + repoName). */
  cloneUrl: string;
  /** Highest permission the subject holds on this folder. */
  permission: Permission;
}

/** The per-principal projection of which folders to compose into one tree. It
 *  lists ONLY what the subject may read, so authorization is baked in. */
export interface Manifest {
  orgId: string;
  subjectId: string;
  entries: MountEntry[];
}
