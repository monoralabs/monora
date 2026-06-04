import { createTRPCContext } from "@/server/api/trpc";
import { useCases } from "@/server/usecases";

/**
 * Raw file bytes for the Brain explorer's binary previews (images today).
 * `GET /api/brains/raw?folderId=<uuid>&path=<repo/path>`.
 *
 * The same `can(read)` gate as the rest of the read side runs inside the
 * use-case; a folder you may not read is indistinguishable from a missing one
 * (404). This is the stable read seam: today it reads the git blob, later it
 * can read an R2 object for the same path without the client changing (see
 * roadmap phase 4.7).
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const folderId = searchParams.get("folderId");
  const path = searchParams.get("path");
  if (!folderId || !path) {
    return new Response("Missing folderId or path", { status: 400 });
  }

  // Reuse the tRPC context for auth + active org (incl. the preview fallback).
  const ctx = await createTRPCContext({ headers: req.headers });
  if (!ctx.user || !ctx.orgId) {
    return new Response(null, { status: 404 });
  }

  const res = await useCases.readBrainFileBytes({
    subject: { userId: ctx.user.id, orgId: ctx.orgId },
    folderId,
    path,
  });
  if (!res.ok) {
    // Over-cap -> 413 (the client shows the fallback); anything else (forbidden,
    // missing, bad path) -> uniform 404.
    const status = res.error.code === "validation" ? 413 : 404;
    return new Response(null, { status });
  }

  // Uint8Array is a valid BodyInit; copy into a fresh ArrayBuffer to satisfy
  // the BodyInit type regardless of the backing buffer.
  const body = res.value.bytes.slice().buffer;
  return new Response(body, {
    headers: {
      "Content-Type": mimeFromPath(path),
      "Content-Disposition": "inline",
      // Private: the bytes are access-controlled, so no shared/CDN caching.
      "Cache-Control": "private, max-age=300",
    },
  });
}

/** Minimal extension -> MIME map for the types we serve inline; everything
 *  else is an opaque download. */
function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };
  return MIME[ext] ?? "application/octet-stream";
}
