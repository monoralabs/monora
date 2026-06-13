import { describe, it, expect } from "vitest";
import { createGroupUseCase } from "../application/access/groups/create-group";
import { renameGroup } from "../application/access/groups/rename-group";
import { deleteGroup } from "../application/access/groups/delete-group";
import { addGroupMember } from "../application/access/groups/add-group-member";
import { removeGroupMember } from "../application/access/groups/remove-group-member";
import { grantGroupAccess } from "../application/access/groups/grant-group-access";
import { revokeGroupAccess } from "../application/access/groups/revoke-group-access";
import { listGroups } from "../application/access/groups/list-groups";
import { grantAccess } from "../application/access/grant-access";
import { revokeAccess } from "../application/access/revoke-access";
import { generateManifest } from "../application/distribution/generate-manifest";
import {
  InMemoryStore,
  storeAuthz,
  fakeMemberships,
  fixedClock,
  seqIds,
} from "./fakes";
import type { Subject } from "../domain/access/authz";
import type { Folder } from "../domain/workspace/folder";
import type { Slug } from "../domain/workspace/slug";
import type { MountPath } from "../domain/workspace/mount-path";
import type { RepoName } from "../domain/workspace/repo-name";

const ORG = "org1";
const ESTEFANIA = "estefania";
const CARLOS = "carlos";
const subj = (userId: string): Subject => ({ userId, orgId: ORG });

/** Seed a minimal folder into the store. */
function folder(
  store: InMemoryStore,
  id: string,
  parentFolderId: string | null,
  slug = id,
): void {
  store.folders.set(id, {
    id,
    orgId: ORG,
    brainId: "brain1",
    parentFolderId,
    name: id,
    slug: slug as Slug,
    path: slug as MountPath,
    repoName: `brain1/${slug}.git` as RepoName,
    defaultBranch: "main",
    source: "user",
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date("2026-05-30T12:00:00.000Z"),
  } satisfies Folder);
}

/** Bind every use-case + a store-backed authz to one store. */
function wire(store: InMemoryStore) {
  const uow = store.unitOfWork();
  return {
    store,
    authz: storeAuthz(store),
    createGroup: createGroupUseCase({
      uow,
      ids: seqIds("grp"),
      clock: fixedClock(),
    }),
    renameGroup: renameGroup({ uow }),
    deleteGroup: deleteGroup({ uow }),
    addMember: addGroupMember({ uow }),
    removeMember: removeGroupMember({ uow }),
    grantGroup: grantGroupAccess({ uow }),
    revokeGroup: revokeGroupAccess({ uow }),
    listGroups: listGroups({ uow }),
    grantDirect: grantAccess({ uow }),
    revokeDirect: revokeAccess({ uow }),
  };
}

type Wired = ReturnType<typeof wire>;

async function mkGroup(w: Wired, name: string): Promise<string> {
  const r = await w.createGroup({ orgId: ORG, name, actorId: "admin" });
  if (!r.ok) throw new Error(`createGroup failed: ${r.error.message}`);
  return r.value.id;
}

const level = (w: Wired, userId: string, folderId: string) =>
  w.authz.levelFor(subj(userId), folderId);

describe("group access - effective permission (MAX of direct + groups)", () => {
  it("a group grant gives its members access; a direct grant raises it (MAX)", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe("read");

    // A direct write on top -> MAX(read, write) = write.
    await w.grantDirect({
      orgId: ORG,
      folderId: "slides",
      userId: ESTEFANIA,
      permission: "write",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe("write");

    // Drop the direct grant -> falls back to the group's read, NOT to nothing.
    await w.revokeDirect({ orgId: ORG, folderId: "slides", userId: ESTEFANIA });
    expect(await level(w, ESTEFANIA, "slides")).toBe("read");
  });

  it("Caso 1: a direct revoke cannot take away access that comes from a group", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe("read");

    // Admin tries to "remove Estefania from slides" with a direct revoke.
    // The union only adds, so this no-ops on group-derived access.
    await w.revokeDirect({ orgId: ORG, folderId: "slides", userId: ESTEFANIA });
    expect(await level(w, ESTEFANIA, "slides")).toBe("read");

    // The real ways to remove it: take her out of the group...
    await w.removeMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    expect(await level(w, ESTEFANIA, "slides")).toBe(null);
  });

  it("Caso 1b: removing the folder from the group removes it for everyone without a direct grant", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.addMember({ orgId: ORG, groupId: sales, userId: CARLOS });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
    });
    // Carlos also has a direct grant on the same folder.
    await w.grantDirect({
      orgId: ORG,
      folderId: "slides",
      userId: CARLOS,
      permission: "read",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe("read");
    expect(await level(w, CARLOS, "slides")).toBe("read");

    await w.revokeGroup({ orgId: ORG, groupId: sales, folderId: "slides" });
    // Estefania loses it (only had it via the group); Carlos keeps his direct.
    expect(await level(w, ESTEFANIA, "slides")).toBe(null);
    expect(await level(w, CARLOS, "slides")).toBe("read");
  });

  it("Caso 2: a direct grant for a folder the group lacks works and revokes cleanly", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    // Sales has no grant on finance/budget.
    await w.grantDirect({
      orgId: ORG,
      folderId: "finance-budget",
      userId: ESTEFANIA,
      permission: "read",
    });
    expect(await level(w, ESTEFANIA, "finance-budget")).toBe("read");

    // No group grant to resurrect it, so the direct revoke is final.
    await w.revokeDirect({
      orgId: ORG,
      folderId: "finance-budget",
      userId: ESTEFANIA,
    });
    expect(await level(w, ESTEFANIA, "finance-budget")).toBe(null);
  });

  it("a member of two groups gets the highest permission across them", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    const exec = await mkGroup(w, "Exec");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.addMember({ orgId: ORG, groupId: exec, userId: ESTEFANIA });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
    });
    await w.grantGroup({
      orgId: ORG,
      groupId: exec,
      folderId: "slides",
      permission: "admin",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe("admin");
  });

  it("a non-member sees nothing through the group", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "admin",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe(null);
  });
});

describe("group lifecycle", () => {
  it("deleting a group removes the access it provided (cascade)", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "write",
    });
    expect(await level(w, ESTEFANIA, "slides")).toBe("write");

    await w.deleteGroup({ orgId: ORG, groupId: sales });
    expect(await level(w, ESTEFANIA, "slides")).toBe(null);
    expect(w.store.groups.size).toBe(0);
    expect(w.store.groupMembers).toHaveLength(0);
    expect(w.store.groupGrants.size).toBe(0);
  });

  it("rejects a duplicate group slug in the same org", async () => {
    const w = wire(new InMemoryStore());
    await mkGroup(w, "Sales");
    const dup = await w.createGroup({ orgId: ORG, name: "Sales" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("conflict");
  });

  it("listGroups reports member and grant counts", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.addMember({ orgId: ORG, groupId: sales, userId: CARLOS });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
    });
    const res = await w.listGroups({ orgId: ORG });
    if (!res.ok) throw new Error("listGroups failed");
    expect(res.value).toHaveLength(1);
    expect(res.value[0]!.memberCount).toBe(2);
    expect(res.value[0]!.grantCount).toBe(1);
  });

  it("addMember is idempotent (no duplicate rows)", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    expect(w.store.groupMembers).toHaveLength(1);
  });
});

describe("group grant - includeDescendants (current subtree only)", () => {
  it("grants the whole current subtree, not later folders", async () => {
    const w = wire(new InMemoryStore());
    // work ─ a ─ a1 ; work ─ b ; other (unrelated sibling)
    folder(w.store, "work", null);
    folder(w.store, "a", "work");
    folder(w.store, "a1", "a");
    folder(w.store, "b", "work");
    folder(w.store, "other", null);

    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "work",
      permission: "read",
      includeDescendants: true,
    });

    for (const f of ["work", "a", "a1", "b"]) {
      expect(await level(w, ESTEFANIA, f)).toBe("read");
    }
    expect(await level(w, ESTEFANIA, "other")).toBe(null);

    // A folder created AFTER the grant stays private (no live inheritance).
    folder(w.store, "c", "work");
    expect(await level(w, ESTEFANIA, "c")).toBe(null);
  });
});

describe("group access - audit trail", () => {
  it("records membership and grant changes, not just per-user grants", async () => {
    const w = wire(new InMemoryStore());
    const sales = await mkGroup(w, "Sales");
    await w.addMember({
      orgId: ORG,
      groupId: sales,
      userId: ESTEFANIA,
      actorId: "admin",
    });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
      actorId: "admin",
    });
    // Re-grant at a higher level -> audited as a change, not a new grant.
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "write",
      actorId: "admin",
    });
    await w.revokeGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      actorId: "admin",
    });
    await w.removeMember({
      orgId: ORG,
      groupId: sales,
      userId: ESTEFANIA,
      actorId: "admin",
    });
    await w.renameGroup({ orgId: ORG, groupId: sales, name: "Sales Team" });
    await w.deleteGroup({ orgId: ORG, groupId: sales });

    expect(w.store.audit.map((a) => a.action)).toEqual([
      "group.create",
      "group.member.add",
      "group.grant",
      "group.change",
      "group.revoke",
      "group.member.remove",
      "group.rename",
      "group.delete",
    ]);
  });
});

describe("group access flows through the manifest (single-point authz)", () => {
  function seedBrain(store: InMemoryStore) {
    store.brains.set("brain1", {
      id: "brain1",
      orgId: ORG,
      name: "Acme",
      slug: "acme" as Slug,
      createdAt: new Date("2026-05-30T00:00:00Z"),
    });
  }

  it("lists a folder reached only through a group, and drops it when the group grant goes away", async () => {
    const w = wire(new InMemoryStore());
    seedBrain(w.store);
    folder(w.store, "slides", null, "slides");

    const sales = await mkGroup(w, "Sales");
    await w.addMember({ orgId: ORG, groupId: sales, userId: ESTEFANIA });
    await w.grantGroup({
      orgId: ORG,
      groupId: sales,
      folderId: "slides",
      permission: "read",
    });

    const run = generateManifest({
      uow: w.store.unitOfWork(),
      authz: w.authz,
      memberships: fakeMemberships({}),
    });

    let res = await run({
      subject: subj(ESTEFANIA),
      baseUrl: "https://git.monora.ai",
    });
    if (!res.ok) throw new Error("manifest failed");
    expect(res.value.entries.map((e) => e.folderId)).toEqual(["slides"]);
    expect(res.value.entries[0]!.permission).toBe("read");

    // Remove the folder from the group -> next manifest no longer lists it,
    // which is exactly what triggers the connector's flagged-if-dirty prune.
    await w.revokeGroup({ orgId: ORG, groupId: sales, folderId: "slides" });
    res = await run({
      subject: subj(ESTEFANIA),
      baseUrl: "https://git.monora.ai",
    });
    if (!res.ok) throw new Error("manifest failed");
    expect(res.value.entries).toHaveLength(0);
  });
});
