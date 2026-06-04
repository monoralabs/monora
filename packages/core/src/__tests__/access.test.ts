import { describe, it, expect } from "vitest";
import { issueToken } from "../application/access/issue-token";
import { revokeToken } from "../application/access/revoke-token";
import {
  authorizeGitRequest,
  type GitOp,
} from "../application/access/authorize-git-request";
import type { Permission } from "../domain/access/permission";
import { InMemoryStore, FakeHasher, fakeAuthz, fixedClock, seqIds } from "./fakes";

const ORG = "org1";
const USER = "user1";
const BRAIN = "space1";
const REPO = "space1/sales.git";
const FOLDER_ID = "folder-sales";

/** Wire a store with one folder + a grant, issue a token for USER, and return
 *  the authorize() runner plus the plaintext token. */
async function setup(opts: {
  grant?: Permission;
  expiresAt?: Date | null;
  tokenOrg?: string;
}) {
  const store = new InMemoryStore();
  const hasher = new FakeHasher();
  const clock = fixedClock();

  // Seed the folder the repo resolves to.
  store.folders.set(FOLDER_ID, {
    id: FOLDER_ID,
    orgId: ORG,
    brainId: "space1",
    parentFolderId: null,
    name: "Sales",
    slug: "sales" as never,
    path: "sales" as never,
    repoName: REPO as never,
    defaultBranch: "main",
    createdAt: clock.now(),
  });

  const issued = await issueToken({
    uow: store.unitOfWork(),
    hasher,
    ids: seqIds("tok"),
    clock,
  })({
    orgId: opts.tokenOrg ?? ORG,
    subjectType: "user",
    subjectId: USER,
    name: "laptop",
    expiresAt: opts.expiresAt ?? null,
  });
  if (!issued.ok) throw new Error("issue failed");

  const grants = new Map<string, Permission>();
  if (opts.grant) grants.set(`${USER}:${FOLDER_ID}`, opts.grant);

  const run = authorizeGitRequest({
    tokens: store.tokenLookup(),
    uow: store.unitOfWork(),
    authz: fakeAuthz(grants),
    hasher,
    clock,
    // The brain "space1" is owned by ORG; the tenant is resolved from the brain
    // id in the repo name, not trusted from the URL.
    resolveBrainOrgs: async (brainId) => (brainId === BRAIN ? [ORG] : []),
  });

  return { store, run, token: issued.value.plaintext };
}

const REQ = (token: string | null, op: GitOp = "upload-pack") => ({
  rawToken: token,
  repoName: REPO,
  op,
});

describe("issueToken", () => {
  it("returns the plaintext once and stores only a hash + prefix", async () => {
    const { store, token } = await setup({ grant: "read" });
    expect(token).toMatch(/^tok_/);
    const [stored] = [...store.tokens.values()];
    expect(stored!.hashedSecret).toContain("h:");
    expect(stored!.hashedSecret).not.toBe(token);
    expect(stored!.tokenPrefix).toBe(token.slice(0, 8));
  });
});

describe("authorizeGitRequest truth table", () => {
  it("read grant -> fetch allowed", async () => {
    const { run, token } = await setup({ grant: "read" });
    const r = await run(REQ(token, "upload-pack"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.folderId).toBe(FOLDER_ID);
  });

  it("read grant -> push DENIED", async () => {
    const { run, token } = await setup({ grant: "read" });
    const r = await run(REQ(token, "receive-pack"));
    expect(r.ok).toBe(false);
  });

  it("write grant -> push allowed", async () => {
    const { run, token } = await setup({ grant: "write" });
    const r = await run(REQ(token, "receive-pack"));
    expect(r.ok).toBe(true);
  });

  it("no grant -> denied (uniform)", async () => {
    const { run, token } = await setup({});
    const r = await run(REQ(token));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("access denied");
  });

  it("no token -> denied", async () => {
    const { run } = await setup({ grant: "read" });
    const r = await run(REQ(null));
    expect(r.ok).toBe(false);
  });

  it("garbage token -> denied", async () => {
    const { run } = await setup({ grant: "read" });
    const r = await run(REQ("tok_nope_xxx"));
    expect(r.ok).toBe(false);
  });

  it("expired token -> denied", async () => {
    const { run, token } = await setup({
      grant: "read",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const r = await run(REQ(token));
    expect(r.ok).toBe(false);
  });

  it("token from another org -> denied (no cross-org)", async () => {
    const { run, token } = await setup({ grant: "read", tokenOrg: "other-org" });
    const r = await run(REQ(token));
    expect(r.ok).toBe(false);
  });

  it("unknown repo -> denied without leak", async () => {
    const { run, token } = await setup({ grant: "read" });
    const r = await run({
      rawToken: token,
      repoName: "space1/ghost.git",
      op: "upload-pack",
    });
    expect(r.ok).toBe(false);
  });

  it("malformed repo path -> denied", async () => {
    const { run, token } = await setup({ grant: "read" });
    const r = await run({ rawToken: token, repoName: "../etc/passwd", op: "upload-pack" });
    expect(r.ok).toBe(false);
  });

  it("audits git.fetch on allow and git.denied on deny", async () => {
    const { store, run, token } = await setup({ grant: "read" });
    await run(REQ(token, "upload-pack"));
    await run(REQ(null));
    const actions = store.audit.map((a) => a.action);
    expect(actions).toContain("git.fetch");
    expect(actions).toContain("git.denied");
  });

  it("a revoked token is denied", async () => {
    const { store, run, token } = await setup({ grant: "read" });
    const before = await run(REQ(token));
    expect(before.ok).toBe(true);

    const [stored] = [...store.tokens.values()];
    const revoked = await revokeToken({
      uow: store.unitOfWork(),
      clock: fixedClock(),
    })({ orgId: ORG, tokenId: stored!.id });
    expect(revoked.ok).toBe(true);

    const after = await run(REQ(token));
    expect(after.ok).toBe(false);
  });
});
