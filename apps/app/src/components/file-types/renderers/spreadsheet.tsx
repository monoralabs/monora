import { FileSpreadsheet } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--ok)]";

function SpreadsheetPreview({ file }: FilePreviewProps) {
  // Future: render a small grid of the first rows when the backend exposes them.
  return <GlyphPreview icon={FileSpreadsheet} accentClass={ACCENT} badge={badgeFor(file, "SHEET")} />;
}

export const spreadsheetType: FileTypeDescriptor = {
  id: "spreadsheet",
  label: "Spreadsheet",
  extensions: ["csv", "tsv", "xls", "xlsx", "ods", "numbers", "gsheet"],
  Icon: FileSpreadsheet,
  accentClass: ACCENT,
  Preview: SpreadsheetPreview,
};
