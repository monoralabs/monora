#!/usr/bin/env tsx
/**
 * Backfill B1/B2 media (roadmap 4.7.1): upload each media file to the R2 blob
 * store and write a pointer in its place inside the right brain-folder working
 * tree, so `git push` per folder lands them in the brain. Idempotent (HEAD-skip).
 *
 *   R2_ACCOUNT_ID/.. R2_BUCKET=dreamshot R2_KEY_PREFIX=monora \
 *   tsx scripts/backfill-media.ts <orgRoot> <workspaceDreamshotDir>
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
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
};
const isImage = (f: string) => path.extname(f).toLowerCase() in MIME;

// Each job maps source media -> a brain folder (its own repo in the workspace).
// `dir` globs all images in a directory; `file` is a single asset.
type Job =
  | { kind: "dir"; src: string; folder: string; relBase: string }
  | { kind: "file"; src: string; folder: string; rel: string };

const JOBS: Job[] = [
  {
    kind: "dir",
    src: "departments/finance/funding/preseed2026/research/ai-native-agency-research/raw/images",
    folder: "departments/finance",
    relBase: "funding/preseed2026/research/ai-native-agency-research/raw/images",
  },
  { kind: "file", src: "skills/burofax/logo.png", folder: "skills", rel: "burofax/logo.png" },
  {
    kind: "file",
    src: "departments/sales/events/2026-03-the-new-retail/_JLP9145_2.jpg",
    folder: "departments/sales",
    rel: "events/2026-03-the-new-retail/_JLP9145_2.jpg",
  },
];

async function main() {
  const orgRoot = process.argv[2];
  const wsDir = process.argv[3]; // the brain dir, e.g. .../monora-brains/dreamshot
  if (!orgRoot || !wsDir) {
    throw new Error("usage: tsx backfill-media.ts <orgRoot> <workspaceBrainDir>");
  }
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const bucket = need("R2_BUCKET");
  const prefix = need("R2_KEY_PREFIX");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: need("R2_ACCESS_KEY_ID"),
      secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
    },
  });

  // Expand jobs into concrete (srcAbs, folder, rel) units.
  const units: { srcAbs: string; folder: string; rel: string }[] = [];
  for (const j of JOBS) {
    if (j.kind === "file") {
      units.push({ srcAbs: path.join(orgRoot, j.src), folder: j.folder, rel: j.rel });
    } else {
      const names = (await readdir(path.join(orgRoot, j.src))).filter(isImage).sort();
      for (const n of names) {
        units.push({
          srcAbs: path.join(orgRoot, j.src, n),
          folder: j.folder,
          rel: `${j.relBase}/${n}`,
        });
      }
    }
  }

  let uploaded = 0, deduped = 0;
  const touched = new Set<string>();
  for (const u of units) {
    const bytes = await readFile(u.srcAbs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const contentType = MIME[path.extname(u.srcAbs).toLowerCase()] ?? "application/octet-stream";
    const key = `${prefix}/blobs/${sha256}`.replace(/\/{2,}/g, "/");
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      deduped++;
    } catch {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentType: contentType,
        CacheControl: "private, max-age=31536000, immutable",
      }));
      uploaded++;
    }
    const pointer = {
      monora_blob: { sha256, size: bytes.length, content_type: contentType, name: path.basename(u.srcAbs) },
    };
    const dest = path.join(wsDir, u.folder, u.rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(pointer, null, 2) + "\n");
    touched.add(u.folder);
  }

  console.log(`media: ${units.length}  uploaded: ${uploaded}  deduped: ${deduped}`);
  console.log(`touched folders:\n${[...touched].map((f) => "  " + f).join("\n")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
