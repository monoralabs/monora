import { readdir } from "node:fs/promises";

export interface DerivedFolder {
  slug: string;
  name: string;
  /** Mount path within the brain (relative to the brain root). */
  path: string;
  /** Source subdirectory relative to the `--from` root. Empty string for a
   *  synthetic folder that bundles loose root files (see `files`). */
  source: string;
  /** When set, copy only these specific files (relative to the `--from` root)
   *  instead of a whole subdirectory. Used for the root-files folder. */
  files?: string[];
}

export interface DerivedLayout {
  folders: DerivedFolder[];
  /** Loose files at the root. When `rootFolder` is requested they are bundled
   *  into a folder (and `rootFilesIngested` is true); otherwise they are
   *  reported here but not ingested (a brain folder is a directory = a repo). */
  rootFiles: string[];
  /** True when the loose root files were folded into a folder. */
  rootFilesIngested: boolean;
}

export interface DeriveOptions {
  /** If set and there are loose root files, bundle them into one folder with
   *  this slug (e.g. "overview") so they are ingested as first-class content. */
  rootFolder?: string;
}

/** `acme-corp` / `acme_corp` -> `Acme Corp`. */
function title(s: string): string {
  return s.replace(/[-_/]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Turn a local directory into a flat list of folders - one per top-level
 * subdirectory - plus the loose root-level files. Hidden entries (dotfiles,
 * `.git`) are skipped. This is the client-side half of "create a brain from a
 * folder": the connector derives the shape, the server creates the empty repos,
 * and the connector pushes each folder's content into its repo. Flat by design
 * (no nesting) - each top-level dir becomes its own folder/repo/ACL.
 */
export async function deriveFolders(
  root: string,
  opts: DeriveOptions = {},
): Promise<DerivedLayout> {
  const ents = await readdir(root, { withFileTypes: true });
  const folders: DerivedFolder[] = [];
  const rootFiles: string[] = [];
  for (const e of [...ents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      const slug = slugify(e.name);
      if (!slug) continue;
      folders.push({ slug, name: title(e.name), path: slug, source: e.name });
    } else if (e.isFile()) {
      rootFiles.push(e.name);
    }
  }
  const slugs = new Set<string>();
  for (const f of folders) {
    if (slugs.has(f.slug)) {
      throw new Error(
        `two top-level folders derive the same slug "${f.slug}" - rename one`,
      );
    }
    slugs.add(f.slug);
  }

  // Optionally fold the loose root files into a folder of their own so they
  // are ingested instead of dropped (a brain folder = a directory = a repo,
  // so root-level files otherwise have no repo to live in).
  let rootFilesIngested = false;
  if (opts.rootFolder && rootFiles.length) {
    const slug = slugify(opts.rootFolder);
    if (!slug) {
      throw new Error(`--include-root "${opts.rootFolder}" is not a valid slug`);
    }
    if (slugs.has(slug)) {
      throw new Error(
        `--include-root "${slug}" collides with an existing top-level folder - pick another name`,
      );
    }
    folders.push({
      slug,
      name: title(opts.rootFolder),
      path: slug,
      source: "",
      files: [...rootFiles],
    });
    slugs.add(slug);
    rootFilesIngested = true;
  }

  return { folders, rootFiles, rootFilesIngested };
}
