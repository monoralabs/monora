import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import {
  authorizeGitRequest,
  authenticateToken,
  generateManifest,
  ensureBrain,
  ensureBrainRootFolder,
  createFolderUseCase,
  archiveFolderUseCase,
  restoreFolderUseCase,
  listArchivedFolders,
  grantAccess,
  issueToken,
  type GitOp,
  type GitBackend,
} from "@monora/core";
import { GitHttp, type GitService } from "@monora/git";
import type { RepoName } from "@monora/core";
import type { DeviceFlows } from "@monora/db";

export interface ProxyDeps {
  authorize: ReturnType<typeof authorizeGitRequest>;
  authenticate: ReturnType<typeof authenticateToken>;
  manifest: ReturnType<typeof generateManifest>;
  ensureBrain: ReturnType<typeof ensureBrain>;
  ensureBrainRootFolder: ReturnType<typeof ensureBrainRootFolder>;
  createFolder: ReturnType<typeof createFolderUseCase>;
  archiveFolder: ReturnType<typeof archiveFolderUseCase>;
  restoreFolder: ReturnType<typeof restoreFolderUseCase>;
  listArchivedFolders: ReturnType<typeof listArchivedFolders>;
  grant: ReturnType<typeof grantAccess>;
  issueToken: ReturnType<typeof issueToken>;
  deviceFlows: DeviceFlows;
  /** Public origin of the app (where users approve), e.g. https://app.monora.ai */
  appUrl: string;
  git: GitHttp;
  read: GitBackend;
  /** When set, the canonical public origin for clone URLs. Pins the origin so
   *  client X-Forwarded-* / Host headers are NOT trusted (a forged Host would
   *  make /manifest hand out attacker clone URLs, leaking the bearer token). Set
   *  in prod behind the reverse proxy; unset in dev falls back to request headers. */
  gitPublicOrigin?: string;
}

/** Device flow tuning. Short-lived; the CLI polls every `interval` seconds. */
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_INTERVAL_SEC = 5;

/** Hard ceilings against unbounded buffering and gzip bombs on the git RPC
 *  path (the handler buffers the whole body, then gunzips it). Knowledge-brain
 *  pushes are small; these are generous upper bounds, not tuning knobs. */
const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/** A short, human-typable code from an unambiguous alphabet (no O/0/I/1/L),
 *  formatted XXXX-XXXX. The secret is the device_code, not this. */
function generateUserCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chars = Array.from(
    randomBytes(8),
    (b) => alphabet[b % alphabet.length]!,
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Git sends the credential in the Basic-auth password (any username), or we
 *  accept a Bearer token. The token is the secret either way. */
function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim() || null;
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    return pass || user || null;
  }
  return null;
}

/** Uniform denial - triggers git's credential prompt and never leaks why. */
function deny(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Monora"' },
  });
}

function repoNameOf(c: Context): string {
  // Repo names are `<brainId>/<folderSlug>.git` - org-independent. The tenant is
  // resolved from the brain id inside authorizeGitRequest, never from the URL.
  return `${c.req.param("brain")}/${c.req.param("repo")}`;
}

interface CreateBrainBody {
  brain: string;
  folders: { slug: string; name: string; path?: string }[];
}

/** Validate the POST /brains payload. Slug/path correctness is re-checked by
 *  the domain (makeSlug / makeMountPath); this just guards the shape. */
function parseCreateBrainBody(body: unknown): CreateBrainBody | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be an object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.brain !== "string" || !b.brain.trim()) {
    return { error: "brain (name) is required" };
  }
  if (!Array.isArray(b.folders) || b.folders.length === 0) {
    return { error: "folders must be a non-empty array" };
  }
  const folders: CreateBrainBody["folders"] = [];
  for (const raw of b.folders) {
    if (typeof raw !== "object" || raw === null) {
      return { error: "each folder must be an object" };
    }
    const f = raw as Record<string, unknown>;
    if (typeof f.slug !== "string" || !f.slug.trim()) {
      return { error: "each folder needs a slug" };
    }
    if (typeof f.name !== "string" || !f.name.trim()) {
      return { error: `folder "${f.slug}" needs a name` };
    }
    folders.push({
      slug: f.slug.trim(),
      name: f.name.trim(),
      path: typeof f.path === "string" && f.path.trim() ? f.path.trim() : undefined,
    });
  }
  return { brain: b.brain.trim(), folders };
}

/**
 * The public origin clients reach us at, for building clone URLs. Behind a TLS
 * reverse proxy (Caddy) the internal hop is plain http, so `c.req.url` would
 * yield `http://...` and the connector's https clone would 301 - dropping the
 * auth header on the redirect. Honor X-Forwarded-Proto/Host (set by Caddy).
 */
function publicOrigin(c: Context, configured?: string): string {
  // A pinned origin wins: behind a proxy, X-Forwarded-* / Host are
  // attacker-settable, and a forged Host would make /manifest emit clone URLs
  // pointing at an attacker host (the connector would then send the bearer
  // token there). With GIT_PUBLIC_ORIGIN set we never trust client headers.
  if (configured) return configured.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ||
    u.protocol.replace(/:$/, "");
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host") ||
    u.host;
  return `${proto}://${host}`;
}

/**
 * The git smart-HTTP surface. EVERY route authorizes via authorizeGitRequest
 * BEFORE GitHttp serves a byte - there is no other path to the repos.
 */
export function createProxyApp(deps: ProxyDeps): Hono {
  const app = new Hono();

  // Cap the raw request body before any handler reads it (the git RPC path
  // buffers the whole body in memory).
  app.use(bodyLimit({ maxSize: MAX_REQUEST_BYTES }));

  // Opaque errors: a git subprocess rejection embeds the on-disk repo path in
  // stderr, and a stack trace leaks internal structure - neither reaches a
  // client. Log server-side, return a bare 500 (never the uniform-denial path).
  app.onError((err, c) => {
    console.error("[git-proxy] unhandled error:", err);
    return c.text("Internal Server Error", 500);
  });

  // The connector's source of truth: which folders this principal may compose,
  // with clone URLs pointing back at this proxy (same origin the client used).
  app.get("/manifest", async (c) => {
    const auth = await deps.authenticate(
      extractToken(c.req.header("authorization")),
    );
    if (!auth.ok) return deny();
    const res = await deps.manifest({
      subject: { userId: auth.value.userId, orgId: auth.value.orgId },
      scopes: auth.value.scopes,
      // A personal (user) token composes every org the user belongs to into one
      // tree; an agent/CI token stays bound to its single org.
      crossOrg: auth.value.subjectType === "user",
      baseUrl: publicOrigin(c, deps.gitPublicOrigin),
    });
    if (!res.ok) return deny();
    return Response.json(res.value);
  });

  // Create a brain + its (empty) folders from the client, then hand back the
  // clone URLs so the connector can push each folder's content. Org-scoped: the
  // token authenticates a user+org (same capability tier as the app's
  // `createBrain`, which any org member may call); the new folders are granted
  // `admin` to that user only, so the brain is invisible to everyone else until
  // shared. Repos are created empty here (proxy uid), so the client can push
  // straight away with no ownership fixup - unlike the on-box ingest.
  app.post("/brains", async (c) => {
    const auth = await deps.authenticate(
      extractToken(c.req.header("authorization")),
    );
    if (!auth.ok) return deny();
    const { userId, orgId } = auth.value;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = parseCreateBrainBody(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { brain: brainName, folders } = parsed;

    const brainRes = await deps.ensureBrain({
      orgId,
      name: brainName,
      ownerUserId: userId,
      actorId: userId,
    });
    if (!brainRes.ok) return c.json({ error: brainRes.error.message }, 400);
    const brain = brainRes.value;

    // Every brain gets a shared root folder (`_root`, mounted at the brain root)
    // so brain-wide files (CLAUDE.md, README, .claude/skills, ...) are tracked
    // and travel like any folder - the connector mounts it at `<brainSlug>`.
    const rootRes = await deps.ensureBrainRootFolder({
      orgId,
      brainId: brain.id,
      ownerUserId: userId,
      actorId: userId,
    });
    if (!rootRes.ok) return c.json({ error: rootRes.error.message }, 400);

    for (const f of folders) {
      const r = await deps.createFolder({
        orgId,
        brainId: brain.id,
        name: f.name,
        slug: f.slug,
        path: f.path,
        actorId: userId,
      });
      if (!r.ok) {
        return c.json(
          { error: `folder "${f.slug}": ${r.error.message}` },
          409,
        );
      }
      const g = await deps.grant({
        orgId,
        folderId: r.value.id,
        userId,
        permission: "admin",
        actorId: userId,
      });
      if (!g.ok) return c.json({ error: g.error.message }, 400);
    }

    // Reuse the manifest to return the new brain's folders with correct,
    // origin-aware clone URLs (authorization-filtered to this caller).
    const man = await deps.manifest({
      subject: { userId, orgId },
      scopes: auth.value.scopes,
      baseUrl: publicOrigin(c, deps.gitPublicOrigin),
    });
    if (!man.ok) return c.json({ error: "manifest failed" }, 500);
    const entries = man.value.entries.filter(
      (e) =>
        e.mountPath === brain.slug ||
        e.mountPath.startsWith(`${brain.slug}/`),
    );
    return c.json({ brainSlug: brain.slug, entries }, 201);
  });

  // --- Folder lifecycle (the connector's `monora save` reconcile: A and D) ---

  // The caller's authorized projection, used to gate the lifecycle routes. We
  // never trust a client-supplied folder/brain id: a target is actionable only
  // if it appears here with admin permission. Cross-org + scope + ACL are all
  // already baked into the manifest, so this is the one source of truth.
  async function adminManifest(c: Context) {
    const auth = await deps.authenticate(
      extractToken(c.req.header("authorization")),
    );
    if (!auth.ok) return null;
    const man = await deps.manifest({
      subject: { userId: auth.value.userId, orgId: auth.value.orgId },
      scopes: auth.value.scopes,
      crossOrg: auth.value.subjectType === "user",
      baseUrl: publicOrigin(c, deps.gitPublicOrigin),
    });
    if (!man.ok) return null;
    return { auth: auth.value, entries: man.value.entries };
  }

  // Add a folder to an existing brain (the "A" in the connector's reconcile).
  // Authorized iff the caller administers the brain - i.e. holds admin on its
  // `_root` folder, which is what makes the brain theirs. The new folder is
  // granted admin to that user only, mirroring POST /brains.
  app.post("/brains/:brainId/folders", async (c) => {
    const brainId = c.req.param("brainId");
    const ctx = await adminManifest(c);
    if (!ctx) return deny();
    const rootRepo = `${brainId}/_root.git`;
    const root = ctx.entries.find(
      (e) => e.repoName === rootRepo && e.permission === "admin",
    );
    if (!root) return deny();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const slug = typeof b.slug === "string" ? b.slug.trim() : "";
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!slug || !name) return c.json({ error: "slug and name are required" }, 400);
    const path = typeof b.path === "string" && b.path.trim() ? b.path.trim() : undefined;
    const parentFolderId =
      typeof b.parentFolderId === "string" ? b.parentFolderId : undefined;

    const r = await deps.createFolder({
      orgId: root.orgId,
      brainId,
      name,
      slug,
      path,
      parentFolderId,
      actorId: ctx.auth.userId,
    });
    if (!r.ok) return c.json({ error: r.error.message }, 409);
    const g = await deps.grant({
      orgId: root.orgId,
      folderId: r.value.id,
      userId: ctx.auth.userId,
      permission: "admin",
      actorId: ctx.auth.userId,
    });
    if (!g.ok) return c.json({ error: g.error.message }, 400);
    return c.json(
      {
        folderId: r.value.id,
        repoName: r.value.repoName,
        cloneUrl: `${publicOrigin(c, deps.gitPublicOrigin)}/${r.value.repoName}`,
      },
      201,
    );
  });

  // Archive a folder (the "D" in the reconcile): soft-delete to the trash. The
  // folder is live, so it must appear in the caller's manifest with admin.
  app.post("/folders/:folderId/archive", async (c) => {
    const folderId = c.req.param("folderId");
    const ctx = await adminManifest(c);
    if (!ctx) return deny();
    const entry = ctx.entries.find(
      (e) => e.folderId === folderId && e.permission === "admin",
    );
    if (!entry) return deny();
    const res = await deps.archiveFolder({
      orgId: entry.orgId,
      folderId,
      actorId: ctx.auth.userId,
    });
    if (!res.ok) return c.json({ error: res.error.message }, 400);
    return c.json(res.value);
  });

  // The trash: archived folders the caller can administer (hidden from the
  // manifest). Scoped to the token's bound org. Powers the connector's restore
  // lookup and the app's "Archived" view.
  app.get("/folders/archived", async (c) => {
    const auth = await deps.authenticate(
      extractToken(c.req.header("authorization")),
    );
    if (!auth.ok) return deny();
    const res = await deps.listArchivedFolders({
      subject: { userId: auth.value.userId, orgId: auth.value.orgId },
    });
    if (!res.ok) return deny();
    return Response.json({
      folders: res.value.map((f) => ({
        folderId: f.id,
        repoName: f.repoName,
        path: f.path,
        name: f.name,
        archivedAt: f.archivedAt,
      })),
    });
  });

  // Restore an archived folder from the trash. The target is hidden from the
  // manifest, so authorization comes from the admin-gated archived list: a
  // folder the caller can see there is one they can bring back.
  app.post("/folders/:folderId/restore", async (c) => {
    const folderId = c.req.param("folderId");
    const auth = await deps.authenticate(
      extractToken(c.req.header("authorization")),
    );
    if (!auth.ok) return deny();
    const subject = { userId: auth.value.userId, orgId: auth.value.orgId };
    const list = await deps.listArchivedFolders({ subject });
    if (!list.ok) return deny();
    if (!list.value.some((f) => f.id === folderId)) return deny();
    const res = await deps.restoreFolder({
      orgId: auth.value.orgId,
      folderId,
      actorId: auth.value.userId,
    });
    if (!res.ok) return c.json({ error: res.error.message }, 400);
    return c.json(res.value);
  });

  // --- Read API (used by the MCP server: no clone, by identity) ---

  // List file paths in a folder the caller can read.
  app.get("/tree", async (c) => {
    const repo = c.req.query("repo");
    if (!repo) return new Response("repo required", { status: 400 });
    const r = await deps.authorize({
      rawToken: extractToken(c.req.header("authorization")),
      repoName: repo,
      op: "upload-pack",
    });
    if (!r.ok) return deny();
    const files = await deps.read.listFiles(r.value.repoName);
    return Response.json({ repo, files });
  });

  // Read a file's content from a folder the caller can read.
  app.get("/read", async (c) => {
    const repo = c.req.query("repo");
    const path = c.req.query("path");
    if (!repo || !path)
      return new Response("repo and path required", { status: 400 });
    const r = await deps.authorize({
      rawToken: extractToken(c.req.header("authorization")),
      repoName: repo,
      op: "upload-pack",
    });
    if (!r.ok) return deny();
    try {
      const content = await deps.read.readFile(r.value.repoName, path);
      return Response.json({ repo, path, content });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  // Search across ALL folders the caller can read.
  app.get("/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return new Response("q required", { status: 400 });
    const auth = await deps.authenticate(
      extractToken(c.req.header("authorization")),
    );
    if (!auth.ok) return deny();
    const man = await deps.manifest({
      subject: { userId: auth.value.userId, orgId: auth.value.orgId },
      scopes: auth.value.scopes,
      baseUrl: publicOrigin(c, deps.gitPublicOrigin),
    });
    if (!man.ok) return deny();
    const results = [];
    for (const entry of man.value.entries) {
      const matches = await deps.read.grep(entry.repoName as RepoName, q);
      if (matches.length)
        results.push({ mountPath: entry.mountPath, matches });
    }
    return Response.json({ query: q, results });
  });

  // --- Device Authorization Grant (RFC 8628), so the connector never needs a
  // token pasted on the command line. The CLI requests a code, the user
  // approves in the browser (app.monora.ai), the CLI exchanges it for a token. ---

  // Step 1: the CLI requests a flow. Returns the secret device_code (kept by
  // the CLI), a short user_code (shown to the user), and where to approve.
  app.post("/device/code", async (c) => {
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = generateUserCode();
    await deps.deviceFlows.create({
      deviceCode,
      userCode,
      expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
    });
    const verificationUri = `${deps.appUrl.replace(/\/+$/, "")}/connect/device`;
    return c.json({
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
      interval: DEVICE_POLL_INTERVAL_SEC,
      expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    });
  });

  // Step 2: the CLI polls with its device_code. While pending it gets
  // `authorization_pending`; once approved we mint a token from the approved
  // user/org and hand back the plaintext exactly once (never stored).
  app.post("/device/token", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const deviceCode = (body as Record<string, unknown>)?.deviceCode;
    if (typeof deviceCode !== "string" || !deviceCode) {
      return c.json({ error: "deviceCode required" }, 400);
    }
    const now = new Date();
    const flow = await deps.deviceFlows.findActiveByDeviceCode(deviceCode, now);
    // Not found OR past its TTL: terminal. Tell the CLI to stop.
    if (!flow) return c.json({ status: "expired" });
    if (flow.status === "pending") {
      return c.json({ status: "authorization_pending" });
    }
    if (flow.status === "denied") return c.json({ status: "denied" });
    // Already used (single-claim): treat as expired so a leaked poll can't reuse.
    if (flow.status === "claimed") return c.json({ status: "expired" });
    if (flow.status === "approved") {
      if (!flow.userId || !flow.orgId) {
        return c.json({ status: "authorization_pending" });
      }
      // Atomically claim BEFORE minting, so concurrent polls can't double-mint.
      const claimed = await deps.deviceFlows.claim(flow.id, now);
      if (!claimed) return c.json({ status: "expired" });
      const res = await deps.issueToken({
        orgId: flow.orgId,
        subjectType: "user",
        subjectId: flow.userId,
        name: `Connector ${now.toISOString().slice(0, 10)}`,
        actorId: flow.userId,
      });
      if (!res.ok) return c.json({ error: "could not mint token" }, 500);
      return c.json({ status: "complete", token: res.value.plaintext });
    }
    return c.json({ status: "authorization_pending" });
  });

  app.get("/:brain/:repo/info/refs", async (c) => {
    const service = c.req.query("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      // Refuse the dumb protocol; smart only.
      return new Response("smart protocol required", { status: 400 });
    }
    const svc: GitService =
      service === "git-receive-pack" ? "receive-pack" : "upload-pack";
    const res = await deps.authorize({
      rawToken: extractToken(c.req.header("authorization")),
      repoName: repoNameOf(c),
      op: svc as GitOp,
    });
    if (!res.ok) return deny();
    const body = await deps.git.advertiseRefs(
      res.value.repoName,
      svc,
      c.req.header("git-protocol"),
    );
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": deps.git.contentType(svc, "advertisement"),
        "Cache-Control": "no-cache",
      },
    });
  });

  const rpc = (svc: GitService) => async (c: Context) => {
    const res = await deps.authorize({
      rawToken: extractToken(c.req.header("authorization")),
      repoName: repoNameOf(c),
      op: svc as GitOp,
    });
    if (!res.ok) return deny();
    let input = Buffer.from(await c.req.arrayBuffer());
    if ((c.req.header("content-encoding") ?? "").includes("gzip")) {
      input = gunzipSync(input, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    }
    const out = await deps.git.rpc(
      res.value.repoName,
      svc,
      input,
      c.req.header("git-protocol"),
    );
    return new Response(out, {
      status: 200,
      headers: {
        "Content-Type": deps.git.contentType(svc, "result"),
        "Cache-Control": "no-cache",
      },
    });
  };

  app.post("/:brain/:repo/git-upload-pack", rpc("upload-pack"));
  app.post("/:brain/:repo/git-receive-pack", rpc("receive-pack"));

  return app;
}
