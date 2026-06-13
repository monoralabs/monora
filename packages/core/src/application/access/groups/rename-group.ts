import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";

export interface RenameGroupDeps {
  uow: UnitOfWork;
}

export interface RenameGroupInput {
  orgId: string;
  groupId: string;
  name: string;
  actorId?: string | null;
}

/** Rename a group (display name only; the slug stays the stable handle). */
export function renameGroup(deps: RenameGroupDeps) {
  return (input: RenameGroupInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      const name = input.name.trim();
      if (name === "") throw DomainError.validation("Group name cannot be empty");
      await deps.uow.run(input.orgId, async (repos) => {
        const group = await repos.groups.findById(input.groupId);
        if (!group) throw DomainError.notFound("Group not found");
        await repos.groups.rename(input.groupId, name);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "group.rename",
          target: input.groupId,
          metadata: { name },
        });
      });
    });
}
