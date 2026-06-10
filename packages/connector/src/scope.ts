import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "@monora/core";

/**
 * A *workspace scope* narrows which authorized folders a given local tree
 * actually materializes. The server manifest is the same for every workspace a
 * user opens (it lists everything they can read, composed across all their
 * orgs); the scope is a purely *local* layout choice - "in THIS directory I
 * only want the dreamshot brain" - so it lives next to the workspace, not in
 * the token or the server.
 *
 * It never widens access: a scope can only hide folders the manifest already
 * granted, never reveal one it withheld. Authorization stays server-side; this
 * is noise reduction. A workspace with no scope file composes the whole
 * manifest, the historical default.
 */
export interface WorkspaceScope {
  /** Allowlist of brain slugs - the first segment of a mount path
   *  (`dreamshot/skills` -> `dreamshot`). */
  brains?: string[];
  /** Allowlist of org ids. */
  orgs?: string[];
}

export function scopePath(workspace: string): string {
  return path.join(workspace, ".monora", "workspace.json");
}

/** The brain slug a mount path belongs to (its first segment). */
export function brainOf(mountPath: string): string {
  return mountPath.split("/")[0] ?? mountPath;
}

/** Coerce arbitrary JSON into a string allowlist, dropping non-strings and
 *  blanks. Returns undefined for an empty/absent list so callers can treat
 *  "no list" and "empty list" the same. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

/** True when a scope actually constrains anything. An object with no usable
 *  brains/orgs imposes no filter (treated as "compose everything"). */
export function scopeIsActive(scope: WorkspaceScope | null): scope is WorkspaceScope {
  return Boolean(scope && (scope.brains?.length || scope.orgs?.length));
}

/**
 * Read the workspace scope, or null when there is none to apply (file absent,
 * empty, unparseable, or listing nothing usable).
 *
 * Fail OPEN: a malformed scope file behaves as no filter, never as "hide
 * everything". A typo should at worst leave extra folders on disk - it must
 * never make authorized folders silently vanish.
 */
export async function readWorkspaceScope(
  workspace: string,
): Promise<WorkspaceScope | null> {
  let raw: string;
  try {
    raw = await readFile(scopePath(workspace), "utf8");
  } catch {
    return null; // no scope file -> no filter
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // present but not JSON -> fail open
  }
  if (!parsed || typeof parsed !== "object") return null;
  const scope: WorkspaceScope = {};
  const brains = stringList((parsed as Record<string, unknown>).brains);
  const orgs = stringList((parsed as Record<string, unknown>).orgs);
  if (brains) scope.brains = brains;
  if (orgs) scope.orgs = orgs;
  return scopeIsActive(scope) ? scope : null;
}

export async function writeWorkspaceScope(
  workspace: string,
  scope: WorkspaceScope,
): Promise<void> {
  await mkdir(path.join(workspace, ".monora"), { recursive: true });
  await writeFile(scopePath(workspace), JSON.stringify(scope, null, 2) + "\n");
}

/** Does this brain/org pass the scope? A folder is kept if its brain OR its org
 *  is allowlisted; an absent list simply contributes no matches. (Both lists
 *  absent never reaches here - readWorkspaceScope returns null instead.) */
export function scopeAllows(
  scope: WorkspaceScope,
  brainSlug: string,
  orgId: string,
): boolean {
  const brainOk = scope.brains?.includes(brainSlug) ?? false;
  const orgOk = scope.orgs?.includes(orgId) ?? false;
  return brainOk || orgOk;
}

/** The manifest narrowed to the folders this workspace's scope keeps. */
export function applyScope(manifest: Manifest, scope: WorkspaceScope): Manifest {
  return {
    ...manifest,
    entries: manifest.entries.filter((e) =>
      scopeAllows(scope, brainOf(e.mountPath), e.orgId),
    ),
  };
}
