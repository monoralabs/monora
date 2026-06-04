import type { RepoName } from "../workspace/repo-name";

/**
 * The git data plane as a port. The MVP adapter shells out to `git` over bare
 * repos under GIT_ROOT (@monora/git); a Gitea adapter can replace it later
 * behind this same interface. Use-cases never touch the filesystem or `git`.
 */
export interface GitBackend {
  /** True if the bare repo already exists. */
  repoExists(repoName: RepoName): Promise<boolean>;

  /** Create the bare repo if absent, with `defaultBranch` as HEAD. Idempotent. */
  ensureBareRepo(repoName: RepoName, defaultBranch: string): Promise<void>;

  /**
   * Every file path in the repo at `ref` (default HEAD), as a flat recursive
   * list. The Brain explorer slices this into per-directory listings; an empty
   * or unborn repo yields `[]`.
   */
  listFiles(repoName: RepoName, ref?: string): Promise<string[]>;

  /**
   * Read one file's bytes as a UTF-8 string at `ref` (default HEAD). `path` is
   * relative to the repo root and must stay inside the tree (traversal is
   * rejected by the adapter). Used by the Brain explorer to preview a file.
   */
  readFile(repoName: RepoName, path: string, ref?: string): Promise<string>;

  /**
   * Read one file's raw bytes at `ref` (default HEAD), for serving binary
   * content (images, PDFs, ...) that a UTF-8 string would corrupt. Same path
   * rules as {@link readFile}.
   */
  readFileBytes(
    repoName: RepoName,
    path: string,
    ref?: string,
  ): Promise<Uint8Array>;

  /**
   * Search the repo at `ref` (default HEAD) for `query`, returning matching
   * `path:line:text` rows (capped). Backs the MCP/agent search tool. Same path
   * resolution under GIT_ROOT as the other reads; never executes a hook or
   * shells a pattern.
   */
  grep(repoName: RepoName, query: string, ref?: string): Promise<string[]>;

  /**
   * Replace the repo's `branch` with a single commit snapshotting `sourceDir`
   * (the MVP ingest path; history-preserving filter-repo is a later option).
   * Returns the new commit sha.
   *
   * `excludeSubpaths` are paths relative to `sourceDir` (POSIX, no leading
   * slash) whose subtrees are *carved out* of this snapshot - used when a nested
   * folder owns that subtree as its own repo, so the parent must not also carry
   * its content. `excludeMedia` drops images/videos (kept out of git history
   * until the R2/LFS path lands in Phase 4.7).
   */
  importSnapshot(input: {
    repoName: RepoName;
    sourceDir: string;
    branch: string;
    message: string;
    excludeSubpaths?: string[];
    excludeMedia?: boolean;
  }): Promise<{ commit: string }>;

  /**
   * The tip commit sha of `refs/heads/<branch>`, or null if the branch is
   * unborn / missing. Used by brain versioning to record a folder's state.
   */
  headCommit(repoName: RepoName, branch: string): Promise<string | null>;

  /**
   * Point a ref at a commit (`git update-ref`). Used to (a) move a branch on
   * restore and (b) pin snapshot commits under `refs/monora/snapshots/<id>` so
   * a rolled-back commit survives gc. Lossless: superseded commits stay
   * reachable via the pin, so a restore is always reversible.
   */
  setRef(repoName: RepoName, ref: string, sha: string): Promise<void>;
}
