import type { Permission } from "./permission";

/**
 * Authorization is a swappable port from day one. Today the adapter is a dumb
 * Postgres table (folder_access); when the permission matrix grows it becomes
 * OpenFGA WITHOUT touching call sites - every caller only ever sees `can(...)`.
 *
 * Do not inline permission checks anywhere else. If it is not expressible as
 * `can(subject, action, folderId)`, extend this interface here.
 */
export type Action = Permission;

export interface Subject {
  userId: string;
  orgId: string;
}

export interface Authz {
  can(subject: Subject, action: Action, folderId: string): Promise<boolean>;
}
