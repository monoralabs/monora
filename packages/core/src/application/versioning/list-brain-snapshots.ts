import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { BrainSnapshot } from "../../domain/versioning/brain-snapshot";

export interface ListBrainSnapshotsDeps {
  uow: UnitOfWork;
}

export interface ListBrainSnapshotsInput {
  orgId: string;
  brainId: string;
}

/** List a brain's snapshots, newest first. Admin gate is at the interface. */
export function listBrainSnapshots(deps: ListBrainSnapshotsDeps) {
  return (
    input: ListBrainSnapshotsInput,
  ): Promise<Result<BrainSnapshot[], DomainError>> =>
    asResult(() =>
      deps.uow.run(input.orgId, (repos) =>
        repos.snapshots.listByBrain(input.brainId),
      ),
    );
}
