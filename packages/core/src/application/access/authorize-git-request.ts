import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { Authz, Action } from "../../domain/access/authz";
import type { Memberships } from "../../domain/access/memberships";
import type { TokenHasher } from "../../domain/access/token-hasher";
import type { TokenLookup } from "../../domain/access/token-repository";
import { isTokenActive, tokenScopeAllows } from "../../domain/access/access-token";
import type { RepoName } from "../../domain/workspace/repo-name";

export type GitOp = "upload-pack" | "receive-pack";

export interface AuthorizeGitRequestDeps {
  tokens: TokenLookup;
  uow: UnitOfWork;
  authz: Authz;
  hasher: TokenHasher;
  clock: Clock;
  /** Resolve the orgs a user belongs to. A user-scoped token reaches a brain in
   *  any org the user is a member of; an agent/CI token stays pinned to its own
   *  org and never consults this. */
  memberships: Memberships;
  /** Resolve which org(s) may currently reach a brain, by the brain id parsed
   *  from the repo name. The repo name is keyed by brain id (org-independent),
   *  so the tenant is NOT trusted from the URL - it is derived here. Today this
   *  returns the brain's single owning org; this is the seam where brain
   *  sharing (a brain reachable by several orgs) plugs in later, additively. */
  resolveBrainOrgs: (brainId: string) => Promise<string[]>;
}

export interface AuthorizeGitRequestInput {
  /** The presented secret (from Basic-auth password or Bearer). */
  rawToken: string | null;
  /** `<brainId>/<folderSlug>.git`, parsed from the URL. */
  repoName: string;
  op: GitOp;
}

export interface AuthorizedGitRequest {
  repoName: RepoName;
  folderId: string;
  orgId: string;
  subjectId: string;
  action: Action;
}

/** One uniform denial: callers must not leak which check failed (a denied
 *  folder must be indistinguishable from a missing one). */
const DENY = () => DomainError.forbidden("access denied");

/** The single denial that is NOT uniform: an authenticated subject who can
 *  already READ the folder tried to push without a write grant. The folder is
 *  visible to them, so naming the reason leaks nothing - and transports must
 *  map it to 403 (not 401) or git clients re-prompt for credentials. */
export const GIT_WRITE_DENIED =
  "write access denied: this folder is read-only for you";

function parseRepoName(
  repoName: string,
): { brainId: string; ok: true } | { ok: false } {
  const parts = repoName.split("/");
  if (parts.length !== 2) return { ok: false };
  const [brainId, folder] = parts;
  if (!brainId || !folder) return { ok: false };
  if (!folder.endsWith(".git")) return { ok: false };
  if (repoName.includes("..")) return { ok: false };
  return { brainId, ok: true };
}

/**
 * The single chokepoint: every git fetch/push passes through here before any
 * byte is served. Resolves the repo's org from the URL, authenticates the
 * token, checks token scope + the folder ACL via `can`, audits, and returns the
 * authorized repo - or a uniform denial. No other code path serves repos.
 */
export function authorizeGitRequest(deps: AuthorizeGitRequestDeps) {
  return (
    input: AuthorizeGitRequestInput,
  ): Promise<Result<AuthorizedGitRequest, DomainError>> =>
    asResult(async () => {
      const now = deps.clock.now();
      const action: Action = input.op === "receive-pack" ? "write" : "read";

      const parsed = parseRepoName(input.repoName);
      if (!parsed.ok) throw DENY();
      const repoName = input.repoName as RepoName;

      // Derive the tenant from the brain, NOT from the URL: the repo name is
      // keyed by brain id (org-independent), so we resolve which org(s) may
      // reach this brain and only honor a token belonging to one of them. An
      // unknown brain yields no candidate orgs and is denied like a bad token,
      // with nothing to audit (no org FK to attach the row to).
      const candidateOrgs = await deps.resolveBrainOrgs(parsed.brainId);

      // Audit is a best-effort side effect: it must NEVER escalate a denial into
      // a 500 or break the uniform denial. It hits audit_log.org_id (an FK), so
      // we record under a known org - the matched one if any, else the brain's
      // owning org - and swallow failures so a bogus brain can't turn a clean
      // 401 into a 500 (an enumeration oracle). No candidate org => no audit.
      const audit = async (
        allowed: boolean,
        actorId: string | null,
        orgId: string | undefined,
      ) => {
        if (!orgId) return;
        try {
          await deps.uow.run(orgId, (repos) =>
            repos.audit.record({
              orgId,
              actorId,
              action: allowed
                ? input.op === "receive-pack"
                  ? "git.push"
                  : "git.fetch"
                : "git.denied",
              target: repoName,
              metadata: { op: input.op },
            }),
          );
        } catch {
          // best-effort: never let an audit failure change the auth outcome
        }
      };

      if (!input.rawToken) {
        await audit(false, null, candidateOrgs[0]);
        throw DENY();
      }

      const token = await deps.tokens.findActiveByPrefix(
        deps.hasher.parsePrefix(input.rawToken),
      );
      const authentic =
        token !== null &&
        isTokenActive(token, now) &&
        (await deps.hasher.verify(input.rawToken, token.hashedSecret));

      // Bind the tenant. An agent/CI token is pinned to its own org and only
      // reaches a brain owned by it. A user-scoped token reaches a brain in any
      // org the user belongs to, so the tenant is the candidate org that
      // intersects the user's memberships (the membership lookup runs only for
      // an already-authentic token, so a bogus token never probes it).
      let orgId: string | undefined;
      if (authentic && token) {
        if (token.subjectType === "user") {
          const userOrgs = await deps.memberships.listOrgsForUser(
            token.subjectId,
          );
          orgId = candidateOrgs.find((o) => userOrgs.includes(o));
        } else if (candidateOrgs.includes(token.orgId)) {
          orgId = token.orgId;
        }
      }

      if (!token || !authentic || !orgId) {
        await audit(false, token?.subjectId ?? null, candidateOrgs[0]);
        throw DENY();
      }
      await deps.tokens.touchLastUsed(token.id, now);

      const folder = await deps.uow.run(orgId, (repos) =>
        repos.folders.findByRepoName(repoName),
      );
      // An archived folder is in the trash: inert at the git layer until
      // restored. Denying here (indistinguishably from "missing") stops any
      // producer - including an ingest job force-pushing over HTTP - from
      // writing to a folder the user deleted. The bare repo is kept for restore.
      if (!folder || folder.archivedAt) {
        await audit(false, token.subjectId, orgId);
        throw DENY();
      }

      const inScope = tokenScopeAllows(token, folder.id);
      const allowed =
        inScope &&
        (await deps.authz.can(
          { userId: token.subjectId, orgId },
          action,
          folder.id,
        ));

      await audit(allowed, token.subjectId, orgId);
      if (!allowed) {
        // A push by someone who can read the folder gets the honest denial
        // (GIT_WRITE_DENIED -> 403): a scoped-out or unreadable folder must
        // stay indistinguishable from a missing one, so anything else falls
        // through to the uniform deny.
        if (
          action === "write" &&
          inScope &&
          (await deps.authz.can(
            { userId: token.subjectId, orgId },
            "read",
            folder.id,
          ))
        ) {
          throw DomainError.forbidden(GIT_WRITE_DENIED);
        }
        throw DENY();
      }

      return {
        repoName,
        folderId: folder.id,
        orgId,
        subjectId: token.subjectId,
        action,
      };
    });
}
