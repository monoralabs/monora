import { File } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--faint)]";

/** The fallback for any extension no other type claims. */
function GenericPreview({ file }: FilePreviewProps) {
  return <GlyphPreview icon={File} accentClass={ACCENT} badge={badgeFor(file, "FILE")} />;
}

export const genericType: FileTypeDescriptor = {
  id: "generic",
  label: "File",
  extensions: [],
  Icon: File,
  accentClass: ACCENT,
  Preview: GenericPreview,
};
