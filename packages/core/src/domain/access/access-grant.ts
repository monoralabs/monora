import type { Permission } from "./permission";

/** A grant of a permission on a folder to a user. Maps 1:1 to a folder_access
 *  row. The ACL the manifest and the proxy read through `can`. */
export interface AccessGrant {
  orgId: string;
  folderId: string;
  userId: string;
  permission: Permission;
}

export interface AccessGrantRepository {
  /** Upsert: one grant per (folder, user); re-granting changes the permission. */
  grant(grant: AccessGrant): Promise<void>;
  revoke(folderId: string, userId: string): Promise<void>;
  find(folderId: string, userId: string): Promise<AccessGrant | null>;
  listByFolder(folderId: string): Promise<AccessGrant[]>;
  listByUser(userId: string): Promise<AccessGrant[]>;
}
