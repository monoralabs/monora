import { getExt } from "./shared";

/**
 * How the full-file viewer should render a file, decided by extension. The card
 * grid uses {@link resolveFileType} for glyphs; the *viewer* uses this to pick
 * markdown vs plain text vs "no inline preview" (binary). The backend serves
 * file bytes as a UTF-8 string (git cat-file), so only text is renderable
 * inline today; binary types wait for a bytes/URL endpoint (see file-types CLAUDE.md).
 */
export type ViewerMode = "markdown" | "image" | "text" | "binary";

const MARKDOWN = new Set(["md", "mdx", "markdown"]);

/** Images the browser renders in an <img>, served raw from /api/brains/raw.
 *  svg is also valid as text but previews better as an image; heic/tiff stay
 *  binary (no reliable browser support). */
const IMAGE = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg",
]);

/** Extensions whose bytes are not meaningfully a UTF-8 string. */
const BINARY = new Set([
  // images the browser can't render inline
  "heic", "tiff",
  // office / docs
  "pdf", "doc", "docx", "odt", "pages", "xls", "xlsx", "ods", "numbers",
  "ppt", "pptx", "odp", "key",
  // audio / video
  "mp4", "mov", "webm", "mkv", "avi", "mp3", "wav", "flac", "ogg", "m4a", "aac",
  // archives / binaries / fonts
  "zip", "tar", "gz", "tgz", "rar", "7z", "bin", "exe", "dmg",
  "woff", "woff2", "ttf", "otf", "eot",
]);

/** markdown -> markdown; renderable image -> image; known binary -> binary;
 *  everything else (code, txt, json, csv, extensionless README/Dockerfile/
 *  LICENSE) -> text. */
export function viewerModeFor(name: string): ViewerMode {
  const ext = getExt(name);
  if (MARKDOWN.has(ext)) return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (BINARY.has(ext)) return "binary";
  return "text";
}
