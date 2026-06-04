import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { deriveFolders, type DerivedFolder } from "./derive";
import { gitAuthArgs, setupPushCredentials } from "./sync";

const exec = promisify(execFile);

export interface NewBrainOptions {
  /** Proxy base URL, e.g. https://git.monora.ai */
  baseUrl: string;
  token: string;
  /** Brain display name. */
  name: string;
  /** Local directory whose top-level subdirs become folders. */
  from: string;
  /** Workspace root to compose the new brain into (mounted at <brainSlug>/...). */
  workspace: string;
  /** If set, bundle the loose root files into a folder with this slug instead
   *  of dropping them (e.g. "overview"). */
  includeRoot?: string;
  /** Identity for the initial seed commit (the source files are committed as
   *  one commit). */
  authorName?: string;
  authorEmail?: string;
  log?: (line: string) => void;
}

interface CreatedEntry {
  folderId: string;
  repoName: string;
  cloneUrl: string;
  mountPath: string;
  permission: string;
}
interface CreateBrainResponse {
  brainSlug: string;
  entries: CreatedEntry[];
}

export interface NewBrainResult {
  brainSlug: string;
  pushed: { mountPath: string; commit: string }[];
  skippedRootFiles: string[];
}

/**
 * Create a brain from a local folder, dogfood-style: the server creates the
 * brain + one empty repo per top-level subdir (granting this user admin), and
 * the connector pushes each subdir's content into its repo. Because the repos
 * are created empty by the proxy (not seeded server-side), they are pushable
 * straight away - no ownership fixup, unlike the on-box ingest. Loose files at
 * the root are reported and skipped (a brain folder is a directory = a repo).
 */
export async function newBrain(opts: NewBrainOptions): Promise<NewBrainResult> {
  const log = opts.log ?? (() => {});
  const fromAbs = path.resolve(opts.from);
  const base = opts.baseUrl.replace(/\/+$/, "");

  const layout = await deriveFolders(fromAbs, { rootFolder: opts.includeRoot });
  if (layout.folders.length === 0) {
    throw new Error(
      `no subdirectories in ${fromAbs} to turn into folders (a brain folder is a directory)`,
    );
  }
  log(`Deriving "${opts.name}" from ${fromAbs}:`);
  for (const f of layout.folders) {
    log(`  - ${f.slug.padEnd(24)} <- ${f.files ? `root files (${f.files.join(", ")})` : `${f.source}/`}`);
  }
  if (layout.rootFiles.length && !layout.rootFilesIngested) {
    log(
      `  (skipping ${layout.rootFiles.length} loose root file(s): ${layout.rootFiles.join(", ")})`,
    );
  }

  // 1. Server: create the brain + empty folder repos, granting this user admin.
  const res = await fetch(`${base}/brains`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      brain: opts.name,
      folders: layout.folders.map((f) => ({
        slug: f.slug,
        name: f.name,
        path: f.path,
      })),
    }),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { error?: string }).error)
      .catch(() => null);
    throw new Error(
      `create brain failed: HTTP ${res.status}${detail ? ` - ${detail}` : ""}`,
    );
  }
  const created = (await res.json()) as CreateBrainResponse;
  log(`\nBrain "${created.brainSlug}" created with ${created.entries.length} folder(s). Pushing content:`);

  // 2. Client: clone each empty repo, copy its source content in, commit, push.
  const credFile = await setupPushCredentials(base, opts.token);
  const auth = gitAuthArgs(opts.token);
  const authorName = opts.authorName ?? "Monora";
  const authorEmail = opts.authorEmail ?? "connector@monora.ai";
  const ident = [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${authorEmail}`,
  ];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  // Map each created entry back to its local source via its mount path
  // (`<brainSlug>/<folder.path>`).
  const folderByMount = new Map<string, DerivedFolder>(
    layout.folders.map((f) => [`${created.brainSlug}/${f.path}`, f]),
  );

  const pushed: { mountPath: string; commit: string }[] = [];
  for (const entry of created.entries) {
    const folder = folderByMount.get(entry.mountPath);
    if (!folder) {
      log(`  ! ${entry.mountPath}: no matching source, skipped`);
      continue;
    }
    const dest = path.join(opts.workspace, entry.mountPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await exec("git", [...auth, "clone", entry.cloneUrl, dest], { env });

    if (folder.files) {
      // Root-files folder: copy just the listed loose files into the repo.
      for (const file of folder.files) {
        await copyFile(path.join(fromAbs, file), path.join(dest, file));
      }
    } else {
      // Copy the subdir's content into the cloned (empty) working tree.
      await cp(path.join(fromAbs, folder.source), dest, {
        recursive: true,
        filter: (src) => !src.split(path.sep).includes(".git"),
      });
    }

    await exec("git", ["-C", dest, "add", "-A"], { env });
    await exec(
      "git",
      ["-C", dest, ...ident, "commit", "-m", `seed ${entry.mountPath} from ${folder.files ? "root files" : `${folder.source}/`}`],
      { env },
    );
    const { stdout: sha } = await exec("git", ["-C", dest, "rev-parse", "HEAD"], { env });
    await exec("git", [...auth, "-C", dest, "push", "origin", "HEAD:main"], { env });

    // Wire the credential helper so the user's later `git push` needs no prompt.
    if (credFile) {
      await exec("git", ["-C", dest, "config", "credential.helper", `store --file=${credFile}`]);
      await exec("git", ["-C", dest, "config", "credential.useHttpPath", "false"]);
    }
    pushed.push({ mountPath: entry.mountPath, commit: sha.trim().slice(0, 8) });
    log(`  pushed  ${entry.mountPath}  @ ${sha.trim().slice(0, 8)}`);
  }

  return {
    brainSlug: created.brainSlug,
    pushed,
    skippedRootFiles: layout.rootFilesIngested ? [] : layout.rootFiles,
  };
}
