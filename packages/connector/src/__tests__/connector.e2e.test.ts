import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { desc, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import {
  ensureBrain,
  importFolderUseCase,
  systemClock,
  uuidIdGenerator,
} from "@monora/core";
import {
  createDb,
  makeDeviceFlows,
  makeUnitOfWork,
  ScryptTokenHasher,
  accessTokens,
  auditLog,
  folderAccess,
} from "@monora/db";
import { organization, user, member } from "@monora/db/auth-schema";
import { GitShellBackend } from "@monora/git";
import { createProxyApp, buildDeps } from "@monora/git-proxy";
import { createMonoraMcpClient } from "@monora-ai/mcp";
import { sync } from "../sync";
import { newBrain } from "../new-brain";
import { save } from "../save";
import { add } from "../add";
import { restore } from "../restore";

const DBURL = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
const ORG = "org_connector_e2e";
const USER = "user_connector_e2e";
const suite = DBURL ? describe : describe.skip;
const productLoopSteps: { step: string; ms: number }[] = [];

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function toolText(result: { content: { type: "text"; text: string }[] }) {
  return result.content.map((c) => c.text).join("\n");
}

suite("connector E2E (composes only authorized folders)", () => {
  let root: string;
  let server: Server;
  let baseUrl = "";
  let token = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  async function measure<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      productLoopSteps.push({
        step,
        ms: Math.round(performance.now() - start),
      });
    }
  }

  async function completeBrowserApprovedDeviceLogin(): Promise<string> {
    const post = (p: string, body?: unknown) =>
      fetch(`${baseUrl}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const code = (await (
      await measure("proxy.device_code", () => post("/device/code"))
    ).json()) as { deviceCode: string; userCode: string };
    expect(code.deviceCode).toBeTruthy();
    expect(code.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const flows = makeDeviceFlows(db);
    const flow = await flows.findActiveByUserCode(code.userCode, new Date());
    expect(flow).toBeTruthy();
    await measure("browser.device_approve", async () => {
      const approved = await flows.approve(flow!.id, {
        userId: USER,
        orgId: ORG,
        at: new Date(),
      });
      expect(approved).toBe(true);
    });

    const done = (await (
      await measure("proxy.device_token", () =>
        post("/device/token", { deviceCode: code.deviceCode }),
      )
    ).json()) as { status: string; token?: string };
    expect(done.status).toBe("complete");
    expect(done.token).toMatch(/^mna_/);
    return done.token!;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-conn-e2e-"));
    const gitRoot = path.join(root, "git");
    const src = path.join(root, "src");
    await mkdir(gitRoot, { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "vision.md"), "# authorized content\n");

    db = createDb(DBURL!);
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({ id: ORG, name: "Conn E2E", slug: ORG });
    await db.insert(user).values({ id: USER, name: "E2E", email: `${USER}@example.com` });
    // A user-scoped token reaches a brain only in an org the user belongs to.
    await db.insert(member).values({ id: `${USER}_${ORG}`, organizationId: ORG, userId: USER });

    const deps = {
      uow: makeUnitOfWork(db),
      git: new GitShellBackend({ gitRoot }),
      hasher: new ScryptTokenHasher(),
      ids: uuidIdGenerator,
      clock: systemClock,
    };
    const sp = await ensureBrain(deps)({ orgId: ORG, name: "Acme" });
    if (!sp.ok) throw new Error("brain");
    const importFolder = importFolderUseCase(deps);
    const alpha = await importFolder({
      orgId: ORG, brainId: sp.value.id,
      name: "Alpha", slug: "alpha", path: "alpha", sourceDir: src,
    });
    const beta = await importFolder({
      orgId: ORG, brainId: sp.value.id,
      name: "Beta", slug: "beta", path: "beta", sourceDir: src,
    });
    if (!alpha.ok || !beta.ok) throw new Error("import");

    // Grant USER read on ALPHA only.
    await db.insert(folderAccess).values({
      orgId: ORG, folderId: alpha.value.folder.id, userId: USER, permission: "read",
    });
    const app = createProxyApp(buildDeps({ databaseUrl: DBURL!, gitRoot }));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      }) as unknown as Server;
    });

    token = await completeBrowserApprovedDeviceLogin();
  }, 60_000);

  afterAll(async () => {
    server?.close();
    if (db) {
      await db.delete(organization).where(eq(organization.id, ORG));
      await db.delete(user).where(eq(user.id, USER));
    }
    await rm(root, { recursive: true, force: true });
  });

  it("proves the measurable browser -> proxy -> connector -> AI loop", async () => {
    const ws = path.join(root, "workspace");
    const res = await measure("connector.sync", () =>
      sync({ baseUrl, token, workspace: ws }),
    );

    expect(res.errors).toHaveLength(0);
    expect(res.mounted.map((m) => m.mountPath)).toEqual(["acme/alpha"]);
    expect(res.metrics).toMatchObject({
      manifestEntries: 1,
      mounted: 1,
      removed: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(res.metrics.durationMs).toBeGreaterThanOrEqual(0);

    // alpha is present with real content; beta (no grant) is absent. Each brain
    // is namespaced under its slug, so folders live at `<brainSlug>/<path>`.
    expect(
      await readFile(path.join(ws, "acme", "alpha", "vision.md"), "utf8"),
    ).toContain("authorized content");
    expect(await exists(path.join(ws, "acme", "beta"))).toBe(false);

    // Orientation files written.
    expect(await exists(path.join(ws, ".monora", "manifest.json"))).toBe(true);
    expect(await readFile(path.join(ws, "CLAUDE.md"), "utf8")).toContain("alpha");

    // The read-only MCP server is wired for free, with no token in the file.
    const mcp = JSON.parse(await readFile(path.join(ws, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.monora.args).toEqual(["-y", "@monora-ai/mcp"]);
    expect(JSON.stringify(mcp)).not.toContain(token);

    const ai = createMonoraMcpClient({ urlBase: baseUrl, token });
    const folders = toolText(
      await measure("ai.list_folders", () => ai.listFolders()),
    );
    expect(folders).toContain("acme/alpha/");
    expect(folders).not.toContain("acme/beta/");

    const files = toolText(
      await measure("ai.list_files", () => ai.listFiles("acme/alpha")),
    );
    expect(files).toContain("acme/alpha/vision.md");

    const read = toolText(
      await measure("ai.read_file", () => ai.readFile("acme/alpha/vision.md")),
    );
    expect(read).toContain("authorized content");
    const denied = toolText(await ai.readFile("acme/beta/vision.md"));
    expect(denied).toContain("No authorized folder");

    const search = toolText(
      await measure("ai.search", () => ai.search("authorized")),
    );
    expect(search).toContain("acme/alpha");
    expect(search).not.toContain("acme/beta");

    const actions = await db
      .select({
        action: auditLog.action,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.orgId, ORG))
      .orderBy(desc(auditLog.createdAt));
    expect(actions.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        "token.issue",
        "manifest.read",
        "git.fetch",
        "mcp.tree",
        "mcp.read",
        "mcp.search",
      ]),
    );
    expect(
      actions.some(
        (r: { action: string; metadata: Record<string, unknown> | null }) =>
          r.action === "manifest.read" &&
          r.metadata?.entryCount === 1,
      ),
    ).toBe(true);

    const tokenRows = await db
      .select({ lastUsedAt: accessTokens.lastUsedAt })
      .from(accessTokens)
      .where(eq(accessTokens.subjectId, USER));
    expect(tokenRows.some((r: { lastUsedAt: Date | null }) => r.lastUsedAt)).toBe(
      true,
    );

    expect(productLoopSteps.map((s) => s.step)).toEqual(
      expect.arrayContaining([
        "proxy.device_code",
        "browser.device_approve",
        "proxy.device_token",
        "connector.sync",
        "ai.list_folders",
        "ai.list_files",
        "ai.read_file",
        "ai.search",
      ]),
    );
    expect(productLoopSteps.every((s) => s.ms >= 0)).toBe(true);
  }, 30_000);

  it("is idempotent (second sync fast-forwards)", async () => {
    const ws = path.join(root, "workspace");
    const res = await sync({ baseUrl, token, workspace: ws });
    expect(res.errors).toHaveLength(0);
    expect(res.mounted).toEqual([{ mountPath: "acme/alpha", action: "pulled" }]);
  }, 30_000);

  // new-brain: create a brain from a local folder client-side (empty repos on
  // the server, content pushed by the connector), then prove the push reached
  // the bare repos by syncing into a SEPARATE clean workspace and reading it.
  it("new-brain creates a brain from a folder and round-trips content", async () => {
    const from = path.join(root, "newsrc");
    await mkdir(path.join(from, "product-development"), { recursive: true });
    await mkdir(path.join(from, "sales-development"), { recursive: true });
    await writeFile(path.join(from, "product-development", "vision.md"), "# the thesis\n");
    await writeFile(path.join(from, "sales-development", "icp.md"), "# who\n");
    await writeFile(path.join(from, "README.md"), "loose root file\n");

    const ws = path.join(root, "nb-workspace");
    const res = await newBrain({ baseUrl, token, name: "Monora", from, workspace: ws });

    expect(res.brainSlug).toBe("monora");
    expect(res.pushed.map((p) => p.mountPath).sort()).toEqual([
      "monora/product-development",
      "monora/sales-development",
    ]);
    expect(res.skippedRootFiles).toEqual(["README.md"]);

    // The content reached the server: a fresh sync into a clean workspace pulls
    // the new brain's folders (USER was granted admin on creation).
    const verifyWs = path.join(root, "nb-verify");
    const sres = await sync({ baseUrl, token, workspace: verifyWs });
    expect(sres.errors).toHaveLength(0);
    expect(sres.mounted.map((m) => m.mountPath)).toEqual(
      expect.arrayContaining([
        "monora/product-development",
        "monora/sales-development",
      ]),
    );
    expect(
      await readFile(
        path.join(verifyWs, "monora", "product-development", "vision.md"),
        "utf8",
      ),
    ).toContain("the thesis");
  }, 60_000);

  // The write path, end-to-end against the real proxy: edit -> save commits and
  // pushes through authenticated smart-HTTP -> a SECOND workspace pulls it.
  it("save pushes edits (M) that a second workspace then pulls", async () => {
    const ws = path.join(root, "nb-verify"); // synced by the new-brain test
    const pd = path.join(ws, "monora", "product-development");
    await writeFile(path.join(pd, "vision.md"), "# the thesis\n\nrefined by save\n");
    await writeFile(path.join(pd, "decisions.md"), "# decided over save\n");

    const res = await measure("connector.save", () =>
      save({ workspace: ws, baseUrl, token, message: "e2e write path" }),
    );
    expect(res.errors).toHaveLength(0);
    expect(res.conflicts).toHaveLength(0);
    expect(res.saved).toEqual(
      expect.arrayContaining([
        { mountPath: "monora/product-development", action: "saved" },
      ]),
    );

    const otherWs = path.join(root, "save-verify");
    const sres = await sync({ baseUrl, token, workspace: otherWs });
    expect(sres.errors).toHaveLength(0);
    expect(
      await readFile(path.join(otherWs, "monora", "product-development", "vision.md"), "utf8"),
    ).toContain("refined by save");
    expect(
      await readFile(path.join(otherWs, "monora", "product-development", "decisions.md"), "utf8"),
    ).toContain("decided over save");
  }, 60_000);

  it("a read-only folder rejects the push server-side; the work stays local and is REPORTED as read-only, not as an error", async () => {
    const ws = path.join(root, "workspace"); // alpha mounted with a READ grant
    const alpha = path.join(ws, "acme", "alpha");
    await writeFile(path.join(alpha, "vision.md"), "# authorized content\n\nsneaky edit\n");

    const res = await save({ workspace: ws, baseUrl, token, message: "should be rejected" });

    // The denial is its own outcome (a friendly "read-only" report), never a
    // raw git error dump - and never a credential prompt: the proxy answers
    // the push with 403, which git treats as final.
    expect(res.readOnly).toEqual(
      expect.arrayContaining([{ mountPath: "acme/alpha" }]),
    );
    expect(res.errors.find((e) => e.mountPath === "acme/alpha")).toBeUndefined();
    // The edit is committed locally (nothing lost)...
    expect(await readFile(path.join(alpha, "vision.md"), "utf8")).toContain("sneaky edit");
    // ...but the SERVER copy is untouched: the MCP read comes from the bare repo.
    const ai = createMonoraMcpClient({ urlBase: baseUrl, token });
    const remote = toolText(await ai.readFile("acme/alpha/vision.md"));
    expect(remote).not.toContain("sneaky edit");
  }, 60_000);

  // The folder lifecycle, end-to-end: stage a create (A), save applies it; the
  // folder vanishes from disk (D), save archives it; restore brings it back
  // from the trash WITH its history.
  it("add -> save (A), delete -> save (D), restore: the full lifecycle round-trips", async () => {
    const ws = path.join(root, "nb-verify");
    const research = path.join(ws, "monora", "research");
    await mkdir(research, { recursive: true });
    await writeFile(path.join(research, "notes.md"), "# research notes\n");

    // A: stage + apply against the real create route.
    const staged = await add({ workspace: ws, dir: research });
    expect(staged.mountPath).toBe("monora/research");
    const pendingRaw = JSON.parse(
      await readFile(path.join(ws, ".monora", "pending.json"), "utf8"),
    );
    expect(pendingRaw.creates).toHaveLength(1);
    const created = await measure("connector.save_create", () =>
      save({ workspace: ws, baseUrl, token, message: "create research" }),
    );
    expect(created.errors).toHaveLength(0);
    expect(created.created).toEqual([{ mountPath: "monora/research" }]);

    // The new folder reaches another workspace with its content.
    const otherWs = path.join(root, "save-verify");
    const s1 = await sync({ baseUrl, token, workspace: otherWs });
    expect(s1.errors).toHaveLength(0);
    expect(s1.mounted.map((m) => m.mountPath)).toContain("monora/research");
    expect(
      await readFile(path.join(otherWs, "monora", "research", "notes.md"), "utf8"),
    ).toContain("research notes");

    // The local index learns about the new folder (any later sync does this);
    // the D pass only archives folders the local index says were mounted here.
    const sIdx = await sync({ baseUrl, token, workspace: ws });
    expect(sIdx.errors).toHaveLength(0);

    // D: the folder vanishes from disk; save archives it (soft, recoverable).
    await rm(research, { recursive: true, force: true });
    const archived = await measure("connector.save_archive", () =>
      save({ workspace: ws, baseUrl, token, message: "drop research" }),
    );
    expect(archived.errors).toHaveLength(0);
    expect(archived.archived).toEqual([{ mountPath: "monora/research" }]);

    // The other workspace prunes it on the next sync (clean checkout only).
    const s2 = await sync({ baseUrl, token, workspace: otherWs });
    expect(s2.removed).toContain("monora/research");

    // Restore: the trash lists it; restoring + syncing brings it back with
    // full history (the bare repo was never deleted).
    const r = await restore({ baseUrl, token, target: "research" });
    expect(r.restored?.repoName).toMatch(/research/);
    const s3 = await sync({ baseUrl, token, workspace: otherWs });
    expect(s3.errors).toHaveLength(0);
    expect(
      await readFile(path.join(otherWs, "monora", "research", "notes.md"), "utf8"),
    ).toContain("research notes");
  }, 60_000);
});
