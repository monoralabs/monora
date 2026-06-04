/**
 * Content-addressed blob storage as a port. Binary brain assets (images, ...)
 * are too heavy to keep in git history (git photocopies them on every edit and
 * every clone pays for it), so they live here keyed by the sha256 of their
 * bytes; git keeps only a tiny {@link BlobPointer} in their place.
 *
 * The MVP adapter is Cloudflare R2 (S3-compatible). Because the key IS the
 * content hash, identical bytes map to one object: re-committing an unchanged
 * image never re-uploads (the adapter HEAD-checks first) and the pointer text
 * is byte-identical so git dedups it too. A genuinely edited image is a new
 * sha = a new blob, and the pointer's git history is the version trail.
 */
export interface BlobRef {
  /** Lowercase hex sha256 of the bytes - the content address / storage key. */
  sha256: string;
  size: number;
  contentType: string;
}

export interface BlobStore {
  /**
   * Store bytes content-addressed and return their descriptor. Idempotent and
   * dedup'd: if a blob with this sha256 already exists it is NOT re-uploaded.
   */
  put(bytes: Uint8Array, contentType: string): Promise<BlobRef>;

  /** Fetch the bytes for a sha256. Throws if absent. */
  get(sha256: string): Promise<Uint8Array>;
}

/**
 * What git stores in place of a routed binary: a tiny JSON file at the same
 * path as the original (so the file's extension - and thus its MIME - is
 * unchanged for the reader). Detected by the `monora_blob` marker.
 */
export interface BlobPointer {
  monora_blob: {
    sha256: string;
    size: number;
    content_type: string;
    /** Original filename, for download/Content-Disposition. */
    name: string;
  };
}

/** Serialize a pointer to the JSON text that gets committed (trailing newline
 *  so it reads cleanly and diffs as a one-liner change when the sha moves). */
export function makeBlobPointer(ref: BlobRef, name: string): string {
  const pointer: BlobPointer = {
    monora_blob: {
      sha256: ref.sha256,
      size: ref.size,
      content_type: ref.contentType,
      name,
    },
  };
  return JSON.stringify(pointer, null, 2) + "\n";
}

/** Parse bytes/text into a pointer, or null if they are not one. Pointers are
 *  tiny, so anything large is short-circuited as "not a pointer". */
export function parseBlobPointer(input: Uint8Array | string): BlobPointer | null {
  const text =
    typeof input === "string" ? input : tryDecodeSmallUtf8(input);
  if (text === null) return null;
  if (!text.includes("monora_blob")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const b = (parsed as BlobPointer)?.monora_blob;
    if (
      b &&
      typeof b.sha256 === "string" &&
      typeof b.size === "number" &&
      typeof b.content_type === "string" &&
      typeof b.name === "string"
    ) {
      return parsed as BlobPointer;
    }
  } catch {
    // not JSON -> not a pointer
  }
  return null;
}

export function isBlobPointer(input: Uint8Array | string): boolean {
  return parseBlobPointer(input) !== null;
}

/** A real binary won't be valid small UTF-8; cap the decode so we never buffer
 *  a large blob just to test it. 4 KB is far more than any pointer. */
function tryDecodeSmallUtf8(bytes: Uint8Array): string | null {
  if (bytes.length > 4096) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null; // invalid UTF-8 -> binary -> not a pointer
  }
}
