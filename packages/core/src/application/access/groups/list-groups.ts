import { asResult } from "../../../shared/errors";
import type { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";
import type { AccessGroup } from "../../../domain/access/group";

export interface ListGroupsDeps {
  uow: UnitOfWork;
}

export interface ListGroupsInput {
  orgId: string;
}

/** A group plus the counts the management UI shows at a glance. */
export interface GroupSummary extends AccessGroup {
  memberCount: number;
  grantCount: number;
}

/** Every group in the org with its member + folder-grant counts. */
export function listGroups(deps: ListGroupsDeps) {
  return (
    input: ListGroupsInput,
  ): Promise<Result<GroupSummary[], DomainError>> =>
    asResult(async () =>
      deps.uow.run(input.orgId, async (repos) => {
        const groups = await repos.groups.listByOrg();
        return Promise.all(
          groups.map(async (g) => ({
            ...g,
            memberCount: (await repos.groups.listMembers(g.id)).length,
            grantCount: (await repos.groups.listGrants(g.id)).length,
          })),
        );
      }),
    );
}
