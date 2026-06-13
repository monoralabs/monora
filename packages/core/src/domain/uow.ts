import type { AuditRepository } from "./audit/audit";
import type { TokenRepository } from "./access/token-repository";
import type { AccessGrantRepository } from "./access/access-grant";
import type { GroupRepository } from "./access/group";
import type {
  FolderRepository,
  BrainRepository,
} from "./workspace/repositories";
import type { BrainSnapshotRepository } from "./versioning/brain-snapshot";

/** The bundle of tenant-bound repositories a use-case operates on. */
export interface Repositories {
  brains: BrainRepository;
  folders: FolderRepository;
  tokens: TokenRepository;
  grants: AccessGrantRepository;
  groups: GroupRepository;
  audit: AuditRepository;
  snapshots: BrainSnapshotRepository;
}

/**
 * One use-case = one transaction = one tenant. `run` opens a tenant-bound
 * transaction (binds app.current_org_id so RLS scopes every query), hands the
 * callback the repositories, and commits/rolls back atomically. This is the
 * ONLY sanctioned way to touch tenant tables.
 */
export interface UnitOfWork {
  run<T>(orgId: string, fn: (repos: Repositories) => Promise<T>): Promise<T>;
}
