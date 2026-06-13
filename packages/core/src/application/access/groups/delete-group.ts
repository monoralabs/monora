import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";

export interface DeleteGroupDeps {
  uow: UnitOfWork;
}

export interface DeleteGroupInput {
  orgId: string;
  groupId: string;
  actorId?: string | null;
}

/** Delete a group. Its memberships and folder grants go with it (FK cascade),
 *  so every member loses the access that came only through this group; their
 *  next sync prunes those folders (flagged if locally dirty). Direct grants and
 *  other groups are untouched. */
export function deleteGroup(deps: DeleteGroupDeps) {
  return (input: DeleteGroupInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        const group = await repos.groups.findById(input.groupId);
        if (!group) throw DomainError.notFound("Group not found");
        await repos.groups.delete(input.groupId);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "group.delete",
          target: input.groupId,
          metadata: { name: group.name, slug: group.slug },
        });
      });
    });
}
