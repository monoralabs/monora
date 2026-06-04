import type { Clock, IdGenerator } from "../shared/ports";
import type { Repositories, UnitOfWork } from "../domain/uow";
import type { GitBackend } from "../domain/git/git-backend";
import type { BlobStore, BlobRef } from "../domain/git/blob-store";
import type { RepoName } from "../domain/workspace/repo-name";
import type { Slug } from "../domain/workspace/slug";
import type { Brain } from "../domain/workspace/brain";
import type { Folder } from "../domain/workspace/folder";
import type { AuditEntry } from "../domain/audit/audit";
import type { BrainSnapshot } from "../domain/versioning/brain-snapshot";
import type { AccessToken } from "../domain/access/access-token";
import type { AccessGrant } from "../domain/access/access-grant";
import type {
  TokenHasher,
  GeneratedToken,
} from "../domain/access/token-hasher";
import type { TokenLookup } from "../domain/access/token-repository";
import type { Authz, Action, Subject } from "../domain/access/authz";
import type { Memberships } from "../domain/access/memberships";
import { type Permission, permissionSatisfies } from "../domain/access/permission";

/** Deterministic fakes for unit-testing use-cases without DB or git. */

export function fixedClock(iso = "2026-05-30T12:00:00.000Z"): Clock {
  const d = new Date(iso);
  return { now: () => d };
}

export function seqIds(prefix = "id"): IdGenerator {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

export class InMemoryStore {
  brains = new Map<string, Brain>();
  folders = new Map<string, Folder>();
  tokens = new Map<string, AccessToken>();
  grants = new Map<string, AccessGrant>(); // key: `${folderId}:${userId}`
  audit: AuditEntry[] = [];
  brainSnapshots = new Map<string, BrainSnapshot>();

  /** Repositories optionally scoped to one org. `listByOrg` honors the bound
   *  org (mirroring RLS), so a cross-org manifest run sees only that org's rows
   *  per `uow.run(orgId)`. Other lookups are keyed by id/repo and stay global. */
  repositories(orgId?: string): Repositories {
    const inOrg = <T extends { orgId: string }>(xs: T[]): T[] =>
      orgId === undefined ? xs : xs.filter((x) => x.orgId === orgId);
    return {
      brains: {
        add: async (s) => {
          this.brains.set(s.id, s);
        },
        findById: async (id) => this.brains.get(id) ?? null,
        findBySlug: async (slug: Slug) =>
          [...this.brains.values()].find((s) => s.slug === slug) ?? null,
        listByOrg: async () => inOrg([...this.brains.values()]),
      },
      folders: {
        add: async (f) => {
          this.folders.set(f.id, f);
        },
        update: async (f) => {
          this.folders.set(f.id, f);
        },
        archive: async (folderId, at, by) => {
          const f = this.folders.get(folderId);
          if (f) this.folders.set(folderId, { ...f, archivedAt: at, archivedBy: by });
        },
        restore: async (folderId) => {
          const f = this.folders.get(folderId);
          if (f)
            this.folders.set(folderId, {
              ...f,
              archivedAt: null,
              archivedBy: null,
            });
        },
        findById: async (id) => this.folders.get(id) ?? null,
        findBySlugInBrain: async (brainId, slug: Slug) =>
          [...this.folders.values()].find(
            (f) => f.brainId === brainId && f.slug === slug,
          ) ?? null,
        findByRepoName: async (repoName: RepoName) =>
          [...this.folders.values()].find((f) => f.repoName === repoName) ??
          null,
        listByBrain: async (brainId) =>
          [...this.folders.values()].filter((f) => f.brainId === brainId),
        listByOrg: async () => inOrg([...this.folders.values()]),
      },
      tokens: {
        add: async (t) => {
          this.tokens.set(t.id, t);
        },
        listBySubject: async (subjectId) =>
          [...this.tokens.values()].filter((t) => t.subjectId === subjectId),
        revoke: async (tokenId, at) => {
          const t = this.tokens.get(tokenId);
          if (t) this.tokens.set(tokenId, { ...t, revokedAt: at });
        },
      },
      grants: {
        grant: async (g) => {
          this.grants.set(`${g.folderId}:${g.userId}`, g);
        },
        revoke: async (folderId, userId) => {
          this.grants.delete(`${folderId}:${userId}`);
        },
        find: async (folderId, userId) =>
          this.grants.get(`${folderId}:${userId}`) ?? null,
        listByFolder: async (folderId) =>
          [...this.grants.values()].filter((g) => g.folderId === folderId),
        listByUser: async (userId) =>
          [...this.grants.values()].filter((g) => g.userId === userId),
      },
      audit: {
        record: async (e) => {
          this.audit.push(e);
        },
      },
      snapshots: {
        add: async (s) => {
          this.brainSnapshots.set(s.id, s);
        },
        findById: async (id) => this.brainSnapshots.get(id) ?? null,
        listByBrain: async (brainId) =>
          [...this.brainSnapshots.values()]
            .filter((s) => s.brainId === brainId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      },
    };
  }

  /** The cross-tenant lookup the proxy uses (reads the same token map). */
  tokenLookup(): TokenLookup {
    return {
      findActiveByPrefix: async (prefix) =>
        [...this.tokens.values()].find((t) => t.tokenPrefix === prefix) ?? null,
      touchLastUsed: async (tokenId, at) => {
        const t = this.tokens.get(tokenId);
        if (t) this.tokens.set(tokenId, { ...t, lastUsedAt: at });
      },
    };
  }

  unitOfWork(): UnitOfWork {
    return {
      run: async (orgId, fn) => fn(this.repositories(orgId)),
    };
  }
}

export class FakeGit implements GitBackend {
  ensured: RepoName[] = [];
  snapshots: { repoName: RepoName; sourceDir: string; branch: string }[] = [];
  /** Per-repo flat file lists, settable by tests. */
  files = new Map<string, string[]>();
  private existing = new Set<string>();
  private counter = 0;

  async repoExists(repoName: RepoName) {
    return this.existing.has(repoName);
  }
  async ensureBareRepo(repoName: RepoName) {
    this.ensured.push(repoName);
    this.existing.add(repoName);
  }
  async listFiles(repoName: RepoName) {
    return this.files.get(repoName) ?? [];
  }
  /** Per-(repo,path) file contents, settable by tests. */
  contents = new Map<string, string>();
  async readFile(repoName: RepoName, path: string) {
    const c = this.contents.get(`${repoName}:${path}`);
    if (c === undefined) throw new Error(`no such file: ${path}`);
    return c;
  }
  async readFileBytes(repoName: RepoName, path: string) {
    const c = this.contents.get(`${repoName}:${path}`);
    if (c === undefined) throw new Error(`no such file: ${path}`);
    return new TextEncoder().encode(c);
  }
  /** Fixed-string grep over `files` x `contents`, mirroring the adapter's
   *  `path:line:text` rows. */
  async grep(repoName: RepoName, query: string) {
    const rows: string[] = [];
    for (const p of this.files.get(repoName) ?? []) {
      const content = this.contents.get(`${repoName}:${p}`);
      if (content === undefined) continue;
      content.split("\n").forEach((line, i) => {
        if (line.includes(query)) rows.push(`${p}:${i + 1}:${line}`);
      });
    }
    return rows;
  }
  async importSnapshot(input: {
    repoName: RepoName;
    sourceDir: string;
    branch: string;
    message: string;
  }) {
    this.snapshots.push({
      repoName: input.repoName,
      sourceDir: input.sourceDir,
      branch: input.branch,
    });
    return { commit: `commit-${++this.counter}` };
  }
  /** Per-(repo,branch) branch tips, settable by tests. */
  heads = new Map<string, string>();
  /** Recorded refs (`${repoName}:${ref}` -> sha), inspectable by tests. */
  refs = new Map<string, string>();
  async headCommit(repoName: RepoName, branch: string) {
    return this.heads.get(`${repoName}:${branch}`) ?? null;
  }
  async setRef(repoName: RepoName, ref: string, sha: string) {
    this.refs.set(`${repoName}:${ref}`, sha);
    // Moving a branch updates its tip, mirroring real update-ref.
    const m = ref.match(/^refs\/heads\/(.+)$/);
    if (m) this.heads.set(`${repoName}:${m[1]}`, sha);
  }
}

/** In-memory content-addressed store for tests. `put` dedups by a fake hash
 *  (`sha-<content>`); `get` returns the stored bytes. */
export class FakeBlobStore implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  puts = 0;
  async put(bytes: Uint8Array, contentType: string): Promise<BlobRef> {
    this.puts++;
    const sha256 = `sha-${new TextDecoder().decode(bytes)}`;
    if (!this.blobs.has(sha256)) this.blobs.set(sha256, bytes);
    return { sha256, size: bytes.length, contentType };
  }
  async get(sha256: string): Promise<Uint8Array> {
    const b = this.blobs.get(sha256);
    if (!b) throw new Error(`no such blob: ${sha256}`);
    return b;
  }
}

/** Deterministic token hasher: plaintext `tok_<n>_secret`, prefix = first 8
 *  chars, hash = `h:<plaintext>`. No crypto, fully predictable. */
export class FakeHasher implements TokenHasher {
  private n = 0;
  async generate(): Promise<GeneratedToken> {
    const plaintext = `tok_${++this.n}_secret`;
    return { plaintext, prefix: plaintext.slice(0, 8), hash: `h:${plaintext}` };
  }
  parsePrefix(plaintext: string): string {
    return plaintext.slice(0, 8);
  }
  async verify(plaintext: string, hash: string): Promise<boolean> {
    return hash === `h:${plaintext}`;
  }
}

/** Fake authz from a grants map keyed `${userId}:${folderId}`. */
export function fakeAuthz(grants: Map<string, Permission>): Authz {
  return {
    can: async (subject: Subject, action: Action, folderId: string) => {
      const held = grants.get(`${subject.userId}:${folderId}`);
      return held ? permissionSatisfies(held, action) : false;
    },
  };
}

/** Fake memberships from a `userId -> orgIds` map (defaults to none). */
export function fakeMemberships(byUser: Record<string, string[]>): Memberships {
  return {
    listOrgsForUser: async (userId: string) => byUser[userId] ?? [],
  };
}
