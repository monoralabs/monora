import { BookText } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--muted-foreground)]";

function DocumentPreview({ file }: FilePreviewProps) {
  // Future: render the first lines of markdown/text content as a faux page.
  return <GlyphPreview icon={BookText} accentClass={ACCENT} badge={badgeFor(file, "DOC")} />;
}

export const documentType: FileTypeDescriptor = {
  id: "document",
  label: "Document",
  extensions: ["md", "mdx", "txt", "rtf", "doc", "docx", "odt", "pages"],
  Icon: BookText,
  accentClass: ACCENT,
  Preview: DocumentPreview,
};
