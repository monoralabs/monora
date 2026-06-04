import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/env";

/**
 * Cloudflare R2 (S3-compatible) object storage for binary assets - avatars, org
 * logos, and later brain media. Keys are namespaced under R2_KEY_PREFIX
 * (`monora/...`) inside the shared bucket; objects are served from the bucket's
 * public CDN domain (R2_PUBLIC_BASE_URL). We store the resulting URL in the DB,
 * never the bytes - that is what keeps `user.image` / `organization.logo` small
 * (a fat base64 data URL there bloats the session cookie -> HTTP 431).
 */

let client: S3Client | null = null;

export function r2Configured(): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET,
  );
}

/** The shared S3 client for R2 (lazy singleton). Exported so the blob store
 *  reuses one client/connection pool rather than standing up its own. */
export function r2Client(): S3Client {
  if (!r2Configured()) throw new Error("R2 is not configured");
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return client;
}

/** Upload bytes under `<prefix>/<key>` and return the public CDN URL. */
export async function uploadAsset(opts: {
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<string> {
  const key = `${env.R2_KEY_PREFIX}/${opts.key}`.replace(/\/{2,}/g, "/");
  await r2Client().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: opts.body,
      ContentType: opts.contentType,
      // Content is content-addressed (random key per upload), so it never changes.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return `${(env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "")}/${key}`;
}
