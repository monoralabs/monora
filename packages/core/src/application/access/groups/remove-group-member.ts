import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";

export interface RemoveGroupMemberDeps {
  uow: UnitOfWork;
}

export interface RemoveGroupMemberInput {
  orgId: string;
  groupId: string;
  userId: string;
  actorId?: string | null;
}

/** Remove a user from a group: they lose every folder they reached ONLY through
 *  this group. Anything they still hold by a direct grant or another group stays
 *  (effective access is the union/MAX, recomputed on the next read). Their next
 *  sync prunes the now-unreachable folders, flagging any with local changes. */
export function removeGroupMember(deps: RemoveGroupMemberDeps) {
  return (input: RemoveGroupMemberInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        await repos.groups.removeMember(input.groupId, input.userId);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "group.member.remove",
          target: input.groupId,
          metadata: { userId: input.userId },
        });
      });
    });
}
