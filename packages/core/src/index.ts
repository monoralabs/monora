// Barrel for @monora/core. Domain + application + ports. Zero infra.

// shared
export * from "./shared/result";
export * from "./shared/errors";
export * from "./shared/ports";

// domain - access
export * from "./domain/access/permission";
export * from "./domain/access/authz";
export * from "./domain/access/access-token";
export * from "./domain/access/token-hasher";
export * from "./domain/access/token-repository";
export * from "./domain/access/access-grant";
export * from "./domain/access/group";
export * from "./domain/access/memberships";

// domain - workspace
export * from "./domain/workspace/slug";
export * from "./domain/workspace/mount-path";
export * from "./domain/workspace/repo-name";
export * from "./domain/workspace/brain";
export * from "./domain/workspace/folder";
export * from "./domain/workspace/repositories";

// domain - git / audit / uow / distribution
export * from "./domain/git/git-backend";
export * from "./domain/git/blob-store";
export * from "./domain/audit/audit";
export * from "./domain/uow";
export * from "./domain/distribution/manifest";
export * from "./domain/versioning/brain-snapshot";

// application
export * from "./application/workspace/ensure-brain";
export * from "./application/workspace/ensure-brain-root-folder";
export * from "./application/workspace/create-folder";
export * from "./application/workspace/archive-folder";
export * from "./application/workspace/restore-folder";
export * from "./application/workspace/list-archived-folders";
export * from "./application/workspace/import-folder";
export * from "./application/workspace/browse-folder";
export * from "./application/workspace/list-accessible-folders";
export * from "./application/workspace/read-file";
export * from "./application/access/issue-token";
export * from "./application/access/revoke-token";
export * from "./application/access/authenticate-token";
export * from "./application/access/authorize-git-request";
export * from "./application/access/grant-access";
export * from "./application/access/revoke-access";
export * from "./application/access/groups/create-group";
export * from "./application/access/groups/rename-group";
export * from "./application/access/groups/delete-group";
export * from "./application/access/groups/add-group-member";
export * from "./application/access/groups/remove-group-member";
export * from "./application/access/groups/grant-group-access";
export * from "./application/access/groups/revoke-group-access";
export * from "./application/access/groups/list-groups";
export * from "./application/distribution/generate-manifest";
export * from "./application/versioning/create-brain-snapshot";
export * from "./application/versioning/list-brain-snapshots";
export * from "./application/versioning/restore-brain-snapshot";

// runtime adapters (system clock / uuid)
export * from "./runtime";
