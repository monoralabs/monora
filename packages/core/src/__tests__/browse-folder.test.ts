import { describe, it, expect } from "vitest";
import { browseFolder } from "../application/workspace/browse-folder";
import { createFolder } from "../domain/workspace/folder";
import { makeSlug } from "../domain/workspace/slug";
import { makeMountPath } from "../domain/workspace/mount-path";
import { makeRepoName } from "../domain/workspace/repo-name";
import type { Permission } from "../domain/access/permission";
import { InMemoryStore, FakeGit, fakeAuthz, fixedClock } from "./fakes";

const ORG = "org1";
const REPO = makeRepoName("s1", makeSlug("docs"));

function seedFolder(store: InMemoryStore) {
  const folder = createFolder({
    id: "f1",
    orgId: ORG,
    brainId: "s1",
    name: "Docs",
    slug: makeSlug("docs"),
    path: makeMountPath("docs"),
    repoName: REPO,
    defaultBranch: "main",
    createdAt: fixedClock().now(),
  });
  store.folders.set(folder.id, folder);
}

describe("browseFolder", () => {
  it("derives the immediate children at a path (dirs first, alpha), gated by can(read)", async () => {
    const store = new InMemoryStore();
    seedFolder(store);
    const git = new FakeGit();
    git.files.set(REPO, [
      "README.md",
      "icp.md",
      "brand/brand.md",
      "brand/tokens.css",
      "brand/explorations/a.html",
    ]);
    const grants = new Map<string, Permission>([["u1:f1", "read"]]);

    const browse = browseFolder({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(grants),
    });

    const root = await browse({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
    });
    expect(root.ok).toBe(true);
    if (root.ok) {
      expect(root.value).toEqual([
        { name: "brand", type: "dir", path: "brand" },
        { name: "icp.md", type: "file", path: "icp.md" },
        { name: "README.md", type: "file", path: "README.md" },
      ]);
    }

    const sub = await browse({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "brand",
    });
    expect(sub.ok).toBe(true);
    if (sub.ok) {
      expect(sub.value).toEqual([
        { name: "explorations", type: "dir", path: "brand/explorations" },
        { name: "brand.md", type: "file", path: "brand/brand.md" },
        { name: "tokens.css", type: "file", path: "brand/tokens.css" },
      ]);
    }
  });

  it("denies (uniformly) a user without read access", async () => {
    const store = new InMemoryStore();
    seedFolder(store);
    const git = new FakeGit();
    git.files.set(REPO, ["secret.md"]);

    const browse = browseFolder({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(new Map()), // no grants
    });

    const res = await browse({
      subject: { userId: "stranger", orgId: ORG },
      folderId: "f1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("denies a missing folder the same way as a forbidden one", async () => {
    const store = new InMemoryStore();
    const browse = browseFolder({
      uow: store.unitOfWork(),
      git: new FakeGit(),
      authz: fakeAuthz(new Map([["u1:f1", "admin"]])),
    });
    const res = await browse({
      subject: { userId: "u1", orgId: ORG },
      folderId: "does-not-exist",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });
});
