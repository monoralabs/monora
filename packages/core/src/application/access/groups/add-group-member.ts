import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";

export interface AddGroupMemberDeps {
  uow: UnitOfWork;
}

export interface AddGroupMemberInput {
  orgId: string;
  groupId: string;
  userId: string;
  actorId?: string | null;
}

/** Add a user to a group: they immediately gain the union of the group's folder
 *  grants (effective access is recomputed live on every read, so no backfill).
 *  Idempotent. */
export function addGroupMember(deps: AddGroupMemberDeps) {
  return (input: AddGroupMemberInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        const group = await repos.groups.findById(input.groupId);
        if (!group) throw DomainError.notFound("Group not found");
        await repos.groups.addMember(input.groupId, input.userId);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "group.member.add",
          target: input.groupId,
          metadata: { userId: input.userId },
        });
      });
    });
}
