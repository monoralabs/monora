import { describe, it, expect } from "vitest";
import { generateManifest } from "../application/distribution/generate-manifest";
import type { Permission } from "../domain/access/permission";
import type { Folder } from "../domain/workspace/folder";
import { InMemoryStore, fakeAuthz } from "./fakes";

const ORG = "org1";
const USER = "user1";

function folder(id: string, slug: string): Folder {
  return {
    id,
    orgId: ORG,
    brainId: "space1",
    parentFolderId: null,
    name: slug,
    slug: slug as never,
    path: slug as never,
    repoName: `space1/${slug}.git` as never,
    defaultBranch: "main",
    createdAt: new Date("2026-05-30T00:00:00Z"),
  };
}

/** Seed the brain row the manifest reads to map brain id -> human slug for the
 *  mount path (repo names are keyed by brain id, org-independent). */
function seedBrain(store: InMemoryStore) {
  store.brains.set("space1", {
    id: "space1",
    orgId: ORG,
    name: "Dreamshot",
    slug: "dreamshot" as never,
    createdAt: new Date("2026-05-30T00:00:00Z"),
  });
}

function setup(grants: Record<string, Permission>) {
  const store = new InMemoryStore();
  seedBrain(store);
  store.folders.set("f-alpha", folder("f-alpha", "alpha"));
  store.folders.set("f-beta", folder("f-beta", "beta"));
  const g = new Map<string, Permission>();
  for (const [folderId, perm] of Object.entries(grants)) {
    g.set(`${USER}:${folderId}`, perm);
  }
  const run = generateManifest({ uow: store.unitOfWork(), authz: fakeAuthz(g) });
  return { run };
}

describe("generateManifest", () => {
  it("lists ONLY folders the subject can read, with clone URLs + mount paths", async () => {
    const { run } = setup({ "f-alpha": "read" });
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai/",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entries).toHaveLength(1);
    const e = res.value.entries[0]!;
    expect(e.folderId).toBe("f-alpha");
    expect(e.mountPath).toBe("dreamshot/alpha");
    expect(e.cloneUrl).toBe("https://git.monora.ai/space1/alpha.git");
    expect(e.permission).toBe("read");
  });

  it("reports the highest permission held", async () => {
    const { run } = setup({ "f-alpha": "admin", "f-beta": "write" });
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai",
    });
    if (!res.ok) throw new Error("expected ok");
    const byId = Object.fromEntries(
      res.value.entries.map((e) => [e.folderId, e.permission]),
    );
    expect(byId["f-alpha"]).toBe("admin");
    expect(byId["f-beta"]).toBe("write");
  });

  it("returns an empty manifest when the subject can read nothing", async () => {
    const { run } = setup({});
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai",
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries).toHaveLength(0);
  });

  it("mounts the brain root folder at the brain root, not a subpath", async () => {
    const store = new InMemoryStore();
    seedBrain(store);
    store.folders.set("f-root", folder("f-root", "_root"));
    store.folders.set("f-alpha", folder("f-alpha", "alpha"));
    const g = new Map<string, Permission>([
      [`${USER}:f-root`, "admin"],
      [`${USER}:f-alpha`, "read"],
    ]);
    const run = generateManifest({
      uow: store.unitOfWork(),
      authz: fakeAuthz(g),
    });
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai",
    });
    if (!res.ok) throw new Error("expected ok");
    const byId = Object.fromEntries(
      res.value.entries.map((e) => [e.folderId, e.mountPath]),
    );
    // Root folder mounts at the bare brain slug; everything else nests under it.
    expect(byId["f-root"]).toBe("dreamshot");
    expect(byId["f-alpha"]).toBe("dreamshot/alpha");
  });

  // --- token scopes (Phase 5 agent tokens) ---
  // Regression guard: a folder-scoped token must NOT see other folders through
  // the manifest, which /manifest and /search both build. Before the fix, scope
  // was only enforced on the git clone/push path, so a scoped token could read
  // the whole org brain via /search and /manifest.

  it("a scoped token sees ONLY folders in its scope, even when the subject can read more", async () => {
    const { run } = setup({ "f-alpha": "read", "f-beta": "read" });
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai",
      scopes: ["f-alpha"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.map((e) => e.folderId)).toEqual(["f-alpha"]);
  });

  it("scope intersects the ACL, never widens it (scoped to a folder the subject cannot read => excluded)", async () => {
    const { run } = setup({ "f-alpha": "read" }); // f-beta NOT granted
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai",
      scopes: ["f-alpha", "f-beta"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.map((e) => e.folderId)).toEqual(["f-alpha"]);
  });

  it("null/absent scopes keep the full readable set (unrestricted token)", async () => {
    const { run } = setup({ "f-alpha": "read", "f-beta": "read" });
    const res = await run({
      subject: { userId: USER, orgId: ORG },
      baseUrl: "https://git.monora.ai",
      scopes: null,
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.map((e) => e.folderId).sort()).toEqual([
      "f-alpha",
      "f-beta",
    ]);
  });
});
