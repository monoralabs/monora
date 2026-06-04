import { describe, it, expect } from "vitest";
import { readBrainFile, readBrainFileBytes } from "../application/workspace/read-file";
import { createFolder } from "../domain/workspace/folder";
import { makeSlug } from "../domain/workspace/slug";
import { makeMountPath } from "../domain/workspace/mount-path";
import { makeRepoName } from "../domain/workspace/repo-name";
import type { Permission } from "../domain/access/permission";
import { makeBlobPointer } from "../domain/git/blob-store";
import {
  InMemoryStore,
  FakeGit,
  FakeBlobStore,
  fakeAuthz,
  fixedClock,
} from "./fakes";

const ORG = "org1";
const REPO = makeRepoName("b1", makeSlug("docs"));

function seed(store: InMemoryStore, git: FakeGit) {
  const folder = createFolder({
    id: "f1",
    orgId: ORG,
    brainId: "b1",
    name: "Docs",
    slug: makeSlug("docs"),
    path: makeMountPath("docs"),
    repoName: REPO,
    defaultBranch: "main",
    createdAt: fixedClock().now(),
  });
  store.folders.set(folder.id, folder);
  git.contents.set(`${REPO}:vision.md`, "# Vision\n\nThe missing middle.");
}

describe("readBrainFile", () => {
  it("returns file content for a reader", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    seed(store, git);
    const read = readBrainFile({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(new Map<string, Permission>([["u1:f1", "read"]])),
    });

    const res = await read({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "vision.md",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.content).toContain("# Vision");
      expect(res.value.truncated).toBe(false);
      expect(res.value.path).toBe("vision.md");
    }
  });

  it("denies a user without read access", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    seed(store, git);
    const read = readBrainFile({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(new Map()),
    });
    const res = await read({
      subject: { userId: "stranger", orgId: ORG },
      folderId: "f1",
      path: "vision.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("rejects path traversal", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    seed(store, git);
    const read = readBrainFile({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(new Map<string, Permission>([["u1:f1", "read"]])),
    });
    const res = await read({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "../secrets.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
  });
});

describe("readBrainFileBytes", () => {
  it("returns raw bytes for a reader", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    seed(store, git);
    const read = readBrainFileBytes({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(new Map<string, Permission>([["u1:f1", "read"]])),
    });

    const res = await read({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "vision.md",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.path).toBe("vision.md");
      expect(new TextDecoder().decode(res.value.bytes)).toContain("# Vision");
    }
  });

  it("denies a user without read access", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    seed(store, git);
    const read = readBrainFileBytes({
      uow: store.unitOfWork(),
      git,
      authz: fakeAuthz(new Map()),
    });
    const res = await read({
      subject: { userId: "stranger", orgId: ORG },
      folderId: "f1",
      path: "vision.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });
});

describe("readBrainFileBytes - blob pointers (4.7.1)", () => {
  const ALLOW = () =>
    fakeAuthz(new Map<string, Permission>([["u1:f1", "read"]]));

  it("resolves a pointer to the real bytes from the blob store", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    const blobStore = new FakeBlobStore();
    seed(store, git);

    // The "image" bytes live in the blob store; git holds only the pointer.
    const imageBytes = new TextEncoder().encode("PNGDATA");
    const ref = await blobStore.put(imageBytes, "image/png");
    git.contents.set(
      `${REPO}:logo.png`,
      makeBlobPointer(ref, "logo.png"),
    );

    const read = readBrainFileBytes({
      uow: store.unitOfWork(),
      git,
      authz: ALLOW(),
      blobStore,
    });
    const res = await read({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "logo.png",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(new TextDecoder().decode(res.value.bytes)).toBe("PNGDATA");
      expect(res.value.path).toBe("logo.png");
    }
  });

  it("denies a pointer when no blob store is configured", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    seed(store, git);
    git.contents.set(
      `${REPO}:logo.png`,
      makeBlobPointer(
        { sha256: "sha-x", size: 7, contentType: "image/png" },
        "logo.png",
      ),
    );
    const read = readBrainFileBytes({
      uow: store.unitOfWork(),
      git,
      authz: ALLOW(),
    });
    const res = await read({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "logo.png",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation");
  });

  it("still serves a plain (non-pointer) file straight from git", async () => {
    const store = new InMemoryStore();
    const git = new FakeGit();
    const blobStore = new FakeBlobStore();
    seed(store, git);
    const read = readBrainFileBytes({
      uow: store.unitOfWork(),
      git,
      authz: ALLOW(),
      blobStore,
    });
    const res = await read({
      subject: { userId: "u1", orgId: ORG },
      folderId: "f1",
      path: "vision.md",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(new TextDecoder().decode(res.value.bytes)).toContain("# Vision");
    }
  });
});
