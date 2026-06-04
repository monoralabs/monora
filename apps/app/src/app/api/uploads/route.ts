import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { r2Configured, uploadAsset } from "@/server/storage/r2";

/**
 * Authenticated image upload -> Cloudflare R2 -> returns a public CDN URL.
 * Used by the avatar/logo uploader so we store a short URL in `user.image` /
 * `organization.logo` instead of a base64 data URL (which bloated the session
 * cookie past Node's header limit -> HTTP 431). The client downscales first;
 * this guards type + size server-side as well.
 */

// AWS SDK + node:crypto need the Node.js runtime, not edge.
export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap (client sends ~15 KB webp)
const EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

export async function POST(req: Request): Promise<Response> {
  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Uploads are not configured (R2 credentials missing)." },
      { status: 503 },
    );
  }

  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const kind = form.get("kind");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (kind !== "avatar" && kind !== "org-logo") {
    return NextResponse.json(
      { error: "kind must be 'avatar' or 'org-logo'" },
      { status: 400 },
    );
  }
  const ext = EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: `Unsupported image type: ${file.type || "unknown"}` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image too large (max 5 MB)" }, { status: 413 });
  }

  // Scope the key to the owning entity. An org logo additionally requires an
  // active org on the session (you can only set the logo of an org you're in).
  let prefix: string;
  if (kind === "org-logo") {
    const orgId = session.session.activeOrganizationId;
    if (!orgId) {
      return NextResponse.json({ error: "No active organization" }, { status: 400 });
    }
    prefix = `org-logos/${orgId}`;
  } else {
    prefix = `avatars/${session.user.id}`;
  }

  const body = new Uint8Array(await file.arrayBuffer());
  const url = await uploadAsset({
    key: `${prefix}-${randomUUID()}.${ext}`,
    body,
    contentType: file.type,
  });
  return NextResponse.json({ url });
}
