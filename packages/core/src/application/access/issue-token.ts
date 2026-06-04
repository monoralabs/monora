import { asResult } from "../../shared/errors";
import type { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { TokenHasher } from "../../domain/access/token-hasher";
import type {
  AccessToken,
  SubjectType,
} from "../../domain/access/access-token";

export interface IssueTokenDeps {
  uow: UnitOfWork;
  hasher: TokenHasher;
  ids: IdGenerator;
  clock: Clock;
}

export interface IssueTokenInput {
  orgId: string;
  subjectType: SubjectType;
  subjectId: string;
  name: string;
  scopes?: string[] | null;
  expiresAt?: Date | null;
  actorId?: string | null;
}

export interface IssueTokenResult {
  /** The full secret - return to the caller ONCE, never stored. */
  plaintext: string;
  token: AccessToken;
}

export function issueToken(deps: IssueTokenDeps) {
  return (
    input: IssueTokenInput,
  ): Promise<Result<IssueTokenResult, DomainError>> =>
    asResult(async () => {
      const gen = await deps.hasher.generate();
      const token: AccessToken = {
        id: deps.ids.next(),
        orgId: input.orgId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        name: input.name.trim() || "token",
        tokenPrefix: gen.prefix,
        hashedSecret: gen.hash,
        scopes: input.scopes ?? null,
        createdAt: deps.clock.now(),
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
      };
      await deps.uow.run(input.orgId, async (repos) => {
        await repos.tokens.add(token);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "token.issue",
          target: token.id,
          metadata: { subjectType: token.subjectType, subjectId: token.subjectId },
        });
      });
      return { plaintext: gen.plaintext, token };
    });
}
