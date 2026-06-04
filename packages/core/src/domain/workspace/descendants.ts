import type { Folder } from "./folder";

/**
 * The IDs of `rootId` plus every folder nested under it (transitively), within
 * the given folder set. Used to expand a "grant/revoke this folder and all that
 * hangs below it now" action into individual folder_access rows - a one-time
 * bulk-apply over the CURRENT tree, not live inheritance. Folders created later
 * under the root are not affected: private by default stays the default.
 *
 * `rootId` is always included (even if absent from `folders`) so a caller can
 * act on the root regardless of whether the list carries it. Cycles (which the
 * schema's parent FK should prevent) are guarded against via a visited set.
 */
export function collectSubtree(folders: Folder[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parentFolderId === null) continue;
    const bucket = childrenByParent.get(f.parentFolderId);
    if (bucket) bucket.push(f.id);
    else childrenByParent.set(f.parentFolderId, [f.id]);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const children = childrenByParent.get(id);
    if (children) stack.push(...children);
  }
  return out;
}
