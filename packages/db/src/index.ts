// Barrel for @monora/db. Schema + client + tenant/UoW + Drizzle adapters.
export { createDb, schema, type DB, type Tx } from "./client";
export { makeWithTenant, makeUnitOfWork } from "./tenant";
export { makeRepositories, toAccessToken } from "./adapters/repositories";
export { makeBrainOrgResolver } from "./adapters/brain-org-resolver";
export { makeMemberships } from "./adapters/memberships";
export { makePostgresAuthz } from "./adapters/authz";
export { makeTokenLookup } from "./adapters/token-lookup";
export {
  makeDeviceFlows,
  type DeviceFlows,
  type DeviceFlowRow,
} from "./adapters/device-flows";
export {
  createUserDreamBrief,
  deleteUserMemory,
  getUserMemorySettings,
  makeUserMemoryStore,
  processPendingUserMemoryEvents,
  recordUserMemoryEvent,
  recordUserMemoryReflection,
  updateUserMemorySettings,
  type DreamBrief,
  type MemoryEventType,
  type UserMemoryStore,
} from "./adapters/user-memory";
export { ScryptTokenHasher } from "./adapters/token-hasher";

// Re-export the table objects (brains, folders, folderAccess, auditLog, ...).
export * from "./schema";
