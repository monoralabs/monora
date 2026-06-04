import { Presentation } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--flame)]";

function PresentationPreview({ file }: FilePreviewProps) {
  // Future: render the first slide thumbnail.
  return <GlyphPreview icon={Presentation} accentClass={ACCENT} badge={badgeFor(file, "SLIDES")} />;
}

export const presentationType: FileTypeDescriptor = {
  id: "presentation",
  label: "Presentation",
  extensions: ["ppt", "pptx", "key", "odp", "gslides"],
  Icon: Presentation,
  accentClass: ACCENT,
  Preview: PresentationPreview,
};
