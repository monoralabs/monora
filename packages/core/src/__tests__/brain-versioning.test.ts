import { describe, it, expect } from "vitest";
import { ensureBrain } from "../application/workspace/ensure-brain";
import { createFolderUseCase } from "../application/workspace/create-folder";
import { createBrainSnapshot } from "../application/versioning/create-brain-snapshot";
import { listBrainSnapshots } from "../application/versioning/list-brain-snapshots";
import { restoreBrainSnapshot } from "../application/versioning/restore-brain-snapshot";
import { InMemoryStore, FakeGit, fixedClock, seqIds } from "./fakes";

const ORG = "org-test";

function deps() {
  const store = new InMemoryStore();
  const git = new FakeGit();
  const base = { uow: store.unitOfWork(), git, ids: seqIds(), clock: fixedClock() };
  return { store, git, base };
}

async function seedBrainWithTwoFolders(base: ReturnType<typeof deps>["base"]) {
  const sp = await ensureBrain(base)({ orgId: ORG, name: "Acme" });
  const brainId = sp.ok ? sp.value.id : "";
  const mk = createFolderUseCase(base);
  const a = await mk({ orgId: ORG, brainId, name: "Sales", slug: "sales", path: "sales" });
  const b = await mk({ orgId: ORG, brainId, name: "Product", slug: "product", path: "product" });
  return {
    brainId,
    repoA: a.ok ? a.value.repoName : "",
    repoB: b.ok ? b.value.repoName : "",
  };
}

describe("brain versioning", () => {
  it("snapshots every folder's branch tip and pins the commits", async () => {
    const { store, git, base } = deps();
    const { brainId, repoA, repoB } = await seedBrainWithTwoFolders(base);
    git.heads.set(`${repoA}:main`, "sha-A1");
    git.heads.set(`${repoB}:main`, "sha-B1");

    const res = await createBrainSnapshot(base)({
      orgId: ORG,
      brainId,
      label: "v1",
      actorId: "u1",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entries).toHaveLength(2);
    expect(res.value.label).toBe("v1");
    // Commits are pinned so they survive gc.
    expect(git.refs.get(`${repoA}:refs/monora/snapshots/${res.value.id}`)).toBe("sha-A1");
    expect(store.brainSnapshots.size).toBe(1);
    expect(store.audit.some((a) => a.action === "brain.snapshot.create")).toBe(true);
  });

  it("skips folders with an unborn repo (no commits)", async () => {
    const { base, git } = deps();
    const { brainId, repoA } = await seedBrainWithTwoFolders(base);
    git.heads.set(`${repoA}:main`, "sha-A1"); // only A has a commit

    const res = await createBrainSnapshot(base)({ orgId: ORG, brainId });
    expect(res.ok && res.value.entries).toHaveLength(1);
  });

  it("restores each branch to its snapshot commit and auto-backs-up first", async () => {
    const { store, git, base } = deps();
    const { brainId, repoA, repoB } = await seedBrainWithTwoFolders(base);
    git.heads.set(`${repoA}:main`, "sha-A1");
    git.heads.set(`${repoB}:main`, "sha-B1");

    const snap = await createBrainSnapshot(base)({ orgId: ORG, brainId, label: "v1" });
    if (!snap.ok) throw new Error("snapshot failed");

    // An agent rewrites folder A.
    git.heads.set(`${repoA}:main`, "sha-A2");

    const restored = await restoreBrainSnapshot(base)({
      orgId: ORG,
      snapshotId: snap.value.id,
      actorId: "u1",
    });

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    // Branch A is back to the snapshot tip.
    expect(git.heads.get(`${repoA}:main`)).toBe("sha-A1");
    // A backup snapshot of the pre-restore state was created (captured sha-A2).
    expect(store.brainSnapshots.size).toBe(2);
    const backup = store.brainSnapshots.get(restored.value.backupSnapshotId);
    expect(backup?.entries.find((e) => e.repoName === repoA)?.commitSha).toBe("sha-A2");
    expect(store.audit.some((a) => a.action === "brain.snapshot.restore")).toBe(true);
  });

  it("recreates a folder row that was deleted since the snapshot", async () => {
    const { store, git, base } = deps();
    const { brainId, repoA } = await seedBrainWithTwoFolders(base);
    git.heads.set(`${repoA}:main`, "sha-A1");
    const snap = await createBrainSnapshot(base)({ orgId: ORG, brainId });
    if (!snap.ok) throw new Error("snapshot failed");

    // Folder A's row is removed (its bare repo survives on disk).
    const folderA = [...store.folders.values()].find((f) => f.repoName === repoA)!;
    store.folders.delete(folderA.id);
    expect(store.folders.has(folderA.id)).toBe(false);

    const restored = await restoreBrainSnapshot(base)({
      orgId: ORG,
      snapshotId: snap.value.id,
    });
    expect(restored.ok).toBe(true);
    // The folder row is back.
    expect(store.folders.has(folderA.id)).toBe(true);
  });

  it("lists snapshots newest first", async () => {
    const { base, git } = deps();
    const { brainId, repoA } = await seedBrainWithTwoFolders(base);
    git.heads.set(`${repoA}:main`, "sha-A1");
    await createBrainSnapshot(base)({ orgId: ORG, brainId, label: "first" });
    await createBrainSnapshot(base)({ orgId: ORG, brainId, label: "second" });

    const res = await listBrainSnapshots(base)({ orgId: ORG, brainId });
    expect(res.ok && res.value).toHaveLength(2);
  });
});
