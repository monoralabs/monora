import { DomainError } from "../../shared/errors";
import type { Slug } from "./slug";

/** The bare repo's identity on the git host, namespaced by the brain's id (a
 *  UUID, globally unique and stable for the life of the brain - NOT the org):
 *  `<brainId>/<folderSlug>.git`. One folder = one bare repo. Because the brain
 *  id is org-independent, moving a brain between orgs (or, later, sharing it
 *  with several orgs) never rewrites a repo name or moves a repo on disk - the
 *  org is just a pointer column you UPDATE. */
export type RepoName = string & { readonly __brand: "RepoName" };

export function makeRepoName(brainId: string, folderSlug: Slug): RepoName {
  const id = brainId.trim();
  if (id === "" || id.includes("/") || id.includes("..")) {
    throw DomainError.validation(
      `Invalid brain id for repo name: ${JSON.stringify(brainId)}`,
    );
  }
  return `${id}/${folderSlug}.git` as RepoName;
}

/** Pull the brain id back out of a repo name (`<brainId>/<folderSlug>.git`). */
export function brainIdFromRepoName(repoName: RepoName): string {
  const parts = repoName.split("/");
  if (parts.length !== 2 || parts[0] === "") {
    throw DomainError.validation(
      `Malformed repo name: ${JSON.stringify(repoName)}`,
    );
  }
  return parts[0]!;
}
