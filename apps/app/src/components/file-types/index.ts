/**
 * Per-file-type visualization layer for the brain explorer (Finder/Drive/Frame.io
 * style). One renderer per type lives in `renderers/`; `CLAUDE.md` documents the
 * contract for adding new ones. Consumers import from here, not from internals.
 */
export { FileCard } from "./file-card";
export { resolveFileType, FILE_TYPES } from "./registry";
export { toFileMeta, getExt } from "./shared";
export { viewerModeFor, type ViewerMode } from "./viewer-mode";
export type { FileMeta, FileTypeDescriptor, FilePreviewProps } from "./types";
