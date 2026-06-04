import { describe, it, expect } from "vitest";
import { grantAccess } from "../application/access/grant-access";
import { revokeAccess } from "../application/access/revoke-access";
import { InMemoryStore } from "./fakes";
import type { Folder } from "../domain/workspace/folder";
import type { Slug } from "../domain/workspace/slug";
import type { MountPath } from "../domain/workspace/mount-path";
import type { RepoName } from "../domain/workspace/repo-name";

const ORG = "org1";

/** Seed a minimal folder into the store (identity + parent are what matter). */
function folder(
  store: InMemoryStore,
  id: string,
  brainId: string,
  parentFolderId: string | null,
): void {
  store.folders.set(id, {
    id,
    orgId: ORG,
    brainId,
    parentFolderId,
    name: id,
    slug: id as Slug,
    path: id as MountPath,
    repoName: `${brainId}/${id}.git` as RepoName,
    defaultBranch: "main",
    createdAt: new Date("2026-05-30T12:00:00.000Z"),
  } satisfies Folder);
}

describe("grantAccess / revokeAccess", () => {
  it("grants, changes, and revokes - with the right audit actions", async () => {
    const store = new InMemoryStore();
    const grant = grantAccess({ uow: store.unitOfWork() });
    const revoke = revokeAccess({ uow: store.unitOfWork() });

    const g1 = await grant({
      orgId: ORG,
      folderId: "f1",
      userId: "u1",
      permission: "read",
      actorId: "admin",
    });
    expect(g1.ok).toBe(true);
    expect(store.grants.get("f1:u1")?.permission).toBe("read");

    // Re-grant -> upsert to write, audited as a change.
    await grant({ orgId: ORG, folderId: "f1", userId: "u1", permission: "write" });
    expect(store.grants.get("f1:u1")?.permission).toBe("write");

    await revoke({ orgId: ORG, folderId: "f1", userId: "u1" });
    expect(store.grants.has("f1:u1")).toBe(false);

    const actions = store.audit.map((a) => a.action);
    expect(actions).toEqual(["access.grant", "access.change", "access.revoke"]);
  });

  it("includeDescendants grants/revokes the whole current subtree, not later folders", async () => {
    const store = new InMemoryStore();
    const grant = grantAccess({ uow: store.unitOfWork() });
    const revoke = revokeAccess({ uow: store.unitOfWork() });

    // work
    //  ├─ a       (work/a)
    //  │   └─ a1  (work/a/a1)
    //  └─ b       (work/b)
    // other       (a top-level sibling, NOT under work)
    folder(store, "work", "brain1", null);
    folder(store, "a", "brain1", "work");
    folder(store, "a1", "brain1", "a");
    folder(store, "b", "brain1", "work");
    folder(store, "other", "brain1", null);

    const g = await grant({
      orgId: ORG,
      folderId: "work",
      userId: "u1",
      permission: "read",
      includeDescendants: true,
      actorId: "admin",
    });
    expect(g.ok).toBe(true);

    // The whole subtree is granted...
    for (const f of ["work", "a", "a1", "b"]) {
      expect(store.grants.get(`${f}:u1`)?.permission).toBe("read");
    }
    // ...but the unrelated sibling is untouched.
    expect(store.grants.has("other:u1")).toBe(false);

    // A folder created AFTER the grant stays private (no live inheritance).
    folder(store, "c", "brain1", "work");
    expect(store.grants.has("c:u1")).toBe(false);

    // Revoking with the same flag clears the whole current subtree (incl. c).
    await revoke({
      orgId: ORG,
      folderId: "work",
      userId: "u1",
      includeDescendants: true,
    });
    for (const f of ["work", "a", "a1", "b", "c"]) {
      expect(store.grants.has(`${f}:u1`)).toBe(false);
    }
  });
});
