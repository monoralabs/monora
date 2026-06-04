import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Folder-lifecycle plumbing for the connector: the HTTP calls to the proxy's
 * lifecycle routes (create / archive / restore / list-archived) and the local
 * staging file that records folders the user has asked to CREATE.
 *
 * Why a staging file for creates: in Monora a brand-new directory is, by
 * default, just content of its parent folder's repo (it commits on the next
 * `save`). Promoting a directory to its OWN repo is a deliberate act, so it
 * must be staged explicitly (`monora add`) - we never guess that a loose
 * directory should become a repo. Deletions need no staging: a folder that was
 * in the index and is now gone from disk is an unambiguous "remove this".
 */

export interface PendingCreate {
  /** Brain the new folder belongs to (resolved from the workspace index). */
  brainId: string;
  slug: string;
  name: string;
  /** Mount path within the brain (the part after `<brainSlug>/`). */
  path: string;
  /** Parent folder id when nesting under an existing folder, else null. */
  parentFolderId: string | null;
  /** Where the folder sits in the workspace tree (`<brainSlug>/<path>`), so
   *  `save` can find the local content to push after the repo is created. */
  mountPath: string;
  /** Mount path of the repo whose working tree currently holds this directory
   *  (the brain root for a top-level folder, or the enclosing folder when
   *  nested). `save` carves this subpath out of that parent repo. */
  parentMount: string;
}

interface PendingFile {
  creates: PendingCreate[];
}

function pendingPath(workspace: string): string {
  return path.join(workspace, ".monora", "pending.json");
}

export async function readPending(workspace: string): Promise<PendingFile> {
  try {
    const raw = await readFile(pendingPath(workspace), "utf8");
    const p = JSON.parse(raw) as PendingFile;
    return { creates: Array.isArray(p.creates) ? p.creates : [] };
  } catch {
    return { creates: [] };
  }
}

export async function writePending(
  workspace: string,
  pending: PendingFile,
): Promise<void> {
  await mkdir(path.join(workspace, ".monora"), { recursive: true });
  await writeFile(
    pendingPath(workspace),
    JSON.stringify(pending, null, 2) + "\n",
  );
}

/** Stage a create, replacing any existing entry for the same mount path. */
export async function stageCreate(
  workspace: string,
  create: PendingCreate,
): Promise<void> {
  const pending = await readPending(workspace);
  pending.creates = pending.creates.filter(
    (c) => c.mountPath !== create.mountPath,
  );
  pending.creates.push(create);
  await writePending(workspace, pending);
}

export interface ServerEntry {
  folderId: string;
  repoName: string;
  mountPath: string;
}

/** The server's view of which folders this principal has (the source of truth,
 *  carrying folder ids). `save` diffs this against disk to find deletions - more
 *  robust than the local cache, which may predate the folder-id field. */
export async function fetchServerManifest(
  baseUrl: string,
  token: string,
): Promise<ServerEntry[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/manifest`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const m = (await res.json()) as { entries?: ServerEntry[] };
  return m.entries ?? [];
}

async function detail(res: Response): Promise<string> {
  return res
    .json()
    .then((b) => (b as { error?: string }).error ?? `HTTP ${res.status}`)
    .catch(() => `HTTP ${res.status}`);
}

export interface CreatedFolder {
  folderId: string;
  repoName: string;
  cloneUrl: string;
}

export async function createFolderRemote(
  baseUrl: string,
  token: string,
  brainId: string,
  body: { slug: string; name: string; path?: string; parentFolderId?: string | null },
): Promise<CreatedFolder> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/brains/${brainId}/folders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create folder failed: ${await detail(res)}`);
  return (await res.json()) as CreatedFolder;
}

export async function archiveFolderRemote(
  baseUrl: string,
  token: string,
  folderId: string,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/folders/${folderId}/archive`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`archive failed: ${await detail(res)}`);
}

export async function restoreFolderRemote(
  baseUrl: string,
  token: string,
  folderId: string,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/folders/${folderId}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`restore failed: ${await detail(res)}`);
}

export interface ArchivedFolder {
  folderId: string;
  repoName: string;
  path: string;
  name: string;
  archivedAt: string | null;
}

export async function listArchivedRemote(
  baseUrl: string,
  token: string,
): Promise<ArchivedFolder[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/folders/archived`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list archived failed: ${await detail(res)}`);
  const body = (await res.json()) as { folders: ArchivedFolder[] };
  return body.folders ?? [];
}
