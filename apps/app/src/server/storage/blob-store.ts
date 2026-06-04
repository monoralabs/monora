import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { BlobStore, BlobRef } from "@monora/core";
import { env } from "@/env";
import { r2Client, r2Configured } from "./r2";

/**
 * Content-addressed {@link BlobStore} over Cloudflare R2 (Phase 4.7.1). Brain
 * binaries are keyed by the sha256 of their bytes under `<prefix>/blobs/<sha>`,
 * so identical content is stored once and an unchanged file re-committed N
 * times uploads zero extra times (HEAD-check before PUT).
 *
 * Reads go back through `/api/brains/raw` (ACL-gated stream-through), never a
 * public URL - the bucket's public CDN is NOT used for blobs. (A dedicated
 * private bucket is the production hardening; see roadmap 4.7.1.)
 */
export class R2BlobStore implements BlobStore {
  private key(sha256: string): string {
    return `${env.R2_KEY_PREFIX}/blobs/${sha256}`.replace(/\/{2,}/g, "/");
  }

  async put(bytes: Uint8Array, contentType: string): Promise<BlobRef> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref: BlobRef = { sha256, size: bytes.length, contentType };
    const Key = this.key(sha256);
    const client = r2Client();

    // Dedup: a blob with this content already exists -> skip the upload.
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key }),
      );
      return ref;
    } catch {
      // Not found (or head not permitted) -> upload below.
    }

    await client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key,
        Body: bytes,
        ContentType: contentType,
        // Immutable by construction: the key is the content hash.
        CacheControl: "private, max-age=31536000, immutable",
      }),
    );
    return ref;
  }

  async get(sha256: string): Promise<Uint8Array> {
    const res = await r2Client().send(
      new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: this.key(sha256) }),
    );
    if (!res.Body) throw new Error(`blob ${sha256} has no body`);
    return res.Body.transformToByteArray();
  }
}

/**
 * Local-disk {@link BlobStore} for self-hosters with no object store. Same
 * content-addressing as R2 (the key is the sha256), sharded by the first two
 * hex chars to avoid one giant directory, and stored under GIT_ROOT so it
 * shares the data volume and backup story with the bare repos.
 */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}
  private pathFor(sha256: string): string {
    return path.join(this.root, sha256.slice(0, 2), sha256);
  }
  async put(bytes: Uint8Array, contentType: string): Promise<BlobRef> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref: BlobRef = { sha256, size: bytes.length, contentType };
    const file = this.pathFor(sha256);
    try {
      await access(file);
      return ref; // dedup: identical content already stored
    } catch {
      // not present -> write below
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return ref;
  }
  async get(sha256: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(sha256)));
  }
}

/** The configured blob store: R2 when its credentials + bucket are set, else a
 *  local-disk store under GIT_ROOT, so self-host has working binary storage
 *  with no object-store dependency. */
export function blobStore(): BlobStore {
  return r2Configured()
    ? new R2BlobStore()
    : new FsBlobStore(path.join(env.GIT_ROOT, "_blobs"));
}
