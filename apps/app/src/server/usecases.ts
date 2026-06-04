import "server-only";
import {
  ensureBrain,
  createFolderUseCase,
  importFolderUseCase,
  browseFolder,
  listAccessibleFolders,
  readBrainFile,
  readBrainFileBytes,
  issueToken,
  revokeToken,
  grantAccess,
  revokeAccess,
  createBrainSnapshot,
  listBrainSnapshots,
  restoreBrainSnapshot,
  systemClock,
  uuidIdGenerator,
} from "@monora/core";
import { makeUnitOfWork, ScryptTokenHasher } from "@monora/db";
import { GitShellBackend } from "@monora/git";
import { db } from "@/server/db";
import { authz } from "@/server/authz";
import { blobStore } from "@/server/storage/blob-store";
import { env } from "@/env";

/**
 * Composition root: wire the concrete adapters (db UnitOfWork, git backend,
 * system clock/uuid) into the core use-cases ONCE. tRPC routers, and later the
 * connector/MCP surfaces, call these - they never touch adapters directly.
 */
const deps = {
  uow: makeUnitOfWork(db),
  git: new GitShellBackend({ gitRoot: env.GIT_ROOT }),
  hasher: new ScryptTokenHasher(),
  ids: uuidIdGenerator,
  clock: systemClock,
  authz,
  blobStore: blobStore(),
};

export const useCases = {
  ensureBrain: ensureBrain(deps),
  createFolder: createFolderUseCase(deps),
  importFolder: importFolderUseCase(deps),
  browseFolder: browseFolder(deps),
  listAccessibleFolders: listAccessibleFolders(deps),
  readBrainFile: readBrainFile(deps),
  readBrainFileBytes: readBrainFileBytes(deps),
  issueToken: issueToken(deps),
  revokeToken: revokeToken(deps),
  grantAccess: grantAccess(deps),
  revokeAccess: revokeAccess(deps),
  createBrainSnapshot: createBrainSnapshot(deps),
  listBrainSnapshots: listBrainSnapshots(deps),
  restoreBrainSnapshot: restoreBrainSnapshot(deps),
};
