import { describe, it, expect } from "vitest";
import { ensureBrain } from "../application/workspace/ensure-brain";
import { createFolderUseCase } from "../application/workspace/create-folder";
import { importFolderUseCase } from "../application/workspace/import-folder";
import { archiveFolderUseCase } from "../application/workspace/archive-folder";
import { restoreFolderUseCase } from "../application/workspace/restore-folder";
import { listArchivedFolders } from "../application/workspace/list-archived-folders";
import { generateManifest } from "../application/distribution/generate-manifest";
import {
  InMemoryStore,
  FakeGit,
  fakeAuthz,
  fakeMemberships,
  fixedClock,
  seqIds,
} from "./fakes";
import type { Permission } from "../domain/access/permission";

const ORG = "org-test";
const USER = "u1";

function deps() {
  const store = new InMemoryStore();
  const git = new FakeGit();
  const base = {
    uow: store.unitOfWork(),
    git,
    ids: seqIds(),
    clock: fixedClock(),
  };
  return { store, git, base };
}

/** Seed a brain + a parent folder with a nested child; grant USER admin on both. */
async function seedTree(base: ReturnType<typeof deps>["base"], store: InMemoryStore) {
  const sp = await ensureBrain(base)({ orgId: ORG, name: "Acme" });
  const brainId = sp.ok ? sp.value.id : "";
  const mk = createFolderUseCase(base);
  const parent = await mk({ orgId: ORG, brainId, name: "Sales", slug: "sales", path: "sales" });
  const parentId = parent.ok ? parent.value.id : "";
  const child = await mk({
    orgId: ORG,
    brainId,
    name: "Brand",
    slug: "brand",
    parentFolderId: parentId,
  });
  const childId = child.ok ? child.value.id : "";
  const grants = new Map<string, Permission>([
    [`${USER}:${parentId}`, "admin"],
    [`${USER}:${childId}`, "admin"],
  ]);
  return { brainId, parentId, childId, grants };
}

describe("archiveFolderUseCase", () => {
  it("tombstones the folder and cascades to its subtree, audited", async () => {
    const { store, base } = deps();
    const { parentId, childId } = await seedTree(base, store);

    const res = await archiveFolderUseCase(base)({
      orgId: ORG,
      folderId: parentId,
      actorId: USER,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Parent + child both archived in one call.
      expect(res.value.archived.sort()).toEqual([parentId, childId].sort());
    }
    expect(store.folders.get(parentId)?.archivedAt).toBeInstanceOf(Date);
    expect(store.folders.get(childId)?.archivedAt).toBeInstanceOf(Date);
    expect(store.folders.get(parentId)?.archivedBy).toBe(USER);
    expect(store.audit.filter((a) => a.action === "folder.archive")).toHaveLength(2);
  });

  it("is idempotent: re-archiving an already-trashed folder logs nothing new", async () => {
    const { store, base } = deps();
    const { parentId } = await seedTree(base, store);
    const run = archiveFolderUseCase(base);
    await run({ orgId: ORG, folderId: parentId, actorId: USER });
    const again = await run({ orgId: ORG, folderId: parentId, actorId: USER });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.archived).toHaveLength(0);
    expect(store.audit.filter((a) => a.action === "folder.archive")).toHaveLength(2);
  });

  it("not_found for a missing folder", async () => {
    const { base } = deps();
    const res = await archiveFolderUseCase(base)({
      orgId: ORG,
      folderId: "nope",
      actorId: USER,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("manifest hides archived folders", () => {
  it("an archived folder drops out of the manifest; restore brings it back", async () => {
    const { store, base } = deps();
    const { brainId, parentId, childId, grants } = await seedTree(base, store);
    const manifest = generateManifest({
      uow: store.unitOfWork(),
      authz: fakeAuthz(grants),
      memberships: fakeMemberships({ [USER]: [ORG] }),
    });
    const subject = { userId: USER, orgId: ORG };

    const before = await manifest({ subject, baseUrl: "https://git.example" });
    expect(before.ok).toBe(true);
    const liveCount = before.ok ? before.value.entries.length : 0;
    expect(liveCount).toBeGreaterThanOrEqual(2); // parent + child (root not granted)

    await archiveFolderUseCase(base)({ orgId: ORG, folderId: parentId, actorId: USER });
    const after = await manifest({ subject, baseUrl: "https://git.example" });
    expect(after.ok).toBe(true);
    if (after.ok) {
      const ids = after.value.entries.map((e) => e.folderId);
      expect(ids).not.toContain(parentId);
      expect(ids).not.toContain(childId);
    }

    await restoreFolderUseCase({ uow: store.unitOfWork() })({
      orgId: ORG,
      folderId: parentId,
      actorId: USER,
    });
    const restored = await manifest({ subject, baseUrl: "https://git.example" });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.entries.length).toBe(liveCount);
    }
    void brainId;
  });
});

describe("listArchivedFolders (the trash)", () => {
  it("lists only archived folders the subject can administer", async () => {
    const { store, base } = deps();
    const { parentId, childId, grants } = await seedTree(base, store);
    await archiveFolderUseCase(base)({ orgId: ORG, folderId: parentId, actorId: USER });

    const res = await listArchivedFolders({
      uow: store.unitOfWork(),
      authz: fakeAuthz(grants),
    })({ subject: { userId: USER, orgId: ORG } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ids = res.value.map((f) => f.id).sort();
      expect(ids).toEqual([parentId, childId].sort());
    }
  });
});

describe("import-folder respects the tombstone", () => {
  it("does NOT resurrect an archived folder on re-ingest, and touches no git", async () => {
    const { store, git, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Acme" });
    const brainId = sp.ok ? sp.value.id : "";
    const run = importFolderUseCase(base);
    const input = {
      orgId: ORG,
      brainId,
      name: "Contacts",
      slug: "data-contacts",
      path: "data-contacts",
      sourceDir: "/tmp/org/data-contacts",
    };

    const first = await run(input);
    expect(first.ok && first.value.created).toBe(true);
    const folderId = first.ok ? first.value.folder.id : "";

    // User deletes it.
    await archiveFolderUseCase(base)({ orgId: ORG, folderId, actorId: USER });
    const snapshotsBefore = git.snapshots.length;

    // The ingest job runs again - it must NOT bring the folder back.
    const second = await run(input);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.skipped).toBe(true);
      expect(second.value.created).toBe(false);
    }
    expect(store.folders.get(folderId)?.archivedAt).toBeInstanceOf(Date);
    // No new snapshot was pushed: the bare repo content is left as the user left it.
    expect(git.snapshots.length).toBe(snapshotsBefore);
  });

  it("re-adopts an archived folder only with includeArchived", async () => {
    const { store, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Acme" });
    const brainId = sp.ok ? sp.value.id : "";
    const run = importFolderUseCase(base);
    const input = {
      orgId: ORG,
      brainId,
      name: "Contacts",
      slug: "data-contacts",
      path: "data-contacts",
      sourceDir: "/tmp/org/data-contacts",
    };
    const first = await run(input);
    const folderId = first.ok ? first.value.folder.id : "";
    await archiveFolderUseCase(base)({ orgId: ORG, folderId, actorId: USER });

    const forced = await run({ ...input, includeArchived: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.value.skipped).toBeUndefined();
    // It is back in the row (still archived flag until a restore clears it, but
    // the ingest path now wrote to it).
    expect(store.folders.get(folderId)).toBeTruthy();
  });

  it("marks ingested folders with source 'ingest'", async () => {
    const { store, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Acme" });
    const brainId = sp.ok ? sp.value.id : "";
    const res = await importFolderUseCase(base)({
      orgId: ORG,
      brainId,
      name: "Contacts",
      slug: "data-contacts",
      path: "data-contacts",
      sourceDir: "/tmp/org/data-contacts",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.folder.source).toBe("ingest");
  });
});

describe("create-folder: idempotent retry + case-insensitive collisions", () => {
  async function brain(base: ReturnType<typeof deps>["base"]) {
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Acme" });
    return sp.ok ? sp.value.id : "";
  }

  it("re-creating the same slug+path returns the EXISTING folder (connector retry)", async () => {
    const { base } = deps();
    const brainId = await brain(base);
    const mk = createFolderUseCase(base);
    const first = await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "notes" });
    expect(first.ok).toBe(true);

    // The connector's applyCreate re-POSTs after a half-failed run: same
    // logical request, must converge on the same folder, not 409.
    const retry = await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "notes" });
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.value.id).toBe(first.value.id);
      expect(retry.value.repoName).toBe(first.value.repoName);
    }
  });

  it("a DIFFERENT path under a taken slug still conflicts", async () => {
    const { base } = deps();
    const brainId = await brain(base);
    const mk = createFolderUseCase(base);
    await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "notes" });
    const res = await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "elsewhere/notes" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/already exists/);
  });

  it("a slug held by a TRASHED folder conflicts with a restore hint", async () => {
    const { base } = deps();
    const brainId = await brain(base);
    const mk = createFolderUseCase(base);
    const first = await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "notes" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await archiveFolderUseCase(base)({ orgId: ORG, folderId: first.value.id, actorId: USER });

    const res = await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "notes" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/trash|restore/i);
  });

  it("rejects a mount path that collides with a sibling's case-insensitively", async () => {
    const { base } = deps();
    const brainId = await brain(base);
    const mk = createFolderUseCase(base);
    const first = await mk({ orgId: ORG, brainId, name: "Notes", slug: "notes", path: "Notes" });
    expect(first.ok).toBe(true);

    // macOS's default filesystem mounts "Notes" and "notes" onto the same
    // directory - they can never coexist in a working tree.
    const res = await mk({ orgId: ORG, brainId, name: "Notes 2", slug: "notes-2", path: "notes" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/already mounts/);
  });
});
