import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitBackend, RepoName } from "@monora/core";
import { resolveRepoDir } from "./paths";

const exec = promisify(execFile);

/** Hermetic env for every git invocation. We serve untrusted, agent-writable
 *  trees, so git must not inherit operator config: GIT_CONFIG_GLOBAL/SYSTEM=
 *  /dev/null drop ~/.gitconfig and /etc/gitconfig (a host alias, or a filter
 *  driver referenced by an ingested .gitattributes, can no longer execute), and
 *  GIT_TERMINAL_PROMPT=0 never blocks on a credential prompt. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** Images + videos we keep out of git history for now (Phase 4.7 moves binary
 *  assets to content-addressed R2). Documents (pdf/docx/svg/...) are kept. */
const MEDIA_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp",
  ".tiff", ".tif", ".ico", ".avif",
  ".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".wmv", ".flv",
  ".mpeg", ".mpg",
]);

function isMediaPath(p: string): boolean {
  return MEDIA_EXT.has(path.extname(p).toLowerCase());
}

const IGNORED_DIRS = new Set(["node_modules", ".venv", "__pycache__"]);
const KEEP_ENV_SUFFIX = [".example", ".sample", ".template", ".dist"];

/** Never snapshot these, regardless of options: VCS/OS cruft, dependency and
 *  cache dirs, and - critically - secret env files. `.env.example` and friends
 *  are kept (they document config, carry no secrets). Mirrors org/'s .gitignore
 *  so ingest captures what git would, never raw secrets or node_modules. */
function isAlwaysIgnored(p: string): boolean {
  const base = path.basename(p);
  if (base === ".git" || base === ".DS_Store") return true;
  if (IGNORED_DIRS.has(base)) return true;
  if (base.endsWith(".pyc")) return true;
  if (base === ".env") return true;
  if (base.startsWith(".env.") && !KEEP_ENV_SUFFIX.some((s) => base.endsWith(s))) {
    return true;
  }
  return false;
}

export interface GitShellOptions {
  /** Absolute root under which bare repos live: <gitRoot>/<org>/<space>/<folder>.git */
  gitRoot: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * GitBackend over bare repos on the local filesystem, shelling out to the `git`
 * binary. The MVP data-plane adapter. A Gitea adapter can replace this behind
 * the same port later. All repo paths are resolved under gitRoot and checked
 * for traversal before any git invocation.
 */
export class GitShellBackend implements GitBackend {
  private readonly gitRoot: string;
  private readonly authorName: string;
  private readonly authorEmail: string;

  constructor(opts: GitShellOptions) {
    this.gitRoot = path.resolve(opts.gitRoot);
    this.authorName = opts.authorName ?? "Monora Ingest";
    this.authorEmail = opts.authorEmail ?? "ingest@monora.local";
  }

  private repoPath(repoName: RepoName): string {
    return resolveRepoDir(this.gitRoot, repoName);
  }

  async repoExists(repoName: RepoName): Promise<boolean> {
    const head = path.join(this.repoPath(repoName), "HEAD");
    try {
      await access(head);
      return true;
    } catch {
      return false;
    }
  }

  async ensureBareRepo(repoName: RepoName, defaultBranch: string): Promise<void> {
    if (await this.repoExists(repoName)) return;
    const dir = this.repoPath(repoName);
    await exec(
      "git",
      ["init", "--bare", `--initial-branch=${defaultBranch}`, dir],
      { env: GIT_ENV },
    );
  }

  /** List every file path in the repo at `ref` (default HEAD). */
  async listFiles(repoName: RepoName, ref = "HEAD"): Promise<string[]> {
    const dir = this.repoPath(repoName);
    try {
      const { stdout } = await exec(
        "git",
        ["-C", dir, "ls-tree", "-r", "--name-only", ref],
        { maxBuffer: 16 * 1024 * 1024, env: GIT_ENV },
      );
      return stdout.split("\n").filter(Boolean);
    } catch {
      return []; // empty/unborn repo
    }
  }

  /** Read a file's content at `ref`. Path must stay inside the tree. */
  async readFile(
    repoName: RepoName,
    path: string,
    ref = "HEAD",
  ): Promise<string> {
    const clean = path.replace(/^\/+/, "");
    if (clean.split("/").some((s) => s === "." || s === ".." || s === "")) {
      throw new Error(`Invalid path: ${path}`);
    }
    const dir = this.repoPath(repoName);
    const { stdout } = await exec(
      "git",
      ["-C", dir, "cat-file", "-p", `${ref}:${clean}`],
      { maxBuffer: 16 * 1024 * 1024, env: GIT_ENV },
    );
    return stdout;
  }

  /** Read a file's raw bytes at `ref` (binary-safe). Path must stay in tree. */
  async readFileBytes(
    repoName: RepoName,
    path: string,
    ref = "HEAD",
  ): Promise<Uint8Array> {
    const clean = path.replace(/^\/+/, "");
    if (clean.split("/").some((s) => s === "." || s === ".." || s === "")) {
      throw new Error(`Invalid path: ${path}`);
    }
    const dir = this.repoPath(repoName);
    const { stdout } = await exec(
      "git",
      ["-C", dir, "cat-file", "-p", `${ref}:${clean}`],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: GIT_ENV },
    );
    return new Uint8Array(stdout as Buffer);
  }

  /** grep across the repo at `ref`. Returns matching `path:line:text` rows. */
  async grep(
    repoName: RepoName,
    query: string,
    ref = "HEAD",
  ): Promise<string[]> {
    const dir = this.repoPath(repoName);
    try {
      const { stdout } = await exec(
        "git",
        ["-C", dir, "grep", "-n", "-I", "--fixed-strings", "-e", query, ref],
        { maxBuffer: 16 * 1024 * 1024, env: GIT_ENV },
      );
      return stdout.split("\n").filter(Boolean).slice(0, 200);
    } catch {
      return []; // grep exits non-zero when there are no matches
    }
  }

  /** Tip sha of refs/heads/<branch>, or null if the branch is unborn/missing. */
  async headCommit(repoName: RepoName, branch: string): Promise<string | null> {
    const dir = this.repoPath(repoName);
    try {
      const { stdout } = await exec(
        "git",
        ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { env: GIT_ENV },
      );
      return stdout.trim() || null;
    } catch {
      return null; // unborn / missing branch
    }
  }

  /** Point a ref at a commit (move a branch on restore, or pin a snapshot). */
  async setRef(repoName: RepoName, ref: string, sha: string): Promise<void> {
    const dir = this.repoPath(repoName);
    await exec("git", ["-C", dir, "update-ref", ref, sha], { env: GIT_ENV });
  }

  async importSnapshot(input: {
    repoName: RepoName;
    sourceDir: string;
    branch: string;
    message: string;
    excludeSubpaths?: string[];
    excludeMedia?: boolean;
  }): Promise<{ commit: string }> {
    const bare = this.repoPath(input.repoName);
    const work = await mkdtemp(path.join(tmpdir(), "monora-ingest-"));
    const srcRoot = path.resolve(input.sourceDir);
    // Normalise carved subpaths to clean POSIX relatives for prefix matching.
    const carved = (input.excludeSubpaths ?? [])
      .map((p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean);
    const isCarved = (rel: string): boolean =>
      carved.some((c) => rel === c || rel.startsWith(`${c}/`));
    try {
      const git = (args: string[]) =>
        exec("git", args, { cwd: work, env: GIT_ENV });

      await git(["init", `--initial-branch=${input.branch}`, "."]);
      // Copy the source tree, skipping: nested .git, carved-out child subtrees
      // (they live in their own repo), and - when asked - media blobs.
      await cp(input.sourceDir, work, {
        recursive: true,
        filter: (src) => {
          if (isAlwaysIgnored(src)) return false;
          const rel = path.relative(srcRoot, path.resolve(src)).replace(/\\/g, "/");
          if (rel === "") return true; // the root itself
          if (isCarved(rel)) return false;
          if (input.excludeMedia && isMediaPath(src)) return false;
          return true;
        },
      });
      await git(["add", "-A"]);
      await git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        input.message,
      ]);
      // Force so re-ingest replaces the branch with the fresh snapshot.
      await git([
        "push",
        "--force",
        bare,
        `HEAD:refs/heads/${input.branch}`,
      ]);
      const { stdout } = await git(["rev-parse", "HEAD"]);
      return { commit: stdout.trim() };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
