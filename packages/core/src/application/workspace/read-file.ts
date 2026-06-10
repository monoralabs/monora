import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { GitBackend } from "../../domain/git/git-backend";
import type { BlobStore } from "../../domain/git/blob-store";
import { parseBlobPointer } from "../../domain/git/blob-store";
import type { Authz, Subject } from "../../domain/access/authz";

export interface ReadBrainFileDeps {
  uow: UnitOfWork;
  git: GitBackend;
  authz: Authz;
  /** Optional content-addressed store. When present, a file whose git content
   *  is a blob pointer is resolved to its real bytes from here (Phase 4.7.1). */
  blobStore?: BlobStore;
}

export interface ReadBrainFileInput {
  subject: Subject;
  folderId: string;
  /** Path within the folder repo, e.g. "brand/brand.md". */
  path: string;
}

export interface BrainFile {
  path: string;
  content: string;
  /** True when content was cut to MAX_BYTES (avoid shipping huge blobs). */
  truncated: boolean;
}

/** Same uniform denial as the rest of the read side. */
const DENY = () => DomainError.forbidden("access denied");

/** ~1 MB of text is plenty for an in-app preview; beyond that we truncate. */
const MAX_BYTES = 1_000_000;

/**
 * Read one file's content for the Brain explorer's viewer. The folder is the
 * unit of access, so a single `can(read)` check gates the read; then we hand
 * the in-repo path to git. Binary files come back as a (lossy) string - the
 * client decides what is renderable by extension.
 */
export function readBrainFile(deps: ReadBrainFileDeps) {
  return (
    input: ReadBrainFileInput,
  ): Promise<Result<BrainFile, DomainError>> =>
    asResult(async () => {
      const rel = input.path.replace(/^\/+/, "");
      if (!rel || rel.split("/").some((s) => s === "." || s === "..")) {
        throw DomainError.validation(`Invalid path: ${input.path}`);
      }

      const folder = await deps.uow.run(input.subject.orgId, (repos) =>
        repos.folders.findById(input.folderId),
      );
      // An archived folder is in the trash: for the read surface it behaves
      // exactly like a missing one (uniform denial, nothing leaked).
      if (!folder || folder.archivedAt) throw DENY();

      const allowed = await deps.authz.can(input.subject, "read", folder.id);
      if (!allowed) throw DENY();

      const raw = await deps.git.readFile(folder.repoName, rel);
      const truncated = raw.length > MAX_BYTES;
      return {
        path: rel,
        content: truncated ? raw.slice(0, MAX_BYTES) : raw,
        truncated,
      };
    });
}

export interface BrainFileBytes {
  path: string;
  bytes: Uint8Array;
}

/** Binaries above this are not served inline - the explorer shows an "open in
 *  your workspace" card instead. Keeps a huge upload from being buffered in the
 *  request. (The git adapter's maxBuffer is the hard ceiling above this.) */
const MAX_INLINE_BYTES = 25 * 1024 * 1024;

/**
 * Read one file's raw bytes for serving to the explorer (images, etc.). Same
 * `can(read)` gate and path rules as {@link readBrainFile}, but binary-safe.
 * Over-cap files are refused (the client falls back), not truncated - a partial
 * binary is useless.
 */
export function readBrainFileBytes(deps: ReadBrainFileDeps) {
  return (
    input: ReadBrainFileInput,
  ): Promise<Result<BrainFileBytes, DomainError>> =>
    asResult(async () => {
      const rel = input.path.replace(/^\/+/, "");
      if (!rel || rel.split("/").some((s) => s === "." || s === "..")) {
        throw DomainError.validation(`Invalid path: ${input.path}`);
      }

      const folder = await deps.uow.run(input.subject.orgId, (repos) =>
        repos.folders.findById(input.folderId),
      );
      // An archived folder is in the trash: for the read surface it behaves
      // exactly like a missing one (uniform denial, nothing leaked).
      if (!folder || folder.archivedAt) throw DENY();

      const allowed = await deps.authz.can(input.subject, "read", folder.id);
      if (!allowed) throw DENY();

      const gitBytes = await deps.git.readFileBytes(folder.repoName, rel);

      // A routed binary is stored in git as a tiny pointer; resolve it to the
      // real bytes from the content-addressed store. The size cap applies to
      // the resolved bytes (the pointer itself is tiny). Without a blob store
      // configured a pointer is unservable, so deny rather than hand back JSON.
      const pointer = parseBlobPointer(gitBytes);
      if (pointer) {
        if (!deps.blobStore) {
          throw DomainError.validation("Blob store not configured");
        }
        if (pointer.monora_blob.size > MAX_INLINE_BYTES) {
          throw DomainError.validation("File too large for inline preview");
        }
        const bytes = await deps.blobStore.get(pointer.monora_blob.sha256);
        return { path: rel, bytes };
      }

      if (gitBytes.length > MAX_INLINE_BYTES) {
        throw DomainError.validation("File too large for inline preview");
      }
      return { path: rel, bytes: gitBytes };
    });
}
