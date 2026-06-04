import { FileArchive } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--folder)]";

function ArchivePreview({ file }: FilePreviewProps) {
  return <GlyphPreview icon={FileArchive} accentClass={ACCENT} badge={badgeFor(file, "ZIP")} />;
}

export const archiveType: FileTypeDescriptor = {
  id: "archive",
  label: "Archive",
  extensions: ["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"],
  Icon: FileArchive,
  accentClass: ACCENT,
  Preview: ArchivePreview,
};
