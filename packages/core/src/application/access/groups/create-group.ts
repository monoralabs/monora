import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { Clock, IdGenerator } from "../../../shared/ports";
import type { UnitOfWork } from "../../../domain/uow";
import { createGroup as makeGroup, type AccessGroup } from "../../../domain/access/group";
import { makeSlug, slugify } from "../../../domain/workspace/slug";

export interface CreateGroupDeps {
  uow: UnitOfWork;
  ids: IdGenerator;
  clock: Clock;
}

export interface CreateGroupInput {
  orgId: string;
  name: string;
  /** Optional explicit slug; derived from `name` when omitted. */
  slug?: string;
  actorId?: string | null;
}

/** Create a named group. The slug is unique per org (the CLI/UI handle to it).
 *  Authorization of the actor (org admin) is enforced at the interface edge.
 *  Suffixed `UseCase` to avoid colliding with the `createGroup` domain factory
 *  (same convention as `createFolderUseCase`). */
export function createGroupUseCase(deps: CreateGroupDeps) {
  return (
    input: CreateGroupInput,
  ): Promise<Result<AccessGroup, DomainError>> =>
    asResult(async () => {
      const slug = input.slug ? makeSlug(input.slug) : slugify(input.name);
      return deps.uow.run(input.orgId, async (repos) => {
        const existing = await repos.groups.findBySlug(slug);
        if (existing) {
          throw DomainError.conflict(`A group "${slug}" already exists`);
        }
        const group = makeGroup({
          id: deps.ids.next(),
          orgId: input.orgId,
          name: input.name,
          slug,
          createdAt: deps.clock.now(),
        });
        await repos.groups.create(group);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "group.create",
          target: group.id,
          metadata: { name: group.name, slug: group.slug },
        });
        return group;
      });
    });
}
