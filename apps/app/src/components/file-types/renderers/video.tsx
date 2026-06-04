import { FileVideo } from "lucide-react";
import type { FileTypeDescriptor, FilePreviewProps } from "../types";
import { GlyphPreview, PreviewShell, badgeFor } from "../shared";

const ACCENT = "text-[var(--accent)]";

function VideoPreview({ file }: FilePreviewProps) {
  if (file.url) {
    return (
      <PreviewShell>
        <video
          src={file.url}
          muted
          preload="metadata"
          className="absolute inset-0 size-full object-cover"
        />
      </PreviewShell>
    );
  }
  return <GlyphPreview icon={FileVideo} accentClass={ACCENT} badge={badgeFor(file, "VIDEO")} />;
}

export const videoType: FileTypeDescriptor = {
  id: "video",
  label: "Video",
  extensions: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "gifv"],
  Icon: FileVideo,
  accentClass: ACCENT,
  Preview: VideoPreview,
};
