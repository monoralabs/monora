import { asResult } from "../../shared/errors";
import type { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import type { Authz, Subject } from "../../domain/access/authz";
import type { Memberships } from "../../domain/access/memberships";
import type { Manifest, MountEntry } from "../../domain/distribution/manifest";
import { isBrainRootSlug } from "../../domain/workspace/folder";
import { scopeAllowsFolder } from "../../domain/access/access-token";

export interface GenerateManifestDeps {
  uow: UnitOfWork;
  authz: Authz;
  /** Resolve the orgs a user belongs to, for cross-org (user-scoped) manifests.
   *  Only consulted when `crossOrg` is set. */
  memberships: Memberships;
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
  /** A user-scoped token (subjectType "user") composes folders from EVERY org
   *  the user belongs to into one tree, not just `subject.orgId`. Off by
   *  default, so agent/CI tokens stay bound to their single org. */
  crossOrg?: boolean;
}

/**
 * Build the subject's manifest: every folder they can read, mounted at its
 * path, with a clone URL. Authorization is baked in - a folder the subject
 * cannot read never appears.
 *
 * Single org by default. With `crossOrg` (a user-scoped token) it composes
 * EVERY org the user belongs to into one tree: each brain is its own top-level
 * subtree (`<brainSlug>/<path>`), so brains from different orgs sit side by
 * side. If two orgs expose a brain with the same slug, the later one is
 * qualified with a short org id (`<slug>-<org8>`) so nothing clobbers nothing -
 * the union is lossless. Mount paths may nest (a child folder mounts inside its
 * parent's tree); the connector creates intermediate dirs and checks out each
 * repo at its mount path.
 */
export function generateManifest(deps: GenerateManifestDeps) {
  return (
    input: GenerateManifestInput,
  ): Promise<Result<Manifest, DomainError>> =>
    asResult(async () => {
      const base = input.baseUrl.replace(/\/+$/, "");
      const orgs = input.crossOrg
        ? await orgsFor(deps, input.subject)
        : [input.subject.orgId];

      const entries: MountEntry[] = [];
      // A brain mounts at one top-level slug across the whole tree; track which
      // slugs are taken so a same-named brain in another org gets qualified
      // rather than colliding. Keyed by brainId so every folder of a brain
      // mounts under the one resolved slug.
      const takenSlugs = new Set<string>();
      const slugByBrain = new Map<string, string>();

      for (const orgId of orgs) {
        const subject: Subject = { userId: input.subject.userId, orgId };
        const { folders, brainSlugById } = await deps.uow.run(
          orgId,
          async (repos) => {
            const brains = await repos.brains.listByOrg();
            return {
              folders: await repos.folders.listByOrg(),
              brainSlugById: new Map(brains.map((b) => [b.id, b.slug])),
            };
          },
        );

        for (const f of folders) {
          // Archived (soft-deleted) folders are in the trash: they never appear
          // in the manifest, so a `sync` prunes them from every machine. The
          // bare repo stays on disk, so a restore brings them back here intact.
          if (f.archivedAt) continue;
          const level = await deps.authz.levelFor(subject, f.id);
          if (!level) continue;
          // A scoped token only sees folders in its scope, even via the read
          // APIs. levelFor (the ACL) is necessary but not sufficient: scope is
          // the intersection, never a widening. Enforced HERE so /manifest and
          // /search honor it too, not only the git path (authorizeGitRequest).
          if (!scopeAllowsFolder(input.scopes ?? null, f.id)) continue;

          // Resolve (once per brain) a collision-free top-level slug. The repo
          // name is keyed by brain id (org-independent), so the human-readable
          // mount slug comes from the brain row, not the repo name.
          let topSlug = slugByBrain.get(f.brainId);
          if (!topSlug) {
            const desired = brainSlugById.get(f.brainId) ?? f.brainId;
            topSlug = takenSlugs.has(desired)
              ? `${desired}-${orgId.slice(0, 8)}`
              : desired;
            takenSlugs.add(topSlug);
            slugByBrain.set(f.brainId, topSlug);
          }
          // The brain's root folder mounts at the brain root itself; every
          // other folder nests under it at `<brainSlug>/<path>`.
          const mountPath = isBrainRootSlug(f.slug)
            ? topSlug
            : `${topSlug}/${f.path}`;
          entries.push({
            folderId: f.id,
            repoName: f.repoName,
            mountPath,
            cloneUrl: `${base}/${f.repoName}`,
            permission: level,
            orgId,
          });
        }
      }

      return {
        orgId: input.subject.orgId,
        subjectId: input.subject.userId,
        entries,
      };
    });
}

/** The orgs a user-scoped manifest spans: every org the user is a member of.
 *  Membership is the single source of truth - the same gate the git path
 *  (authorizeGitRequest) applies - so the manifest never lists a folder the
 *  clone would then refuse. The home org sorts first (when the user is still a
 *  member) so it wins the bare brain slug on a cross-org name collision. */
async function orgsFor(
  deps: GenerateManifestDeps,
  subject: Subject,
): Promise<string[]> {
  const member = [...new Set(await deps.memberships.listOrgsForUser(subject.userId))];
  return member.includes(subject.orgId)
    ? [subject.orgId, ...member.filter((o) => o !== subject.orgId)]
    : member;
}
