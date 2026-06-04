#!/usr/bin/env tsx
/**
 * Backfill helper (roadmap 4.7.1): upload one binary file to the content-
 * addressed R2 blob store the read path resolves, and print its pointer JSON.
 *
 * The bytes go to `<R2_KEY_PREFIX>/blobs/<sha256>` in `R2_BUCKET` - the exact
 * key `R2BlobStore` reads - dedup'd via a HEAD-check. The printed JSON is the
 * pointer to commit in git in the file's place.
 *
 *   R2_ACCOUNT_ID=.. R2_ACCESS_KEY_ID=.. R2_SECRET_ACCESS_KEY=.. \
 *   R2_BUCKET=dreamshot R2_KEY_PREFIX=monora \
 *   tsx scripts/blob-put.ts <file>
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4",
};

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: tsx scripts/blob-put.ts <file>");
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const accountId = need("R2_ACCOUNT_ID");
  const bucket = need("R2_BUCKET");
  const prefix = need("R2_KEY_PREFIX");

  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contentType =
    MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const key = `${prefix}/blobs/${sha256}`.replace(/\/{2,}/g, "/");

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: need("R2_ACCESS_KEY_ID"),
      secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
    },
  });

  let skipped = false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    skipped = true; // already present -> dedup
  } catch {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: "private, max-age=31536000, immutable",
      }),
    );
  }

  const pointer = {
    monora_blob: {
      sha256,
      size: bytes.length,
      content_type: contentType,
      name: path.basename(file),
    },
  };
  process.stderr.write(
    `${skipped ? "dedup (exists)" : "uploaded"}  ${key}  (${bytes.length} bytes)\n`,
  );
  process.stdout.write(JSON.stringify(pointer, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
