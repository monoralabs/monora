import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { Authz, Action } from "../../domain/access/authz";
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
      const valid =
        token !== null &&
        isTokenActive(token, now) &&
        candidateOrgs.includes(token.orgId) &&
        (await deps.hasher.verify(input.rawToken, token.hashedSecret));

      if (!token || !valid) {
        await audit(false, token?.subjectId ?? null, candidateOrgs[0]);
        throw DENY();
      }
      // The token's org is the bound tenant for the rest of the request.
      const orgId = token.orgId;
      await deps.tokens.touchLastUsed(token.id, now);

      const folder = await deps.uow.run(orgId, (repos) =>
        repos.folders.findByRepoName(repoName),
      );
      if (!folder) {
        await audit(false, token.subjectId, orgId);
        throw DENY();
      }

      const allowed =
        tokenScopeAllows(token, folder.id) &&
        (await deps.authz.can(
          { userId: token.subjectId, orgId },
          action,
          folder.id,
        ));

      await audit(allowed, token.subjectId, orgId);
      if (!allowed) throw DENY();

      return {
        repoName,
        folderId: folder.id,
        orgId,
        subjectId: token.subjectId,
        action,
      };
    });
}
