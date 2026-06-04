import { FileText } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview } from "../shared";

const ACCENT = "text-[var(--brick)]";

function PdfPreview({ file }: FilePreviewProps) {
  // Future: <embed src={file.url} type="application/pdf" /> or a rendered page.
  return <GlyphPreview icon={FileText} accentClass={ACCENT} badge="PDF" />;
}

export const pdfType: FileTypeDescriptor = {
  id: "pdf",
  label: "PDF",
  extensions: ["pdf"],
  Icon: FileText,
  accentClass: ACCENT,
  Preview: PdfPreview,
};
