import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import {
  ensureBrain,
  importFolderUseCase,
  issueToken,
  revokeToken,
  systemClock,
  uuidIdGenerator,
} from "@monora/core";
import {
  createDb,
  makeUnitOfWork,
  ScryptTokenHasher,
  folderAccess,
} from "@monora/db";
import { organization, user, member } from "@monora/db/auth-schema";
import { GitShellBackend } from "@monora/git";
import { createProxyApp } from "../app";
import { buildDeps } from "../deps";

const DBURL = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
const suite = DBURL ? describe : describe.skip;

// Two orgs. ORG_A is the target; ORG_B is the attacker's own tenant.
const ORG_A = "org_adv_a";
const ORG_B = "org_adv_b";
const USER_A = "user_adv_a"; // member of ORG_A, read on alpha, write on gamma, NO grant on beta
const USER_B = "user_adv_b"; // member of ORG_B

function eqId<T>(col: T, val: string) {
  return eq(col as never, val);
}

// Response shapes - fetch().json() is `unknown` under strict TS.
type TreeResp = { files: string[] };
type ManifestResp = {
  entries: { folderId: string; repoName: string; mountPath: string }[];
};
type SearchResp = { results: { mountPath: string }[] };

suite("git-proxy ADVERSARIAL (an authorized dev tries to escape their grants)", () => {
  let root: string;
  let gitRoot: string;
  let server: Server;
  let port = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  let tokenA = ""; // USER_A, unscoped
  let tokenAScoped = ""; // USER_A, scoped to alpha only
  let tokenARevoked = ""; // USER_A, revoked
  let tokenAExpired = ""; // USER_A, already expired
  let tokenB = ""; // USER_B in ORG_B
  let alphaId = "";
  let gammaId = "";
  let brainAId = ""; // ORG_A's brain id - repo names are <brainId>/<folder>.git

  const base = () => `http://127.0.0.1:${port}`;
  const get = (p: string, token: string | null) =>
    fetch(`${base()}${p}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const post = (p: string, token: string | null, body?: unknown) =>
    fetch(`${base()}${p}`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-adv-"));
    gitRoot = path.join(root, "git");
    const src = path.join(root, "src");
    await mkdir(gitRoot, { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "vision.md"), "# TOP SECRET org brain\n");
    await writeFile(path.join(src, "salaries.md"), "CEO: 999999\n");

    db = createDb(DBURL!);
    for (const id of [ORG_A, ORG_B]) {
      await db.delete(organization).where(eqId(organization.id, id));
    }
    for (const id of [USER_A, USER_B]) {
      await db.delete(user).where(eqId(user.id, id));
    }
    await db.insert(organization).values([
      { id: ORG_A, name: "Target", slug: ORG_A },
      { id: ORG_B, name: "Attacker", slug: ORG_B },
    ]);
    await db.insert(user).values([
      { id: USER_A, name: "A", email: `${USER_A}@example.com` },
      { id: USER_B, name: "B", email: `${USER_B}@example.com` },
    ]);
    // Memberships: a user-scoped token reaches a brain only in an org the user
    // belongs to. USER_A is in ORG_A, USER_B in ORG_B (cascade-deleted with the
    // org/user rows above).
    await db.insert(member).values([
      { id: `${USER_A}_${ORG_A}`, organizationId: ORG_A, userId: USER_A },
      { id: `${USER_B}_${ORG_B}`, organizationId: ORG_B, userId: USER_B },
    ]);

    const deps = {
      uow: makeUnitOfWork(db),
      git: new GitShellBackend({ gitRoot }),
      hasher: new ScryptTokenHasher(),
      ids: uuidIdGenerator,
      clock: systemClock,
    };
    const importFolder = importFolderUseCase(deps);

    // ORG_A brain with three folders.
    const brainA = await ensureBrain(deps)({ orgId: ORG_A, name: "Acme" });
    if (!brainA.ok) throw new Error("brainA");
    brainAId = brainA.value.id;
    const mk = async (slug: string) => {
      const r = await importFolder({
        orgId: ORG_A,
        brainId: brainA.value.id,
        name: slug,
        slug,
        path: slug,
        sourceDir: src,
      });
      if (!r.ok) throw new Error(`import ${slug}`);
      return r.value.folder;
    };
    const alpha = await mk("alpha");
    await mk("beta");
    const gamma = await mk("gamma");
    alphaId = alpha.id;
    gammaId = gamma.id;

    // USER_A: read on alpha, write on gamma. NO row for beta.
    await db.insert(folderAccess).values([
      { orgId: ORG_A, folderId: alpha.id, userId: USER_A, permission: "read" },
      { orgId: ORG_A, folderId: gamma.id, userId: USER_A, permission: "write" },
    ]);

    // ORG_B brain (so USER_B has a valid token in a different tenant).
    const brainB = await ensureBrain(deps)({ orgId: ORG_B, name: "Other" });
    if (!brainB.ok) throw new Error("brainB");

    const issue = issueToken(deps);
    const t1 = await issue({ orgId: ORG_A, subjectType: "user", subjectId: USER_A, name: "a" });
    const t2 = await issue({ orgId: ORG_A, subjectType: "user", subjectId: USER_A, name: "scoped", scopes: [alpha.id] });
    const t3 = await issue({ orgId: ORG_A, subjectType: "user", subjectId: USER_A, name: "revoked" });
    const t4 = await issue({ orgId: ORG_A, subjectType: "user", subjectId: USER_A, name: "expired", expiresAt: new Date(Date.now() - 60_000) });
    const t5 = await issue({ orgId: ORG_B, subjectType: "user", subjectId: USER_B, name: "b" });
    for (const t of [t1, t2, t3, t4, t5]) if (!t.ok) throw new Error("issue");
    tokenA = t1.ok ? t1.value.plaintext : "";
    tokenAScoped = t2.ok ? t2.value.plaintext : "";
    tokenARevoked = t3.ok ? t3.value.plaintext : "";
    tokenAExpired = t4.ok ? t4.value.plaintext : "";
    tokenB = t5.ok ? t5.value.plaintext : "";
    if (t3.ok) {
      const r = await revokeToken(deps)({ orgId: ORG_A, tokenId: t3.value.token.id });
      if (!r.ok) throw new Error("revoke");
    }

    const app = createProxyApp(buildDeps({ databaseUrl: DBURL!, gitRoot }));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      }) as unknown as Server;
    });
  }, 60_000);

  afterAll(async () => {
    server?.close();
    if (db) {
      for (const id of [ORG_A, ORG_B]) await db.delete(organization).where(eqId(organization.id, id));
      for (const id of [USER_A, USER_B]) await db.delete(user).where(eqId(user.id, id));
    }
    await rm(root, { recursive: true, force: true });
  });

  // --- Baseline: the legitimate grants work ---
  it("BASELINE: USER_A can read alpha (granted)", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, tokenA);
    expect(r.status).toBe(200);
    const body = (await r.json()) as TreeResp;
    expect(body.files).toContain("vision.md");
  });

  // --- The core promise: no horizontal escape to a non-granted folder ---
  it("DENY: USER_A cannot read beta (no grant) - same uniform 401, no existence leak", async () => {
    const r = await get(`/tree?repo=${brainAId}/beta.git`, tokenA);
    expect(r.status).toBe(401);
  });

  it("DENY: reading a non-granted folder looks identical to a folder that does not exist", async () => {
    const real = await get(`/tree?repo=${brainAId}/beta.git`, tokenA);
    const fake = await get(`/tree?repo=${brainAId}/doesnotexist.git`, tokenA);
    expect(real.status).toBe(fake.status); // both 401, attacker can't distinguish
  });

  // --- Cross-tenant: a valid token from another org cannot reach ORG_A ---
  it("DENY: a valid ORG_B token cannot read ORG_A's alpha (cross-org)", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, tokenB);
    expect(r.status).toBe(401);
  });

  it("DENY: ORG_B token cannot pull ORG_A's manifest content", async () => {
    const r = await get(`/manifest`, tokenB);
    expect(r.status).toBe(200);
    const m = (await r.json()) as ManifestResp;
    // manifest is org-scoped to the token's org (B), so ORG_A's brain (and its
    // repos, keyed by ORG_A's brain id) never appear.
    const repos = m.entries.map((e) => e.repoName);
    expect(repos.every((rn) => !rn.startsWith(`${brainAId}/`))).toBe(true);
  });

  // --- Path traversal on the /read content endpoint ---
  it("DENY: path traversal via /read path param (..) is rejected", async () => {
    const r = await get(
      `/read?repo=${brainAId}/alpha.git&path=${encodeURIComponent("../beta.git/vision.md")}`,
      tokenA,
    );
    expect(r.status).toBe(404); // sanitized -> not found, never the other repo
  });

  it("DENY: absolute-path escape via /read (/etc/passwd) is neutralized", async () => {
    const r = await get(
      `/read?repo=${brainAId}/alpha.git&path=${encodeURIComponent("/etc/passwd")}`,
      tokenA,
    );
    expect(r.status).toBe(404);
  });

  it("DENY: traversal in the repo name itself is rejected before authz", async () => {
    const r = await get(
      `/tree?repo=${encodeURIComponent(`${brainAId}/../beta.git`)}`,
      tokenA,
    );
    expect(r.status).toBe(401);
  });

  // --- Vertical escalation: read grant must not allow a write (push) ---
  it("DENY: a read grant on alpha cannot push (receive-pack)", async () => {
    const r = await fetch(
      `${base()}/${brainAId}/alpha.git/info/refs?service=git-receive-pack`,
      { headers: { authorization: `Bearer ${tokenA}` } },
    );
    expect(r.status).toBe(401);
  });

  it("ALLOW: a write grant on gamma can push (receive-pack advertise)", async () => {
    const r = await fetch(
      `${base()}/${brainAId}/gamma.git/info/refs?service=git-receive-pack`,
      { headers: { authorization: `Bearer ${tokenA}` } },
    );
    expect(r.status).toBe(200);
  });

  // --- Token scoping: a scoped token narrows below the user's ACL ---
  it("DENY: a token scoped to alpha cannot reach gamma even though the user has write there", async () => {
    const r = await get(`/tree?repo=${brainAId}/gamma.git`, tokenAScoped);
    expect(r.status).toBe(401);
  });

  it("ALLOW: the same scoped token still reaches alpha", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, tokenAScoped);
    expect(r.status).toBe(200);
  });

  // --- Token lifecycle ---
  it("DENY: a revoked token is rejected", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, tokenARevoked);
    expect(r.status).toBe(401);
  });

  it("DENY: an expired token is rejected", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, tokenAExpired);
    expect(r.status).toBe(401);
  });

  it("DENY: no token at all is rejected", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, null);
    expect(r.status).toBe(401);
  });

  it("DENY: a garbage token is rejected", async () => {
    const r = await get(`/tree?repo=${brainAId}/alpha.git`, "mna_totally-made-up-token");
    expect(r.status).toBe(401);
  });

  // --- Denials must be a UNIFORM 401, never a 500 (a 500 leaks "org exists" vs
  //     "org does not" as an enumeration oracle, and is a non-clean denial). ---
  it("NO 500 ORACLE: unauthenticated info/refs to a NON-existent org denies cleanly (401, not 500)", async () => {
    const r = await fetch(
      `${base()}/brain_does_not_exist/r.git/info/refs?service=git-upload-pack`,
      {},
    );
    expect(r.status).toBe(401);
  });

  it("NO 500 ORACLE: unauthenticated /read to a non-existent org denies cleanly (401, not 500)", async () => {
    const r = await get(`/read?repo=brain_does_not_exist/r.git&path=x`, null);
    expect(r.status).toBe(401);
  });

  it("NO 500 ORACLE: a real-but-denied org and a bogus org return the SAME status (no oracle)", async () => {
    const bogus = await fetch(
      `${base()}/brain_does_not_exist/r.git/info/refs?service=git-upload-pack`,
      {},
    );
    const real = await fetch(
      `${base()}/${brainAId}/beta.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${tokenA}` } },
    );
    expect(bogus.status).toBe(real.status); // both 401, indistinguishable
  });

  // --- /search must only ever cross folders the caller may read ---
  it("SCOPE: /search only returns hits from granted folders, never beta", async () => {
    const r = await get(`/search?q=${encodeURIComponent("SECRET")}`, tokenA);
    expect(r.status).toBe(200);
    const body = (await r.json()) as SearchResp;
    const mounts = body.results.map((x) => x.mountPath);
    expect(mounts).toContain("acme/alpha"); // granted
    expect(mounts).not.toContain("acme/beta"); // not granted
  });

  it("SCOPE: manifest for USER_A lists alpha+gamma but never beta", async () => {
    const r = await get(`/manifest`, tokenA);
    const m = (await r.json()) as ManifestResp;
    const ids = m.entries.map((e) => e.folderId);
    expect(ids).toContain(alphaId);
    expect(ids).toContain(gammaId);
    expect(m.entries.some((e) => e.mountPath === "acme/beta")).toBe(false);
  });

  // --- The bug this fix closes: token scope must also constrain the READ APIs
  //     (/manifest, /search), not only the git clone/push path. A scoped agent
  //     token (Phase 5) could otherwise exfiltrate the whole org brain. ---
  it("SCOPE: a token scoped to alpha lists ONLY alpha in its manifest, never gamma", async () => {
    const r = await get(`/manifest`, tokenAScoped);
    expect(r.status).toBe(200);
    const m = (await r.json()) as ManifestResp;
    const ids = m.entries.map((e) => e.folderId);
    expect(ids).toContain(alphaId);
    expect(ids).not.toContain(gammaId);
  });

  it("SCOPE: a token scoped to alpha cannot exfiltrate gamma content via /search", async () => {
    const r = await get(`/search?q=${encodeURIComponent("SECRET")}`, tokenAScoped);
    expect(r.status).toBe(200);
    const body = (await r.json()) as SearchResp;
    const mounts = body.results.map((x) => x.mountPath);
    expect(mounts).toContain("acme/alpha"); // in scope
    expect(mounts).not.toContain("acme/gamma"); // out of scope, though the user CAN read it
  });

  // --- Folder lifecycle (archive/restore/create) requires ADMIN on the target.
  //     USER_A holds only read on alpha and write on gamma, and no admin
  //     anywhere, so every lifecycle route must deny. A read/write grant must
  //     never escalate to the destructive "delete the repo" capability. ---
  it("DENY: a read grant on alpha cannot archive it (needs admin)", async () => {
    const r = await post(`/folders/${alphaId}/archive`, tokenA);
    expect(r.status).toBe(401);
  });

  it("DENY: a write grant on gamma cannot archive it (write != admin)", async () => {
    const r = await post(`/folders/${gammaId}/archive`, tokenA);
    expect(r.status).toBe(401);
  });

  it("DENY: a cross-org token cannot archive ORG_A's alpha", async () => {
    const r = await post(`/folders/${alphaId}/archive`, tokenB);
    expect(r.status).toBe(401);
  });

  it("DENY: without admin on the brain root, a folder cannot be added", async () => {
    const r = await post(`/brains/${brainAId}/folders`, tokenA, {
      slug: "sneaky",
      name: "Sneaky",
      path: "sneaky",
    });
    expect(r.status).toBe(401);
  });

  it("DENY: restoring a folder the caller cannot administer is denied (no trash leak)", async () => {
    const r = await post(`/folders/${alphaId}/restore`, tokenA);
    expect(r.status).toBe(401);
  });

  it("SCOPE: the trash (/folders/archived) never lists folders USER_A cannot administer", async () => {
    const r = await get(`/folders/archived`, tokenA);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { folders: { folderId: string }[] };
    // USER_A administers nothing here, so the trash is empty for them.
    expect(body.folders).toHaveLength(0);
  });
});
