import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Everything a renderer knows about one file. Today the brain backend only
 * provides `name` + `path` (see `browseFolder`); the rest is optional and will
 * be filled in as the server learns to expose thumbnails, sizes, and content.
 * Renderers MUST treat the optional fields as progressive enhancement - render
 * a clean glyph when they're absent, a real preview when they're present.
 */
export type FileMeta = {
  /** File name including extension, e.g. "informe.pdf". */
  name: string;
  /** Path within the folder repo, e.g. "reports/informe.pdf". */
  path: string;
  /** Lowercased extension without the dot, e.g. "pdf". "" if none. */
  ext: string;
  /** Direct/preview URL once the backend serves bytes. Enables real thumbnails. */
  url?: string;
  /** Size in bytes, when known. */
  size?: number;
  /** ISO timestamp of last modification, when known. */
  modifiedAt?: string;
};

/**
 * The preview surface a renderer paints inside a {@link FileCard}. It owns only
 * the canvas (the area above the footer); the card chrome is shared.
 */
export type FilePreviewProps = {
  file: FileMeta;
};

/**
 * One file-type renderer. Add a new type by exporting one of these from a file
 * under `renderers/` and registering it in `registry.tsx`. See `CLAUDE.md`.
 */
export type FileTypeDescriptor = {
  /** Stable id, e.g. "pdf", "image". Unique across the registry. */
  id: string;
  /** Human label for menus / a11y, e.g. "PDF", "Spreadsheet". */
  label: string;
  /** Lowercased extensions (no dot) this type claims, e.g. ["png", "jpg"]. */
  extensions: string[];
  /** Small icon shown in the card footer and folder rows. */
  Icon: LucideIcon;
  /**
   * Tailwind class that paints the type's accent on text/icon. MUST reference a
   * brand token, never a raw hex - e.g. "text-[var(--brick)]". The warm palette
   * keeps every type on-brand while still telling them apart at a glance.
   */
  accentClass: string;
  /** Paints the large preview canvas. */
  Preview: ComponentType<FilePreviewProps>;
};
