import { asResult } from "../../shared/errors";
import type { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";

export interface RevokeTokenDeps {
  uow: UnitOfWork;
  clock: Clock;
}

export interface RevokeTokenInput {
  orgId: string;
  tokenId: string;
  actorId?: string | null;
}

export function revokeToken(deps: RevokeTokenDeps) {
  return (input: RevokeTokenInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        await repos.tokens.revoke(input.tokenId, deps.clock.now());
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "token.revoke",
          target: input.tokenId,
        });
      });
    });
}
