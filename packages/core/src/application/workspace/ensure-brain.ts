import { asResult } from "../../shared/errors";
import type { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock, IdGenerator } from "../../shared/ports";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import { createBrain, type Brain } from "../../domain/workspace/brain";
import { makeSlug, slugify } from "../../domain/workspace/slug";
import { ensureBrainRootFolder } from "./ensure-brain-root-folder";

export interface EnsureBrainDeps {
  uow: UnitOfWork;
  git: GitBackend;
  ids: IdGenerator;
  clock: Clock;
}

export interface EnsureBrainInput {
  orgId: string;
  name: string;
  /** Optional explicit slug; derived from `name` when omitted. */
  slug?: string;
  /** Grant this user admin on the brain's root folder, making the brain visible
   *  to them. Omit and the root stays unshared until granted. */
  ownerUserId?: string | null;
  actorId?: string | null;
}

/**
 * Idempotent: returns the existing brain with that slug, or creates it. Either
 * way it also ensures the brain's root folder exists (a normal folder mounted at
 * the brain root - see `ensureBrainRootFolder`), so every brain is writable at
 * its root from day one.
 */
export function ensureBrain(deps: EnsureBrainDeps) {
  const ensureRoot = ensureBrainRootFolder(deps);
  return (input: EnsureBrainInput): Promise<Result<Brain, DomainError>> =>
    asResult(async () => {
      const slug = input.slug ? makeSlug(input.slug) : slugify(input.name);
      const brain = await deps.uow.run(input.orgId, async (repos) => {
        const existing = await repos.brains.findBySlug(slug);
        if (existing) return existing;

        const created = createBrain({
          id: deps.ids.next(),
          orgId: input.orgId,
          name: input.name,
          slug,
          createdAt: deps.clock.now(),
        });
        await repos.brains.add(created);
        await repos.audit.record({
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: "brain.create",
          target: created.id,
        });
        return created;
      });

      const root = await ensureRoot({
        orgId: input.orgId,
        brainId: brain.id,
        ownerUserId: input.ownerUserId ?? null,
        actorId: input.actorId ?? null,
      });
      if (!root.ok) throw root.error;

      return brain;
    });
}
