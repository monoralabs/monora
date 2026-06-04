import {
  authorizeGitRequest,
  authenticateToken,
  generateManifest,
  ensureBrain,
  ensureBrainRootFolder,
  createFolderUseCase,
  archiveFolderUseCase,
  restoreFolderUseCase,
  listArchivedFolders,
  grantAccess,
  issueToken,
  systemClock,
  uuidIdGenerator,
} from "@monora/core";
import {
  createDb,
  makeUnitOfWork,
  makePostgresAuthz,
  makeTokenLookup,
  makeDeviceFlows,
  makeBrainOrgResolver,
  makeMemberships,
  ScryptTokenHasher,
} from "@monora/db";
import { GitHttp, GitShellBackend } from "@monora/git";
import type { ProxyDeps } from "./app";

/**
 * Composition root for the proxy. It connects with a connection that can read
 * tokens across orgs (the owner role) - token auth happens before the org is
 * known. The repository adapters still filter by org explicitly, so per-tenant
 * correctness holds even though the owner role bypasses RLS.
 */
export function buildDeps(opts: {
  databaseUrl: string;
  gitRoot: string;
  /** Public origin of the app where users approve device logins. Falls back to
   *  $MONORA_APP_URL, then the prod app, so tests can omit it. */
  appUrl?: string;
}): ProxyDeps {
  const appUrl =
    opts.appUrl ?? process.env.MONORA_APP_URL ?? "https://app.monora.ai";
  const db = createDb(opts.databaseUrl);
  const tokens = makeTokenLookup(db);
  const uow = makeUnitOfWork(db);
  const authz = makePostgresAuthz(db);
  const hasher = new ScryptTokenHasher();
  const resolveBrainOrgs = makeBrainOrgResolver(db);
  const memberships = makeMemberships(db);
  const read = new GitShellBackend({ gitRoot: opts.gitRoot });
  const provisionDeps = { uow, git: read, ids: uuidIdGenerator, clock: systemClock };
  return {
    authorize: authorizeGitRequest({
      tokens,
      uow,
      authz,
      hasher,
      clock: systemClock,
      memberships,
      resolveBrainOrgs,
    }),
    authenticate: authenticateToken({ tokens, hasher, clock: systemClock }),
    manifest: generateManifest({ uow, authz, memberships }),
    ensureBrain: ensureBrain(provisionDeps),
    ensureBrainRootFolder: ensureBrainRootFolder(provisionDeps),
    createFolder: createFolderUseCase(provisionDeps),
    archiveFolder: archiveFolderUseCase({ uow, clock: systemClock }),
    restoreFolder: restoreFolderUseCase({ uow }),
    listArchivedFolders: listArchivedFolders({ uow, authz }),
    grant: grantAccess({ uow }),
    issueToken: issueToken({ uow, hasher, ids: uuidIdGenerator, clock: systemClock }),
    deviceFlows: makeDeviceFlows(db),
    appUrl,
    git: new GitHttp(opts.gitRoot),
    read,
    // Pin the public origin in prod so clone URLs don't depend on (forgeable)
    // request headers. Set behind the reverse proxy, e.g. https://git.monora.ai.
    gitPublicOrigin: process.env.GIT_PUBLIC_ORIGIN,
  };
}
