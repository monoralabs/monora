import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import {
  ensureBrain,
  importFolderUseCase,
  issueToken,
  systemClock,
  uuidIdGenerator,
} from "@monora/core";
import {
  createDb,
  makeUnitOfWork,
  makeDeviceFlows,
  ScryptTokenHasher,
  folderAccess,
} from "@monora/db";
import { organization, user } from "@monora/db/auth-schema";
import { GitShellBackend } from "@monora/git";
import { createProxyApp } from "../app";
import { buildDeps } from "../deps";

const exec = promisify(execFile);
const DBURL = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;

const ORG = "org_proxy_e2e";
const USER = "user_proxy_e2e";

// Integration test - needs the live Postgres + git. Skips cleanly without a DB.
const suite = DBURL ? describe : describe.skip;

suite("git-proxy E2E (authz enforced on real git clone)", () => {
  let root: string;
  let gitRoot: string;
  let server: Server;
  let port = 0;
  let token = "";
  let brainId = ""; // repo names are <brainId>/<folder>.git (org-independent)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-proxy-e2e-"));
    gitRoot = path.join(root, "git");
    const src = path.join(root, "src");
    await mkdir(gitRoot, { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "vision.md"), "# secret org brain\n");

    db = createDb(DBURL!);
    // Clean any leftover, then seed org + user (auth tables, no RLS).
    await db.delete(organization).where(eqId(organization.id, ORG));
    await db.delete(user).where(eqId(user.id, USER));
    await db.insert(organization).values({ id: ORG, name: "Proxy E2E", slug: ORG });
    await db.insert(user).values({ id: USER, name: "E2E", email: `${USER}@example.com` });

    const deps = {
      uow: makeUnitOfWork(db),
      git: new GitShellBackend({ gitRoot }),
      hasher: new ScryptTokenHasher(),
      ids: uuidIdGenerator,
      clock: systemClock,
    };
    const sp = await ensureBrain(deps)({ orgId: ORG, name: "Acme" });
    if (!sp.ok) throw new Error("brain");
    brainId = sp.value.id;
    const importFolder = importFolderUseCase(deps);
    const alpha = await importFolder({
      orgId: ORG,
      brainId: sp.value.id,
      name: "Alpha",
      slug: "alpha",
      path: "alpha",
      sourceDir: src,
    });
    const beta = await importFolder({
      orgId: ORG,
      brainId: sp.value.id,
      name: "Beta",
      slug: "beta",
      path: "beta",
      sourceDir: src,
    });
    if (!alpha.ok || !beta.ok) throw new Error("import");

    // Grant USER read on ALPHA only. BETA has no grant.
    await db.insert(folderAccess).values({
      orgId: ORG,
      folderId: alpha.value.folder.id,
      userId: USER,
      permission: "read",
    });

    const issued = await issueToken(deps)({
      orgId: ORG,
      subjectType: "user",
      subjectId: USER,
      name: "e2e",
    });
    if (!issued.ok) throw new Error("token");
    token = issued.value.plaintext;

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
    if (db) await db.delete(organization).where(eqId(organization.id, ORG));
    if (db) await db.delete(user).where(eqId(user.id, USER));
    await rm(root, { recursive: true, force: true });
  });

  const clone = (repo: string, withToken: boolean, dest: string) => {
    const auth = withToken ? `monora:${token}@` : "";
    const url = `http://${auth}127.0.0.1:${port}/${brainId}/${repo}`;
    return exec("git", ["clone", url, dest], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  };

  it("clones a granted folder with the token and gets the content", async () => {
    const dest = path.join(root, "clone-alpha");
    await clone("alpha.git", true, dest);
    expect(await readFile(path.join(dest, "vision.md"), "utf8")).toContain(
      "secret org brain",
    );
  }, 30_000);

  it("DENIES a folder the token has no grant on (no existence leak)", async () => {
    await expect(clone("beta.git", true, path.join(root, "clone-beta"))).rejects.toThrow();
  }, 30_000);

  it("DENIES without a token", async () => {
    await expect(
      clone("alpha.git", false, path.join(root, "clone-noauth")),
    ).rejects.toThrow();
  }, 30_000);

  // Device Authorization Grant: code -> approve (as the app would) -> the CLI's
  // poll mints a real, working token. No token ever crosses the command line.
  it("device flow: approve mints a usable token, single-claim only", async () => {
    const base = `http://127.0.0.1:${port}`;
    const post = (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

    // 1. CLI requests a flow.
    const code = (await (await post("/device/code")).json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
    };
    expect(code.deviceCode).toBeTruthy();
    expect(code.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code.verificationUri).toContain("/connect/device");

    // 2. Before approval, polling is pending.
    const pending = (await (
      await post("/device/token", { deviceCode: code.deviceCode })
    ).json()) as { status: string };
    expect(pending.status).toBe("authorization_pending");

    // 3. The browser approval (what device.approve does server-side): bind the
    //    flow to the signed-in user + org.
    const flows = makeDeviceFlows(db);
    const flow = await flows.findActiveByUserCode(code.userCode, new Date());
    expect(flow).toBeTruthy();
    expect(await flows.approve(flow!.id, { userId: USER, orgId: ORG, at: new Date() })).toBe(true);

    // 4. The CLI's next poll gets a freshly minted token.
    const done = (await (
      await post("/device/token", { deviceCode: code.deviceCode })
    ).json()) as { status: string; token?: string };
    expect(done.status).toBe("complete");
    expect(done.token).toMatch(/^mna_/);

    // 5. That token actually works (scoped to the approver): /manifest returns
    //    the granted folder.
    const man = await fetch(`${base}/manifest`, {
      headers: { authorization: `Bearer ${done.token}` },
    });
    expect(man.status).toBe(200);
    const manifest = (await man.json()) as { entries: { mountPath: string }[] };
    expect(manifest.entries.some((e) => e.mountPath.includes("alpha"))).toBe(true);

    // 6. The code is single-use: a replayed poll is rejected as expired.
    const replay = (await (
      await post("/device/token", { deviceCode: code.deviceCode })
    ).json()) as { status: string };
    expect(replay.status).toBe("expired");
  }, 30_000);
});

function eqId<T>(col: T, val: string) {
  return eq(col as never, val);
}
