import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { stageCreate, type PendingCreate } from "./lifecycle";

export interface AddOptions {
  workspace: string;
  /** The directory to promote into its own folder/repo (abs or relative). */
  dir: string;
  /** Display name; defaults to the directory's basename. */
  name?: string;
}

interface WorkspaceMeta {
  orgId: string;
  entries: { mountPath: string; repoName: string; folderId: string }[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** kebab-case slug, matching the server's makeSlug shape (lowercase, dashes). */
function toSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Stage a new folder for creation on the next `monora save`. Resolves which
 * brain (and parent folder, if nested) the directory belongs to from the
 * workspace index, so `save` can create the repo and carve the subpath out of
 * its parent. We never auto-detect this: a loose directory is content of its
 * parent repo until you explicitly promote it here.
 */
export async function add(opts: AddOptions): Promise<PendingCreate> {
  const metaRaw = await readFile(
    path.join(opts.workspace, ".monora", "manifest.json"),
    "utf8",
  ).catch(() => null);
  if (!metaRaw) throw new Error("no Monora workspace here (run `monora sync` first)");
  const meta = JSON.parse(metaRaw) as WorkspaceMeta;

  const abs = path.resolve(opts.dir);
  const rel = path.relative(opts.workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${opts.dir} is not inside the workspace`);
  }
  if (!(await exists(abs))) throw new Error(`${opts.dir} does not exist`);

  const segments = rel.split(path.sep);
  if (segments.length < 2) {
    throw new Error(
      `cannot add a brain itself - point at a folder inside a brain (use \`monora new-brain\` to create a brain)`,
    );
  }
  const brainSlug = segments[0]!;

  // Resolve the brain from any of its indexed folders (repoName is <brainId>/...).
  const brainEntry = meta.entries.find(
    (e) => e.mountPath === brainSlug || e.mountPath.startsWith(`${brainSlug}/`),
  );
  if (!brainEntry) {
    throw new Error(`could not find brain "${brainSlug}" in this workspace`);
  }
  const brainId = brainEntry.repoName.split("/")[0]!;

  // Already a tracked folder? Then it is not a new one. Case-insensitive:
  // macOS's default filesystem would mount "Notes" and "notes" onto the same
  // directory, so they cannot coexist as folders.
  const mountPath = segments.join("/");
  if (meta.entries.some((e) => e.mountPath.toLowerCase() === mountPath.toLowerCase())) {
    throw new Error(`${mountPath} is already a Monora folder`);
  }

  // The parent is the enclosing folder if one is indexed, else the brain root.
  const parentMountPath = segments.slice(0, -1).join("/");
  const parentEntry = meta.entries.find((e) => e.mountPath === parentMountPath);
  const rootEntry = meta.entries.find((e) => e.mountPath === brainSlug);

  const pathInBrain = segments.slice(1).join("/");
  const create: PendingCreate = {
    brainId,
    slug: toSlug(segments[segments.length - 1]!),
    name: opts.name?.trim() || segments[segments.length - 1]!,
    path: pathInBrain,
    parentFolderId: parentEntry ? parentEntry.folderId : null,
    mountPath,
    // The repo whose tree holds this dir: the enclosing folder, or the brain
    // root (mounted at <brainSlug>). Fall back to the brain slug.
    parentMount: parentEntry?.mountPath ?? rootEntry?.mountPath ?? brainSlug,
  };
  await stageCreate(opts.workspace, create);
  return create;
}
