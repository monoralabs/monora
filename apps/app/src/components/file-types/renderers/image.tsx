import { FileImage } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, PreviewShell, badgeFor } from "../shared";

const ACCENT = "text-[var(--gold)]";

/** Real thumbnail when the backend serves bytes; warm glyph until then. */
function ImagePreview({ file }: FilePreviewProps) {
  if (file.url) {
    return (
      <PreviewShell>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={file.url}
          alt={file.name}
          className="absolute inset-0 size-full object-cover"
        />
      </PreviewShell>
    );
  }
  return <GlyphPreview icon={FileImage} accentClass={ACCENT} badge={badgeFor(file, "IMG")} />;
}

export const imageType: FileTypeDescriptor = {
  id: "image",
  label: "Image",
  extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "heic"],
  Icon: FileImage,
  accentClass: ACCENT,
  Preview: ImagePreview,
};
