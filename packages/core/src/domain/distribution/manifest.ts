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
  /** The org this folder belongs to. With a user-scoped token a single
   *  manifest spans several orgs, so attribution lives per entry, not on the
   *  manifest. */
  orgId: string;
}

/** The per-principal projection of which folders to compose into one tree. It
 *  lists ONLY what the subject may read, so authorization is baked in. A
 *  user-scoped token composes folders from every org the user belongs to into
 *  one tree; `orgId` is then the home/issuing org and the real per-folder org
 *  is on each entry. */
export interface Manifest {
  orgId: string;
  subjectId: string;
  entries: MountEntry[];
}
