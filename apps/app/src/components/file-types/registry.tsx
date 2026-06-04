import type { FileTypeDescriptor } from "./types";
import { getExt } from "./shared";
import { imageType } from "./renderers/image";
import { pdfType } from "./renderers/pdf";
import { documentType } from "./renderers/document";
import { spreadsheetType } from "./renderers/spreadsheet";
import { presentationType } from "./renderers/presentation";
import { codeType } from "./renderers/code";
import { videoType } from "./renderers/video";
import { audioType } from "./renderers/audio";
import { archiveType } from "./renderers/archive";
import { genericType } from "./renderers/generic";

/**
 * The ordered list of every known file type. To add one: create a renderer in
 * `renderers/`, import it, and drop it in here (before `genericType`, which is
 * the catch-all fallback). See `CLAUDE.md`.
 */
export const FILE_TYPES: FileTypeDescriptor[] = [
  imageType,
  pdfType,
  documentType,
  spreadsheetType,
  presentationType,
  codeType,
  videoType,
  audioType,
  archiveType,
  genericType,
];

/** extension -> descriptor, built once from each type's `extensions`. */
const BY_EXT: Record<string, FileTypeDescriptor> = (() => {
  const map: Record<string, FileTypeDescriptor> = {};
  for (const t of FILE_TYPES) {
    for (const ext of t.extensions) {
      // First registration wins, so order in FILE_TYPES disambiguates overlaps.
      if (!map[ext]) map[ext] = t;
    }
  }
  return map;
})();

/** Resolve the renderer for a file name. Never throws - falls back to generic. */
export function resolveFileType(name: string): FileTypeDescriptor {
  return BY_EXT[getExt(name)] ?? genericType;
}
