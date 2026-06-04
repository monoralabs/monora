import { FileCode } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--indigo)]";

function CodePreview({ file }: FilePreviewProps) {
  // Future: syntax-highlighted first lines of the source.
  return <GlyphPreview icon={FileCode} accentClass={ACCENT} badge={badgeFor(file, "CODE")} />;
}

export const codeType: FileTypeDescriptor = {
  id: "code",
  label: "Code",
  extensions: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "css", "scss", "html",
    "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "sh", "bash",
    "zsh", "yml", "yaml", "toml", "sql", "graphql", "xml", "php", "swift",
  ],
  Icon: FileCode,
  accentClass: ACCENT,
  Preview: CodePreview,
};
