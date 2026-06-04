import { DomainError } from "../../shared/errors";

/** Where a folder is mounted in the composed workspace tree. A clean relative
 *  path: no leading/trailing slash, no `.`/`..`, safe segment chars. Branded. */
export type MountPath = string & { readonly __brand: "MountPath" };

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function makeMountPath(input: string): MountPath {
  const v = input.trim().replace(/^\/+|\/+$/g, "");
  if (v === "") {
    throw DomainError.validation("Mount path cannot be empty");
  }
  for (const seg of v.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw DomainError.validation(
        `Invalid mount path ${JSON.stringify(input)}: bad segment`,
      );
    }
    if (!SEGMENT_RE.test(seg)) {
      throw DomainError.validation(
        `Invalid mount path ${JSON.stringify(input)}: illegal characters`,
      );
    }
  }
  return v as MountPath;
}

/** True if one path is the other, or one is an ancestor of the other - i.e.
 *  they cannot both exist as distinct mounts (one would nest inside the other).
 *  Nested mounts are a Phase 6 feature; for now mounts must be disjoint. */
export function mountPathsOverlap(a: MountPath, b: MountPath): boolean {
  if (a === b) return true;
  const sa = a.split("/");
  const sb = b.split("/");
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true; // shared prefix for the whole of the shorter path => nested
}

/** Throw on the first overlapping pair. O(n^2) is fine for a folder set. */
export function assertDisjoint(paths: MountPath[]): void {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i]!;
      const b = paths[j]!;
      if (mountPathsOverlap(a, b)) {
        throw DomainError.conflict(
          `Overlapping mount paths: ${a} and ${b} (nested folders are not yet supported)`,
        );
      }
    }
  }
}
