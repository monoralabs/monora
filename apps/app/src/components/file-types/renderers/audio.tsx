import { Music } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, badgeFor } from "../shared";

const ACCENT = "text-[var(--indigo)]";

function AudioPreview({ file }: FilePreviewProps) {
  // Future: a waveform thumbnail.
  return <GlyphPreview icon={Music} accentClass={ACCENT} badge={badgeFor(file, "AUDIO")} />;
}

export const audioType: FileTypeDescriptor = {
  id: "audio",
  label: "Audio",
  extensions: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "aiff"],
  Icon: Music,
  accentClass: ACCENT,
  Preview: AudioPreview,
};
