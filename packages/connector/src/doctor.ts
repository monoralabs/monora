import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, stat } from "node:fs/promises";
import path from "node:path";
import { readCredentials, defaultConfigPath } from "./config";
import { ancestorRepoTracking } from "./sync";

const exec = promisify(execFile);

/**
 * `monora doctor` - self-diagnose why a folder you were granted isn't showing
 * up, or why a synced folder won't update. The most common support question is
 * "why don't I see folder X?", and the answer is almost always one of a handful
 * of states that look identical from the outside ("it's just not there"):
 *
 *   - not logged in / login no longer valid,
 *   - can't reach the server,
 *   - the folder was shared AFTER your last sync (just re-sync),
 *   - access was revoked (it'll leave on the next sync),
 *   - a folder has uncommitted changes that block a clean update/removal.
 *
 * Every check here runs against what the user's own login can already see - the
 * live manifest plus the local tree - so it needs no admin and no new server
 * endpoint. It prints one plain report with a single clear next step, and exits
 * non-zero when something is actionable so it can be scripted.
 */

export interface DoctorOptions {
  workspace: string;
  configPath?: string;
}

export interface DoctorReport {
  /** True when something needs the user to act (drives a non-zero exit). */
  actionable: boolean;
  loggedIn: boolean;
  /** null when we never got far enough to try the server. */
  reachable: boolean | null;
  authValid: boolean | null;
  host: string | null;
  /** Has this directory been synced before (has a `.monora` index)? */
  isWorkspace: boolean;
  /** Epoch ms of the last sync (mtime of the workspace index), or null. */
  lastSyncAt: number | null;
  /** Folders the login is authorized to read (manifest size). */
  authorizedCount: number;
  /** Of those, how many are present on disk. */
  onDiskCount: number;
  /** Authorized but not on disk - typically granted after the last sync. */
  missingOnDisk: string[];
  /** Authorized, and the content IS on disk, but tucked inside a parent
   *  folder's repo instead of standing on its own (the local layout diverged
   *  from the server's split). NOT "missing" - `sync` would refuse to overwrite
   *  it, so telling the user to sync would be wrong. */
  nestedInParent: string[];
  /** On disk (from a previous sync) but no longer authorized. */
  revoked: string[];
  /** On-disk folders with uncommitted changes (block a clean pull/removal). */
  dirty: string[];
}

interface ManifestShape {
  orgId: string;
  subjectId: string;
  entries: { mountPath: string; repoName: string }[];
}

interface WorkspaceMeta {
  entries: { mountPath: string }[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirty(dest: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["-C", dest, "status", "--porcelain"]);
    return stdout.trim() !== "";
  } catch {
    // Not a clean git checkout (e.g. present but never mounted). Not "dirty" in
    // the uncommitted-changes sense; doctor reports it as missing-on-disk via
    // the .git probe instead.
    return false;
  }
}

/**
 * Diagnose the current workspace + login. Pure data in, structured report out;
 * `formatReport` turns it into the human-facing text. The split keeps the
 * decision logic testable without scraping printed lines.
 */
export async function doctor(opts: DoctorOptions): Promise<DoctorReport> {
  const configPath = opts.configPath ?? defaultConfigPath();
  const report: DoctorReport = {
    actionable: false,
    loggedIn: false,
    reachable: null,
    authValid: null,
    host: null,
    isWorkspace: false,
    lastSyncAt: null,
    authorizedCount: 0,
    onDiskCount: 0,
    missingOnDisk: [],
    nestedInParent: [],
    revoked: [],
    dirty: [],
  };

  const creds = await readCredentials(configPath).catch(() => null);
  if (!creds) {
    report.actionable = true;
    return report; // not logged in - nothing else is knowable
  }
  report.loggedIn = true;
  try {
    report.host = new URL(creds.baseUrl).host;
  } catch {
    report.host = creds.baseUrl;
  }

  // Fetch the live manifest: this single call doubles as the connectivity and
  // login-validity check. A 401 means the login is no longer good; a thrown
  // fetch means we couldn't reach the server.
  let manifest: ManifestShape | null = null;
  try {
    const res = await fetch(`${creds.baseUrl.replace(/\/+$/, "")}/manifest`, {
      headers: { authorization: `Bearer ${creds.token}` },
    });
    report.reachable = true;
    if (res.status === 401) {
      report.authValid = false;
      report.actionable = true;
      return report;
    }
    if (!res.ok) {
      // Reachable but the server refused for another reason; treat as actionable
      // and let the caller see the status via authValid=false.
      report.authValid = false;
      report.actionable = true;
      return report;
    }
    report.authValid = true;
    manifest = (await res.json()) as ManifestShape;
  } catch {
    report.reachable = false;
    report.actionable = true;
    return report;
  }

  report.authorizedCount = manifest.entries.length;

  // Last sync = when the workspace index was last written (end of `monora sync`).
  const metaPath = path.join(opts.workspace, ".monora", "manifest.json");
  const meta = (await readFile(metaPath, "utf8")
    .then((raw) => JSON.parse(raw) as WorkspaceMeta)
    .catch(() => null)) as WorkspaceMeta | null;
  if (meta) {
    report.isWorkspace = true;
    report.lastSyncAt = await stat(metaPath)
      .then((s) => s.mtimeMs)
      .catch(() => null);
  }

  // Authorized but not on disk: the heart of the "I don't see folder X" case.
  // A folder is "on disk" when its mount has a `.git` - the same condition sync
  // uses to decide clone-vs-pull.
  for (const entry of manifest.entries) {
    const dest = path.join(opts.workspace, entry.mountPath);
    if (await exists(path.join(dest, ".git"))) {
      report.onDiskCount += 1;
      if (await isDirty(dest)) report.dirty.push(entry.mountPath);
    } else if (await ancestorRepoTracking(dest, opts.workspace)) {
      // Content is here, just owned by a parent folder's repo rather than
      // standing alone. Not missing - reporting it as such would send the user
      // to `sync`, which now refuses to overwrite it.
      report.nestedInParent.push(entry.mountPath);
    } else {
      report.missingOnDisk.push(entry.mountPath);
    }
  }

  // Revoked: present from a previous sync but no longer in the manifest. It will
  // be removed on the next sync (only if clean), so flag a dirty one.
  if (meta) {
    const authorized = new Set(manifest.entries.map((e) => e.mountPath));
    for (const prev of meta.entries) {
      if (authorized.has(prev.mountPath)) continue;
      const dest = path.join(opts.workspace, prev.mountPath);
      if (!(await exists(dest))) continue;
      report.revoked.push(prev.mountPath);
      if (await isDirty(dest)) report.dirty.push(prev.mountPath);
    }
  }

  report.missingOnDisk.sort();
  report.nestedInParent.sort();
  report.revoked.sort();
  report.dirty.sort();

  report.actionable =
    report.missingOnDisk.length > 0 ||
    report.nestedInParent.length > 0 ||
    report.dirty.length > 0;
  return report;
}

function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * Render a report as plain, friendly lines with one clear next step - the
 * product voice (no "token", no jargon). `now` is injectable for stable tests.
 */
export function formatReport(
  report: DoctorReport,
  now: number = Date.now(),
): string[] {
  if (!report.loggedIn) {
    return [
      "You're not logged in.",
      "Run `monora login --url <your Monora URL>` to connect.",
    ];
  }
  if (report.reachable === false) {
    return [
      `Can't reach ${report.host}.`,
      "Check your connection (and that the URL is right), then try again.",
    ];
  }
  if (report.authValid === false) {
    return [
      "Your login isn't valid anymore (expired or revoked).",
      "Run `monora login --url <your Monora URL>` to reconnect.",
    ];
  }

  const lines: string[] = [];
  const headline = report.actionable
    ? "Found something worth a look."
    : "Everything looks healthy.";
  lines.push(headline);
  lines.push(`  Connected to ${report.host}`);
  if (report.lastSyncAt != null) {
    lines.push(`  Last sync: ${ago(report.lastSyncAt, now)}`);
  } else if (!report.isWorkspace) {
    lines.push("  This folder hasn't been synced yet");
  }
  lines.push(
    `  ${report.authorizedCount} folder${report.authorizedCount === 1 ? "" : "s"} shared with you, ${report.onDiskCount} on disk`,
  );

  if (report.missingOnDisk.length) {
    const n = report.missingOnDisk.length;
    lines.push("");
    lines.push(
      `${n} folder${n === 1 ? "" : "s"} shared with you ${n === 1 ? "isn't" : "aren't"} on your computer yet:`,
    );
    for (const m of report.missingOnDisk) lines.push(`  ${m}`);
    lines.push("Run `monora sync` to bring them in.");
  }

  if (report.nestedInParent.length) {
    const n = report.nestedInParent.length;
    lines.push("");
    lines.push(
      `${n} folder${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} already on your computer, but tucked inside a parent folder instead of standing on ${n === 1 ? "its" : "their"} own:`,
    );
    for (const m of report.nestedInParent) lines.push(`  ${m}`);
    lines.push(
      "Your local layout differs from the server's. Nothing is lost, and sync won't overwrite it - leave it as is, or reorganize before syncing.",
    );
  }

  // Only mention clean revocations; a dirty one is covered by the dirty block.
  const cleanRevoked = report.revoked.filter((r) => !report.dirty.includes(r));
  if (cleanRevoked.length) {
    lines.push("");
    lines.push(
      `${cleanRevoked.length} folder${cleanRevoked.length === 1 ? "" : "s"} you no longer have access to will be removed on the next sync:`,
    );
    for (const r of cleanRevoked) lines.push(`  ${r}`);
  }

  if (report.dirty.length) {
    lines.push("");
    lines.push(
      `${report.dirty.length} folder${report.dirty.length === 1 ? "" : "s"} ${report.dirty.length === 1 ? "has" : "have"} unsaved changes (this blocks a clean update or removal):`,
    );
    for (const d of report.dirty) lines.push(`  ${d}`);
    lines.push('Save them with `monora save -m "what changed"`, or discard them.');
  }

  return lines;
}
