import { describe, it, expect } from "vitest";
import { ensureBrain } from "../application/workspace/ensure-brain";
import { createFolderUseCase } from "../application/workspace/create-folder";
import { importFolderUseCase } from "../application/workspace/import-folder";
import { InMemoryStore, FakeGit, fixedClock, seqIds } from "./fakes";

const ORG = "org-test";

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

describe("ensureBrain", () => {
  it("creates once and is idempotent", async () => {
    const { store, base } = deps();
    const run = ensureBrain(base);

    const first = await run({ orgId: ORG, name: "Dreamshot" });
    expect(first.ok).toBe(true);
    const second = await run({ orgId: ORG, name: "Dreamshot" });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.id).toBe(first.value.id);

    expect(store.brains.size).toBe(1);
    expect(store.audit.filter((a) => a.action === "brain.create")).toHaveLength(1);
  });

  it("provisions the brain root folder once, mounted at the brain root", async () => {
    const { store, git, base } = deps();
    const run = ensureBrain(base);

    const sp = await run({ orgId: ORG, name: "Dreamshot", ownerUserId: "u1" });
    await run({ orgId: ORG, name: "Dreamshot", ownerUserId: "u1" });
    const brainId = sp.ok ? sp.value.id : "";

    const roots = [...store.folders.values()].filter((f) => f.slug === "_root");
    expect(roots).toHaveLength(1); // idempotent: never a second root
    const root = roots[0]!;
    expect(root.repoName).toBe(`${brainId}/_root.git`);
    expect(root.parentFolderId).toBeNull();
    // Its bare repo was created, and the owner can see the brain.
    expect(git.ensured).toContain(`${brainId}/_root.git`);
    const grant = await store.repositories().grants.find(root.id, "u1");
    expect(grant?.permission).toBe("admin");
  });
});

describe("createFolderUseCase", () => {
  it("creates a bare repo and a row, audited", async () => {
    const { store, git, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Dreamshot" });
    expect(sp.ok).toBe(true);
    const brainId = sp.ok ? sp.value.id : "";

    const res = await createFolderUseCase(base)({
      orgId: ORG,
      brainId,
      name: "Product Development",
      slug: "product-development",
      path: "product-development",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.repoName).toBe(`${brainId}/product-development.git`);
      expect(res.value.defaultBranch).toBe("main");
    }
    // Two repos/rows: the brain root folder (ensured by ensureBrain) + this one.
    expect(git.ensured).toHaveLength(2);
    expect(store.folders.size).toBe(2);
    expect(store.audit.some((a) => a.action === "folder.create")).toBe(true);
  });

  it("rejects a duplicate slug in the same brain (conflict)", async () => {
    const { base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Dreamshot" });
    const brainId = sp.ok ? sp.value.id : "";
    const mk = createFolderUseCase(base);
    await mk({ orgId: ORG, brainId, name: "A", slug: "a", path: "a" });
    const dup = await mk({ orgId: ORG, brainId, name: "A2", slug: "a", path: "a2" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("conflict");
  });

  it("nests a folder under a parent and copies its access (copy-on-create)", async () => {
    const { store, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Dreamshot" });
    const brainId = sp.ok ? sp.value.id : "";
    const mk = createFolderUseCase(base);

    const parent = await mk({ orgId: ORG, brainId, name: "Sales", slug: "sales", path: "sales" });
    const parentId = parent.ok ? parent.value.id : "";
    // Someone has access to the parent.
    await store.repositories().grants.grant({
      orgId: ORG,
      folderId: parentId,
      userId: "u1",
      permission: "write",
    });

    const child = await mk({
      orgId: ORG,
      brainId,
      name: "Brand",
      slug: "brand",
      parentFolderId: parentId,
    });

    expect(child.ok).toBe(true);
    if (child.ok) {
      expect(child.value.parentFolderId).toBe(parentId);
      expect(child.value.path).toBe("sales/brand"); // derived from the parent
    }
    // The child inherited the parent's grant at creation time.
    const childId = child.ok ? child.value.id : "";
    const inherited = await store.repositories().grants.find(childId, "u1");
    expect(inherited?.permission).toBe("write");
  });

  it("fails when the parent folder does not exist (not_found)", async () => {
    const { base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Dreamshot" });
    const brainId = sp.ok ? sp.value.id : "";
    const res = await createFolderUseCase(base)({
      orgId: ORG,
      brainId,
      name: "X",
      slug: "x",
      parentFolderId: "missing",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });

  it("fails when the brain does not exist (not_found)", async () => {
    const { base } = deps();
    const res = await createFolderUseCase(base)({
      orgId: ORG,
      brainId: "missing",
      name: "X",
      slug: "x",
      path: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});

describe("importFolderUseCase", () => {
  it("ensures repo, pushes a snapshot, upserts the row, idempotently", async () => {
    const { store, git, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Dreamshot" });
    const brainId = sp.ok ? sp.value.id : "";

    const run = importFolderUseCase(base);
    const input = {
      orgId: ORG,
      brainId,
      name: "Sales Development",
      slug: "sales-development",
      path: "sales-development",
      sourceDir: "/tmp/org/sales-development",
    };

    const first = await run(input);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.created).toBe(true);

    const second = await run(input);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.created).toBe(false);

    // one imported row (+ the brain root folder), two snapshots (re-ingest),
    // two audit entries
    expect(store.folders.size).toBe(2);
    expect(git.snapshots).toHaveLength(2);
    expect(store.audit.filter((a) => a.action === "folder.ingest")).toHaveLength(2);
  });

  it("re-ingest reconciles an existing folder's path, name and parent to the map", async () => {
    const { store, base } = deps();
    const sp = await ensureBrain(base)({ orgId: ORG, name: "Dreamshot" });
    const brainId = sp.ok ? sp.value.id : "";
    const run = importFolderUseCase(base);

    // First import: a department imported as a LOOSE top-level mount (no parent),
    // the exact drift we are healing in prod.
    const first = await run({
      orgId: ORG,
      brainId,
      name: "Dept Sales",
      slug: "dept-sales",
      path: "departments/sales",
      sourceDir: "/tmp/org/departments/sales",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.folder.parentFolderId).toBeNull();

    // Now a `departments` parent appears in the corrected map.
    const parent = await run({
      orgId: ORG,
      brainId,
      name: "Departments",
      slug: "departments",
      path: "departments",
      sourceDir: "/tmp/org/departments",
    });
    const parentId = parent.ok ? parent.value.folder.id : "";

    // Re-ingest the department, now declared under the parent: it must reconcile
    // in place (same row, created:false), not create a duplicate.
    const reconciled = await run({
      orgId: ORG,
      brainId,
      name: "Dept Sales",
      slug: "dept-sales",
      path: "departments/sales",
      sourceDir: "/tmp/org/departments/sales",
      parentFolderId: parentId,
    });
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      expect(reconciled.value.created).toBe(false);
      expect(reconciled.value.folder.id).toBe(first.ok ? first.value.folder.id : "");
      expect(reconciled.value.folder.parentFolderId).toBe(parentId);
      expect(reconciled.value.folder.path).toBe("departments/sales");
    }

    // Two imported rows (departments + dept-sales) + the brain root folder,
    // never a duplicate dept row, and the reconcile is audited.
    expect(store.folders.size).toBe(3);
    expect(
      store.audit.filter(
        (a) => a.action === "folder.ingest" && a.metadata?.reconciled === true,
      ),
    ).toHaveLength(1);
  });
});
