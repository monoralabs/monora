import { listArchivedRemote, restoreFolderRemote, type ArchivedFolder } from "./lifecycle";

export interface RestoreOptions {
  baseUrl: string;
  token: string;
  /** A folder to bring back: matched against its repo name, path, or name. Omit
   *  to just list the trash. */
  target?: string;
}

export interface RestoreResult {
  /** The full trash listing (always returned, for `monora restore` with no arg). */
  archived: ArchivedFolder[];
  /** The folder restored, if a target matched exactly one. */
  restored?: ArchivedFolder;
  /** Set when the target matched more than one trashed folder. */
  ambiguous?: ArchivedFolder[];
}

/** Bring an archived folder back from the trash (or list what is in there). The
 *  bare repo was never deleted, so a following `monora sync` re-clones it with
 *  full git history. */
export async function restore(opts: RestoreOptions): Promise<RestoreResult> {
  const archived = await listArchivedRemote(opts.baseUrl, opts.token);
  if (!opts.target) return { archived };

  const t = opts.target.replace(/\/+$/, "").replace(/\.git$/, "");
  const matches = archived.filter(
    (f) =>
      f.repoName === opts.target ||
      f.repoName.replace(/\.git$/, "") === t ||
      f.path === t ||
      f.path.endsWith(`/${t}`) ||
      f.name === opts.target,
  );
  if (matches.length === 0) return { archived };
  if (matches.length > 1) return { archived, ambiguous: matches };

  const target = matches[0]!;
  await restoreFolderRemote(opts.baseUrl, opts.token, target.folderId);
  return { archived, restored: target };
}
