import type { LucideIcon } from "lucide-react";
import type { FileMeta } from "./types";

/** "informe.pdf" -> "pdf". "Makefile" / "README" -> "". Always lowercased. */
export function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

/** Turn a raw browse entry (or any name/path pair) into a {@link FileMeta}. */
export function toFileMeta(entry: {
  name: string;
  path: string;
  url?: string;
  size?: number;
  modifiedAt?: string;
}): FileMeta {
  return { ...entry, ext: getExt(entry.name) };
}

/**
 * The shared preview canvas. Renderers either drop a {@link GlyphPreview} in
 * here for the no-bytes case, or compose their own children (e.g. an <img>).
 * Fixed 4:3 so the grid stays tidy like Finder/Drive.
 */
export function PreviewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-soft">
      {children}
    </div>
  );
}

/**
 * The default canvas content: the type glyph centered on the warm canvas with a
 * small extension badge. This is what every type shows until real bytes arrive.
 */
export function GlyphPreview({
  icon: Icon,
  accentClass,
  badge,
}: {
  icon: LucideIcon;
  accentClass: string;
  /** Short uppercase label, usually the extension (PDF, SVG, CSV). */
  badge?: string;
}) {
  return (
    <PreviewShell>
      <div className="absolute inset-0 grid place-items-center">
        <Icon className={`size-12 ${accentClass} opacity-90`} strokeWidth={1.25} />
      </div>
      {badge && (
        <span
          className={`absolute left-2 top-2 rounded-md bg-card px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${accentClass} shadow-soft`}
        >
          {badge}
        </span>
      )}
    </PreviewShell>
  );
}

/** Uppercased extension for use as a badge; falls back to a given label. */
export function badgeFor(file: FileMeta, fallback: string): string {
  return file.ext ? file.ext.toUpperCase() : fallback;
}
