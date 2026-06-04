import { asResult } from "../../shared/errors";
import type { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { Authz, Subject } from "../../domain/access/authz";
import type { Permission } from "../../domain/access/permission";
import type { Manifest, MountEntry } from "../../domain/distribution/manifest";
import { isBrainRootSlug } from "../../domain/workspace/folder";
import { scopeAllowsFolder } from "../../domain/access/access-token";

export interface GenerateManifestDeps {
  uow: UnitOfWork;
  authz: Authz;
}

export interface GenerateManifestInput {
  subject: Subject;
  /** Proxy base URL for clone URLs, e.g. https://git.monora.ai */
  baseUrl: string;
  /** The presenting token's folder scopes (null/undefined = unrestricted). A
   *  scoped agent token (Phase 5) only sees folders in its scope, even through
   *  the read APIs (manifest, search) - the subject's ACL is necessary but not
   *  sufficient. */
  scopes?: string[] | null;
}

/** Highest permission the subject holds, or null if none. */
async function levelFor(
  authz: Authz,
  subject: Subject,
  folderId: string,
): Promise<Permission | null> {
  if (await authz.can(subject, "admin", folderId)) return "admin";
  if (await authz.can(subject, "write", folderId)) return "write";
  if (await authz.can(subject, "read", folderId)) return "read";
  return null;
}

/**
 * Build the subject's manifest: every folder in the org they can read, mounted
 * at its path, with a clone URL. Authorization is baked in - a folder the
 * subject cannot read never appears. Mount paths may nest (a child folder
 * mounts inside its parent's path); the connector creates intermediate dirs and
 * checks out each repo at its mount path.
 */
export function generateManifest(deps: GenerateManifestDeps) {
  return (
    input: GenerateManifestInput,
  ): Promise<Result<Manifest, DomainError>> =>
    asResult(async () => {
      const base = input.baseUrl.replace(/\/+$/, "");
      const { folders, brainSlugById } = await deps.uow.run(
        input.subject.orgId,
        async (repos) => {
          const brains = await repos.brains.listByOrg();
          return {
            folders: await repos.folders.listByOrg(),
            brainSlugById: new Map(brains.map((b) => [b.id, b.slug])),
          };
        },
      );

      const entries: MountEntry[] = [];
      for (const f of folders) {
        const level = await levelFor(deps.authz, input.subject, f.id);
        if (!level) continue;
        // A scoped token only sees folders in its scope, even via the read APIs.
        // levelFor (the ACL) is necessary but not sufficient: scope is the
        // intersection, never a widening. Enforced HERE so /manifest and /search
        // honor it too, not only the git clone/push path (authorizeGitRequest).
        if (!scopeAllowsFolder(input.scopes ?? null, f.id)) continue;
        // Namespace each brain into its own top-level mount: a principal with
        // folders across multiple brains gets `<brainSlug>/<path>` per folder,
        // so the brains stay separate trees instead of flattening together
        // (and two brains sharing a folder path no longer collide). The repo
        // name is keyed by brain id (org-independent), so the human-readable
        // mount slug comes from the brain row, not the repo name.
        const brainSlug = brainSlugById.get(f.brainId) ?? f.brainId;
        // The brain's root folder mounts at the brain root itself; every other
        // folder nests under it at `<brainSlug>/<path>`.
        const mountPath = isBrainRootSlug(f.slug)
          ? brainSlug
          : `${brainSlug}/${f.path}`;
        entries.push({
          folderId: f.id,
          repoName: f.repoName,
          mountPath,
          cloneUrl: `${base}/${f.repoName}`,
          permission: level,
        });
      }

      return {
        orgId: input.subject.orgId,
        subjectId: input.subject.userId,
        entries,
      };
    });
}
