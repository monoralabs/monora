import type { Folder } from "./folder";
import type { RepoName } from "./repo-name";
import type { Slug } from "./slug";
import type { Brain } from "./brain";

/**
 * Repository ports. Implementations (Drizzle adapters in @monora/db) are handed
 * to use-cases already bound to a single tenant via the UnitOfWork, so these
 * methods need no orgId argument - the binding scopes every query (RLS + the
 * tenant transaction). Interfaces only; zero infra here.
 */
export interface BrainRepository {
  add(brain: Brain): Promise<void>;
  findById(id: string): Promise<Brain | null>;
  findBySlug(slug: Slug): Promise<Brain | null>;
  listByOrg(): Promise<Brain[]>;
}

export interface FolderRepository {
  add(folder: Folder): Promise<void>;
  /** Reconcile a folder's mutable structure (name, mount path, parent) to match
   *  the given snapshot. Identity fields (id, slug, repoName) are never touched.
   *  Used by re-ingest so a corrected map heals an already-imported folder. */
  update(folder: Folder): Promise<void>;
  findById(id: string): Promise<Folder | null>;
  findBySlugInBrain(brainId: string, slug: Slug): Promise<Folder | null>;
  /** Resolve a folder by its bare-repo identity (the proxy authorizes by this). */
  findByRepoName(repoName: RepoName): Promise<Folder | null>;
  listByBrain(brainId: string): Promise<Folder[]>;
  /** Every folder in the bound org (the manifest filters these by can(read)). */
  listByOrg(): Promise<Folder[]>;
}
