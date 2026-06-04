"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  History,
  Lock,
  Plus,
  RotateCcw,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoreMenu, MenuItem } from "@/components/ui/menu";
import { FileCard, toFileMeta } from "@/components/file-types";
import { FileView } from "@/components/file-viewer";
import { trpc } from "@/lib/trpc/client";

export type Brain = { id: string; name: string; slug: string };
type Folder = {
  id: string;
  brainId: string;
  parentFolderId: string | null;
  name: string;
  slug: string;
  path: string;
  defaultBranch: string;
};

/** The reserved slug of a brain's root folder (mounts at the brain root itself).
 *  Kept in sync with BRAIN_ROOT_SLUG in @monora/core; inlined here to avoid
 *  pulling the core barrel into the client bundle. */
const BRAIN_ROOT_SLUG = "_root";
const isBrainRootSlug = (slug: string) => slug === BRAIN_ROOT_SLUG;

/** Small gradient avatar (the brain's first letter), matching the org chip. */
export function BrainAvatar({
  name,
  className = "size-7 rounded-md text-xs",
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      className={`grid place-items-center font-bold text-white [background:var(--grad-warm)] ${className}`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* ----------------------------- create a brain ---------------------------- */

/** Top-right action: reveals an inline form, creates a brain (= brain), and
 *  navigates into it. No Dialog primitive needed. */
export function AddBrainButton() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const create = trpc.org.createBrain.useMutation({
    onSuccess: (brain) => {
      setName("");
      setOpen(false);
      utils.org.listBrains.invalidate();
      router.push(`/brains/${brain.id}`);
    },
  });

  return (
    <div className="relative">
      <Button onClick={() => setOpen((v) => !v)}>
        <Plus className="size-4" /> Add brain
      </Button>
      {open && (
        <form
          className="absolute right-0 z-10 mt-2 w-72 rounded-lg border border-border bg-card p-3 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name: name.trim() });
          }}
        >
          <Input
            autoFocus
            placeholder="Brain name (e.g. Acme)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={create.isPending}>
              Create
            </Button>
          </div>
          {create.error && (
            <p className="mt-2 text-xs text-destructive">
              {create.error.message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

/* ------------------------------ versioning ------------------------------- */

/** Save / restore brain-wide versions (the rollback safety net for agentic
 *  edits). Admin-only server-side; the list query errors with FORBIDDEN for
 *  non-admins, so we simply render nothing for them. */
function BrainVersions({ brainId }: { brainId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const list = trpc.versioning.list.useQuery({ brainId }, { retry: false });
  const create = trpc.versioning.create.useMutation({
    onSuccess: () => {
      setLabel("");
      utils.versioning.list.invalidate({ brainId });
    },
  });
  const restore = trpc.versioning.restore.useMutation({
    onSuccess: () => {
      setConfirmId(null);
      setOpen(false);
      utils.versioning.list.invalidate({ brainId });
      utils.brain.browseFolder.invalidate();
      router.refresh();
    },
  });

  // Hidden for non-admins (the list query is admin-gated).
  if (list.error) return null;

  const snapshots = list.data ?? [];

  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((v) => !v)}>
        <History className="size-4" /> Versions
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-border bg-card p-3 shadow-card">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate({ brainId, label: label.trim() || undefined });
              }}
            >
              <Input
                placeholder="Label (optional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="h-9"
              />
              <Button type="submit" size="sm" disabled={create.isPending}>
                <Save className="size-4" /> Save
              </Button>
            </form>

            <div className="my-2 border-t border-border" />

            {snapshots.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                No saved versions yet. Save one to be able to roll the brain
                back.
              </p>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-auto">
                {snapshots.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {s.label || "Version"}
                      </div>
                      <div className="truncate text-xs text-faint">
                        {new Date(s.createdAt).toLocaleString()} ·{" "}
                        {s.entries.length} folders
                      </div>
                    </div>
                    {confirmId === s.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={restore.isPending}
                          onClick={() => restore.mutate({ snapshotId: s.id })}
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0"
                        onClick={() => setConfirmId(s.id)}
                      >
                        <RotateCcw className="size-3.5" /> Restore
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {restore.error && (
              <p className="mt-2 text-xs text-destructive">
                {restore.error.message}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------- explorer -------------------------------- */

/** Build the explorer URL for a location within a brain. The URL is the source
 *  of truth for navigation (Drive-style): `/brains/<id>/<folderSlug>/<subpath>`. */
function brainHref(brainId: string, folderSlug?: string, subpath?: string): string {
  const segs = [brainId, folderSlug, subpath].filter(Boolean);
  return "/brains/" + segs.join("/");
}

/**
 * The Finder for one brain: its folders, then the git file tree inside each.
 * Location is driven by the URL `segments` (the path after the brain id), so
 * every folder is deep-linkable and the browser back/forward just work.
 */
export function BrainExplorer({
  brainId,
  segments,
}: {
  brainId: string;
  segments: string[];
}) {
  const router = useRouter();
  const brains = trpc.org.listBrains.useQuery();
  // Only folders the caller can READ (absent, not empty - a folder you weren't
  // granted is invisible). Includes nested folders, each its own repo + ACL.
  const folders = trpc.brain.accessibleFolders.useQuery();

  const brain = brains.data?.find((b) => b.id === brainId) ?? null;
  const myFolders = (folders.data ?? []).filter((f) => f.brainId === brainId);

  // The active folder = the deepest folder whose mount path prefixes the URL
  // segments (a nested folder is a real entity). The remainder is a git subpath
  // inside that folder's repo.
  const active =
    [...myFolders]
      .sort((a, b) => b.path.length - a.path.length)
      .find((f) => {
        const fseg = f.path.split("/");
        return fseg.every((s, i) => segments[i] === s);
      }) ?? null;
  const path = active
    ? segments.slice(active.path.split("/").length).join("/")
    : "";
  // The brain's root folder (mounts at the brain root) is the home for
  // brain-wide files + the brain's sharing ACL; it is never a regular chip.
  const rootFolder = myFolders.find((f) => isBrainRootSlug(f.slug)) ?? null;
  const topFolders = myFolders.filter(
    (f) => f.parentFolderId === null && !isBrainRootSlug(f.slug),
  );

  if (brains.isLoading) {
    return <p className="mt-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (!brain) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">Brain not found.</p>
    );
  }

  const folderMissing = segments.length > 0 && !active && !folders.isLoading;

  // Sharing is anchored to the *current location* in the breadcrumb (Drive-style),
  // so its scope is never ambiguous: at the brain root it edits the brain (its
  // `_root` ACL); inside a folder it edits that folder; inside a git subdir it
  // edits the owning folder's ACL and says so (inheritedFrom). A plain git subdir
  // has no ACL of its own, hence path === "" distinguishes "at a folder root".
  const shareTarget: ShareTarget | null =
    segments.length === 0
      ? rootFolder
        ? { folderId: rootFolder.id, scope: "brain" }
        : null
      : active
        ? {
            folderId: active.id,
            scope: "folder",
            inheritedFrom: path === "" ? undefined : active.name,
          }
        : null;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <BrainAvatar name={brain.name} className="size-10 rounded-lg text-base" />
          <div>
            <h1 className="text-3xl leading-tight">{brain.name}</h1>
            <span className="font-mono text-xs text-faint">/{brain.slug}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <BrainVersions brainId={brainId} />
          <AddBrainButton />
        </div>
      </div>

      <Breadcrumb
        brainId={brainId}
        brain={brain}
        segments={segments}
        folders={myFolders}
        shareTarget={shareTarget}
      />

      <div className="mt-4 space-y-4">
        {active === null ? (
          folderMissing ? (
            <Empty>Folder not found in this brain.</Empty>
          ) : (
            <>
              {topFolders.length > 0 && (
                <FolderGrid>
                  {topFolders.map((f) => (
                    <RootFolderChip
                      key={f.id}
                      folder={f}
                      onOpen={() => router.push(brainHref(brainId, f.path))}
                    />
                  ))}
                </FolderGrid>
              )}
              {rootFolder && (
                <BrainRootFiles brainId={brainId} folder={rootFolder} />
              )}
              {!folders.isLoading &&
                topFolders.length === 0 &&
                !rootFolder && (
                  <Empty>No folders in this brain yet.</Empty>
                )}
            </>
          )
        ) : (
          <FolderView
            key={active.id + ":" + path}
            brainId={brainId}
            folder={active}
            path={path}
            navigate={(sub) => router.push(brainHref(brainId, active.path, sub))}
          />
        )}
      </div>
    </div>
  );
}

/** What the breadcrumb's current-location menu shares. `brain` = the whole brain
 *  (its `_root` ACL); `folder` = one folder's ACL, with `inheritedFrom` set when
 *  the location is a git subdir that has no ACL of its own. */
type ShareTarget = {
  folderId: string;
  scope: "brain" | "folder";
  inheritedFrom?: string;
};

function Breadcrumb({
  brainId,
  brain,
  segments,
  folders,
  shareTarget,
}: {
  brainId: string;
  brain: Brain;
  segments: string[];
  folders: Folder[];
  /** Access controls for the current location, hung off the last crumb. */
  shareTarget: ShareTarget | null;
}) {
  // Label each URL segment with the matching folder's name when one mounts at
  // that cumulative path; otherwise the raw segment (a git subdir).
  const nameByPath = new Map(folders.map((f) => [f.path, f.name]));
  const crumbs: { label: string; href: string }[] = [
    { label: brain.name, href: brainHref(brainId) },
  ];
  segments.forEach((seg, i) => {
    const cum = segments.slice(0, i + 1).join("/");
    crumbs.push({ label: nameByPath.get(cum) ?? seg, href: brainHref(brainId, cum) });
  });

  return (
    <div className="mt-5 flex flex-wrap items-center gap-1 text-sm">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.href} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-faint" />}
            {last ? (
              shareTarget ? (
                <CrumbShareMenu label={c.label} target={shareTarget} />
              ) : (
                <span className="font-medium text-foreground">{c.label}</span>
              )
            ) : (
              <Link
                href={c.href}
                className="text-muted-foreground hover:text-foreground"
              >
                {c.label}
              </Link>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** The current crumb as a Drive-style dropdown: clicking it opens "who can
 *  access here". Its scope is exactly the location shown, so granting access can
 *  never silently leak the whole brain. Admin-only server-side (membersForFolder
 *  is admin-gated); for non-admins the query errors and we fall back to plain
 *  text, so the breadcrumb still reads correctly. */
function CrumbShareMenu({
  label,
  target,
}: {
  label: string;
  target: ShareTarget;
}) {
  const [open, setOpen] = useState(false);
  const members = trpc.access.membersForFolder.useQuery(
    { folderId: target.folderId },
    { retry: false },
  );

  // Non-admin (or otherwise no manage rights): just the label, no affordance.
  if (members.error) {
    return <span className="font-medium text-foreground">{label}</span>;
  }

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 flex items-center gap-1 rounded-md px-1 font-medium text-foreground hover:bg-secondary"
      >
        {label}
        <ChevronDown className="size-3.5 text-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-2 w-80 rounded-lg border border-border bg-card p-3 shadow-card">
            {target.scope === "brain" ? (
              <>
                <p className="px-1 pb-0.5 text-xs font-semibold text-muted-foreground">
                  Who can see this brain
                </p>
                <p className="px-1 pb-1 text-xs text-faint">
                  Anyone granted here sees the brain and its root files. Folders
                  inside are shared separately.
                </p>
              </>
            ) : (
              <>
                <p className="px-1 pb-0.5 text-xs font-semibold text-muted-foreground">
                  Who can access this folder
                </p>
                {target.inheritedFrom ? (
                  <p className="px-1 pb-1 text-xs text-faint">
                    Inherited from{" "}
                    <span className="font-medium text-muted-foreground">
                      {target.inheritedFrom}
                    </span>{" "}
                    - changes apply to everything inside it.
                  </p>
                ) : (
                  <p className="px-1 pb-1 text-xs text-faint">
                    Anyone granted here can access this folder and everything
                    inside it.
                  </p>
                )}
              </>
            )}
            <FolderAccess
              folderId={target.folderId}
              onDone={() => setOpen(false)}
            />
          </div>
        </>
      )}
    </span>
  );
}

export function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

/** Dense grid for compact folder chips (Drive shows folders above files). */
function FolderGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </div>
  );
}

/** Grid for file preview cards. */
function FileGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </div>
  );
}

/** Small caps section heading, e.g. "Folders" / "Files". */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** A double-clickable tile (folders/dirs). */
export function Tile({
  icon,
  title,
  subtitle,
  onOpen,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onOpen?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      onDoubleClick={onOpen}
      title={onOpen ? "Double-click to open" : undefined}
      className={`rounded-lg border border-border bg-card p-4 transition-colors ${
        onOpen ? "cursor-pointer hover:border-accent/50 hover:bg-secondary" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{title}</div>
          {subtitle && (
            <div className="truncate font-mono text-xs text-faint">
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/** The compact folder chip - icon + name (+ optional ⋮ menu), one or two lines.
 *  Single click opens; the menu (if any) catches its own clicks. */
function FolderChip({
  name,
  subtitle,
  onOpen,
  menu,
}: {
  name: string;
  subtitle?: string;
  onOpen: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div
      onClick={onOpen}
      title={name}
      className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-accent/40 hover:bg-secondary"
    >
      <FolderIcon className="size-5 shrink-0 text-folder" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        {subtitle && (
          <div className="truncate font-mono text-xs text-faint">{subtitle}</div>
        )}
      </div>
      {menu && (
        // Always visible (muted), not hover-only: the access menu is the only way
        // to manage a folder's permissions, so it must be discoverable on every
        // chip and on touch/trackpad where there's no hover. Brightens on hover.
        <span className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {menu}
        </span>
      )}
    </div>
  );
}

/** The ⋮ menu shared by every folder and file. Access in Monora is enforced at
 *  the top-level folder (one git repo per folder), so nested items have no ACL of
 *  their own - this menu edits the owning folder's access, and `inheritedFrom`
 *  spells that out so it's never misleading. */
function ItemAccessMenu({
  folderId,
  onOpen,
  openLabel = "Open",
  inheritedFrom,
}: {
  /** The top-level folder whose ACL this menu edits. */
  folderId: string;
  /** Primary action; omit for items with nothing to open yet (files). */
  onOpen?: () => void;
  openLabel?: string;
  /** Name of the owning folder when this item is nested inside it. */
  inheritedFrom?: string;
}) {
  return (
    <MoreMenu align="right">
      {(close) => (
        <div className="w-80">
          {onOpen && (
            <>
              <MenuItem
                icon={FolderOpen}
                onClick={() => {
                  close();
                  onOpen();
                }}
              >
                {openLabel}
              </MenuItem>
              <div className="my-1 border-t border-border" />
            </>
          )}
          <p className="px-2.5 pb-0.5 pt-1 text-xs font-semibold text-muted-foreground">
            Manage access
          </p>
          {inheritedFrom && (
            <p className="px-2.5 pb-1 text-xs text-faint">
              Inherited from{" "}
              <span className="font-medium text-muted-foreground">
                {inheritedFrom}
              </span>{" "}
              - changes apply to everything inside it.
            </p>
          )}
          <div className="px-1 pb-1">
            <FolderAccess folderId={folderId} onDone={close} />
          </div>
        </div>
      )}
    </MoreMenu>
  );
}

/** A brain's top-level folder (= one git repo): shows its mount path and carries
 *  the per-folder access controls in its ⋮ menu. */
function RootFolderChip({ folder, onOpen }: { folder: Folder; onOpen: () => void }) {
  return (
    <FolderChip
      name={folder.name}
      subtitle={`/${folder.path}`}
      onOpen={onOpen}
      menu={<ItemAccessMenu folderId={folder.id} onOpen={onOpen} />}
    />
  );
}

/** A folder/file access error (forbidden or otherwise), shown in place. */
function AccessError({
  error,
  subject,
}: {
  error: { data?: { code?: string } | null; message: string };
  subject: "folder" | "file";
}) {
  const forbidden = error.data?.code === "FORBIDDEN";
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <Lock className="mx-auto size-6 text-faint" />
      <p className="mt-2 text-sm font-medium">
        {forbidden
          ? `No read access to this ${subject}`
          : `Could not open ${subject}`}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {forbidden
          ? "Access is enforced server-side. Grant yourself read in Manage access to browse it."
          : error.message}
      </p>
    </div>
  );
}

/**
 * What's at `path` inside a folder. The URL doesn't say whether a path is a
 * file or a directory, so we ask the parent listing: if the leaf is a file we
 * render it in-page (Drive/GitHub-style), otherwise we list the directory.
 */
function FolderView({
  brainId,
  folder,
  path,
  navigate,
}: {
  brainId: string;
  folder: Folder;
  path: string;
  /** Go to a subpath within this folder (dir or file). */
  navigate: (subpath: string) => void;
}) {
  const isRoot = path === "";
  const slash = path.lastIndexOf("/");
  const parentPath = slash === -1 ? "" : path.slice(0, slash);
  const leafName = slash === -1 ? path : path.slice(slash + 1);

  // The parent listing tells us the leaf's type. Skipped at the folder root
  // (which is always a directory).
  const parent = trpc.brain.browseFolder.useQuery(
    { folderId: folder.id, path: parentPath || undefined },
    { retry: false, enabled: !isRoot },
  );

  if (!isRoot && parent.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (!isRoot && parent.error) {
    return <AccessError error={parent.error} subject="file" />;
  }

  const leaf = isRoot ? undefined : parent.data?.find((e) => e.path === path);
  if (leaf?.type === "file") {
    return <FileView folderId={folder.id} file={{ name: leafName, path }} />;
  }

  return (
    <DirListing brainId={brainId} folder={folder} path={path} navigate={navigate} />
  );
}

/** The directory listing: child folders (real sub-folders, each their own repo
 *  + ACL) and git dirs, then files - all as Drive-style cards. Child folders are
 *  only shown at the folder's repo root (path === ""); deeper you're inside one
 *  repo's git tree. */
function DirListing({
  brainId,
  folder,
  path,
  navigate,
}: {
  brainId: string;
  folder: Folder;
  path: string;
  navigate: (subpath: string) => void;
}) {
  const router = useRouter();
  const entries = trpc.brain.browseFolder.useQuery(
    { folderId: folder.id, path: path || undefined },
    { retry: false },
  );
  // Real child folders (separate repos) live only at this folder's root. They
  // come from the accessible-folders list, so unauthorized ones are absent.
  const allFolders = trpc.brain.accessibleFolders.useQuery();
  const childFolders =
    path === ""
      ? (allFolders.data ?? []).filter(
          (f) => f.parentFolderId === folder.id && !isBrainRootSlug(f.slug),
        )
      : [];

  if (entries.error) {
    return <AccessError error={entries.error} subject="folder" />;
  }

  const items = entries.data ?? [];
  const dirs = items.filter((e) => e.type === "dir");
  const files = items.filter((e) => e.type === "file");
  const hasFolders = childFolders.length > 0 || dirs.length > 0;

  return (
    <div className="space-y-6">
      {hasFolders && (
        <section>
          <SectionLabel>Folders</SectionLabel>
          <FolderGrid>
            {/* Child folders: real entities, each editing its OWN access. */}
            {childFolders.map((f) => (
              <FolderChip
                key={f.id}
                name={f.name}
                onOpen={() => router.push(brainHref(brainId, f.path))}
                menu={
                  <ItemAccessMenu
                    folderId={f.id}
                    onOpen={() => router.push(brainHref(brainId, f.path))}
                  />
                }
              />
            ))}
            {/* Plain git directories inside this folder's repo. They have no
                ACL of their own, so their menu edits the owning folder's access
                (inheritedFrom makes that explicit). */}
            {dirs.map((e) => (
              <FolderChip
                key={e.path}
                name={e.name}
                onOpen={() => navigate(e.path)}
                menu={
                  <ItemAccessMenu
                    folderId={folder.id}
                    onOpen={() => navigate(e.path)}
                    inheritedFrom={folder.name}
                  />
                }
              />
            ))}
          </FolderGrid>
        </section>
      )}

      {files.length > 0 && (
        <section>
          <SectionLabel>Files</SectionLabel>
          <FileGrid>
            {files.map((e) => (
              <FileCard
                key={e.path}
                file={toFileMeta({ name: e.name, path: e.path })}
                onSelect={() => navigate(e.path)}
                onOpen={() => navigate(e.path)}
              />
            ))}
          </FileGrid>
        </section>
      )}

      {!entries.isLoading && !hasFolders && files.length === 0 && (
        <Empty>This folder is empty.</Empty>
      )}
    </div>
  );
}

/** The brain's root files (CLAUDE.md, README, ...) - the contents of the `_root`
 *  folder's repo, shown at the brain's top level alongside its folders. Hidden
 *  if the caller can't read the root or it's empty. */
function BrainRootFiles({
  brainId,
  folder,
}: {
  brainId: string;
  folder: Folder;
}) {
  const router = useRouter();
  const entries = trpc.brain.browseFolder.useQuery(
    { folderId: folder.id },
    { retry: false },
  );

  if (entries.error) return null;
  const items = entries.data ?? [];
  const dirs = items.filter((e) => e.type === "dir");
  const files = items.filter((e) => e.type === "file");
  if (dirs.length === 0 && files.length === 0) return null;

  const go = (sub: string) => router.push(brainHref(brainId, folder.path, sub));

  return (
    <>
      {dirs.length > 0 && (
        <section>
          <SectionLabel>Folders</SectionLabel>
          <FolderGrid>
            {dirs.map((e) => (
              <FolderChip
                key={e.path}
                name={e.name}
                onOpen={() => go(e.path)}
                menu={
                  <ItemAccessMenu
                    folderId={folder.id}
                    onOpen={() => go(e.path)}
                    inheritedFrom={folder.name}
                  />
                }
              />
            ))}
          </FolderGrid>
        </section>
      )}
      {files.length > 0 && (
        <section>
          <SectionLabel>Files</SectionLabel>
          <FileGrid>
            {files.map((e) => (
              <FileCard
                key={e.path}
                file={toFileMeta({ name: e.name, path: e.path })}
                onSelect={() => go(e.path)}
                onOpen={() => go(e.path)}
              />
            ))}
          </FileGrid>
        </section>
      )}
    </>
  );
}

const LEVELS = ["none", "read", "write", "admin"] as const;

/** Circular initials avatar for an org member (Drive shows photos; we only have
 *  initials, so use a soft neutral chip to stay calm even with many rows). */
function MemberAvatar({ name }: { name: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground">
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Drive-style borderless role picker: reads as plain text + chevron, reveals a
 *  hover surface, and is still a native <select> so the option list is free. */
function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative shrink-0">
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none rounded-md py-1 pl-2.5 pr-7 text-sm font-medium capitalize text-muted-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
      >
        {LEVELS.map((l) => (
          <option key={l} value={l} className="capitalize">
            {l}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
    </div>
  );
}

function FolderAccess({
  folderId,
  onDone,
}: {
  folderId: string;
  /** Closes the surrounding popover when the user presses "Done". */
  onDone?: () => void;
}) {
  const utils = trpc.useUtils();
  const members = trpc.access.membersForFolder.useQuery({ folderId });
  // When on, grant/revoke apply to this folder AND every subfolder under it
  // right now - a one-time bulk-apply, not live inheritance. Folders created
  // later stay private by default.
  const [cascade, setCascade] = useState(false);
  const grant = trpc.access.grant.useMutation({
    onSuccess: () => utils.access.membersForFolder.invalidate({ folderId }),
  });
  const revoke = trpc.access.revoke.useMutation({
    onSuccess: () => utils.access.membersForFolder.invalidate({ folderId }),
  });
  const busy = grant.isPending || revoke.isPending;

  const setPermission = (userId: string, v: string) => {
    if (v === "none")
      revoke.mutate({ folderId, userId, includeDescendants: cascade });
    else
      grant.mutate({
        folderId,
        userId,
        permission: v as "read" | "write" | "admin",
        includeDescendants: cascade,
      });
  };

  if (!members.data?.length) {
    return (
      <p className="mt-2 px-1 text-sm text-muted-foreground">
        No members to grant yet. Invite teammates first.
      </p>
    );
  }

  return (
    <div className="mt-1">
      <div className="space-y-0.5">
        {members.data.map((m) => (
          <div
            key={m.userId}
            className="flex items-center gap-3 rounded-md px-1.5 py-1.5"
          >
            <MemberAvatar name={m.name} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {m.name}
              </div>
              <div className="truncate text-xs text-faint">{m.email}</div>
            </div>
            <RoleSelect
              value={m.permission ?? "none"}
              disabled={busy}
              onChange={(v) => setPermission(m.userId, v)}
            />
          </div>
        ))}
      </div>

      <div className="my-2 border-t border-border" />

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-secondary/60">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent"
          checked={cascade}
          onChange={(e) => setCascade(e.target.checked)}
        />
        <span className="text-xs leading-snug">
          <span className="font-medium text-foreground">
            Apply to all current subfolders
          </span>
          <span className="block text-faint">
            Sets the same access on everything inside this folder right now.
          </span>
        </span>
      </label>

      {onDone && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
