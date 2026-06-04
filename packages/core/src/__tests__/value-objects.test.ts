import { describe, it, expect } from "vitest";
import { makeSlug, slugify } from "../domain/workspace/slug";
import {
  makeMountPath,
  mountPathsOverlap,
  assertDisjoint,
  type MountPath,
} from "../domain/workspace/mount-path";
import { makeRepoName } from "../domain/workspace/repo-name";
import { permissionSatisfies, makePermission } from "../domain/access/permission";
import { DomainError } from "../shared/errors";

describe("Slug", () => {
  it("accepts kebab-case", () => {
    expect(makeSlug("product-development")).toBe("product-development");
  });
  it("rejects brains and uppercase", () => {
    expect(() => makeSlug("Bad Slug")).toThrow(DomainError);
    expect(() => makeSlug("--x")).toThrow(DomainError);
  });
  it("slugify derives from a display name", () => {
    expect(slugify("Sales Development!")).toBe("sales-development");
  });
});

describe("MountPath", () => {
  it("strips slashes and validates segments", () => {
    expect(makeMountPath("/a/b/")).toBe("a/b");
  });
  it("rejects traversal and empties", () => {
    expect(() => makeMountPath("../etc")).toThrow(DomainError);
    expect(() => makeMountPath("")).toThrow(DomainError);
    expect(() => makeMountPath("a//b")).toThrow(DomainError);
  });
  it("detects nesting/overlap", () => {
    const a = makeMountPath("sales");
    const b = makeMountPath("sales/brand");
    const c = makeMountPath("product");
    expect(mountPathsOverlap(a, b)).toBe(true);
    expect(mountPathsOverlap(a, c)).toBe(false);
  });
  it("assertDisjoint throws on nested mounts", () => {
    const paths = ["sales", "sales/brand"].map(makeMountPath) as MountPath[];
    expect(() => assertDisjoint(paths)).toThrow(/Overlapping/);
    expect(() =>
      assertDisjoint(["sales", "product"].map(makeMountPath) as MountPath[]),
    ).not.toThrow();
  });
});

describe("RepoName", () => {
  it("composes brainId/folder.git", () => {
    expect(makeRepoName("brain123", makeSlug("sales"))).toBe(
      "brain123/sales.git",
    );
  });
  it("rejects a brainId with a slash", () => {
    expect(() => makeRepoName("a/b", makeSlug("f"))).toThrow(DomainError);
  });
});

describe("Permission", () => {
  it("ranks read < write < admin", () => {
    expect(permissionSatisfies("admin", "read")).toBe(true);
    expect(permissionSatisfies("write", "write")).toBe(true);
    expect(permissionSatisfies("read", "write")).toBe(false);
  });
  it("validates input", () => {
    expect(makePermission("write")).toBe("write");
    expect(() => makePermission("owner")).toThrow(DomainError);
  });
});
