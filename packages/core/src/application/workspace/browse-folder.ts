import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import type { Authz, Subject } from "../../domain/access/authz";

export interface BrowseFolderDeps {
  uow: UnitOfWork;
  git: GitBackend;
  authz: Authz;
}

export interface BrowseFolderInput {
  /** The principal browsing; orgId scopes the tenant transaction. */
  subject: Subject;
  /** The folder (= one bare repo) to look inside. */
  folderId: string;
  /** Subpath within the folder repo. "" / undefined = the folder root. */
  path?: string;
}

export interface BrowseEntry {
  name: string;
  type: "dir" | "file";
  /** Path within the folder repo (use as the next `path`). */
  path: string;
}

/** One uniform denial: a folder you may not read is indistinguishable from a
 *  missing one (same rule as the git proxy). */
const DENY = () => DomainError.forbidden("access denied");

/** "" or "a/b/" - always trailing-slashed (or empty) so prefix matching is clean. */
function normalizePrefix(path?: string): string {
  const clean = (path ?? "").replace(/^\/+|\/+$/g, "");
  if (!clean) return "";
  if (clean.split("/").some((s) => s === "." || s === "..")) throw DENY();
  return clean + "/";
}

/** Immediate children at `prefix`, derived from the flat recursive file list:
 *  dirs first (alpha), then files (alpha). git tracks no empty dirs, so a dir
 *  appears iff it has at least one descendant file. */
function childrenAt(allPaths: string[], prefix: string): BrowseEntry[] {
  const dirs = new Set<string>();
  const files: BrowseEntry[] = [];
  for (const full of allPaths) {
    if (prefix && !full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ name: rest, type: "file", path: prefix + rest });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  const byName = (a: BrowseEntry, b: BrowseEntry) => a.name.localeCompare(b.name);
  const dirEntries: BrowseEntry[] = [...dirs]
    .map((name) => ({ name, type: "dir" as const, path: prefix + name }))
    .sort(byName);
  files.sort(byName);
  return [...dirEntries, ...files];
}

/**
 * Read side of the Workspace context: list what's at `path` inside a folder.
 * The unit of access is the folder, so a single `can(read)` check gates the
 * whole listing - then we derive the immediate children from git. No new
 * GitBackend port method: we reuse `listFiles` and slice it server-side.
 */
export function browseFolder(deps: BrowseFolderDeps) {
  return (
    input: BrowseFolderInput,
  ): Promise<Result<BrowseEntry[], DomainError>> =>
    asResult(async () => {
      const prefix = normalizePrefix(input.path);

      const folder = await deps.uow.run(input.subject.orgId, (repos) =>
        repos.folders.findById(input.folderId),
      );
      // An archived folder is in the trash: for the read surface it behaves
      // exactly like a missing one (uniform denial, nothing leaked).
      if (!folder || folder.archivedAt) throw DENY();

      const allowed = await deps.authz.can(input.subject, "read", folder.id);
      if (!allowed) throw DENY();

      const all = await deps.git.listFiles(folder.repoName);
      return childrenAt(all, prefix);
    });
}
