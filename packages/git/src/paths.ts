import path from "node:path";
import type { RepoName } from "@monora/core";

/** Resolve a repo's on-disk bare path under gitRoot, refusing any path that
 *  escapes the root. Shared by the backend and the HTTP server. */
export function resolveRepoDir(gitRoot: string, repoName: RepoName): string {
  const root = path.resolve(gitRoot);
  const resolved = path.resolve(root, repoName);
  const rootSlash = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootSlash)) {
    throw new Error(`Repo path escapes GIT_ROOT: ${repoName}`);
  }
  return resolved;
}
