"use client";

import type { FileMeta } from "./types";
import { resolveFileType } from "./registry";

/**
 * The Drive/Frame.io file tile: a header row (type icon + name + ⋮ menu) over a
 * type-specific preview canvas. The card is type-agnostic - it asks the
 * registry which renderer to use and delegates the canvas to it.
 */
export function FileCard({
  file,
  selected = false,
  onOpen,
  onSelect,
  menu,
}: {
  file: FileMeta;
  selected?: boolean;
  /** Double-click (open the file - preview/edit comes later). */
  onOpen?: () => void;
  /** Single-click (select/highlight). */
  onSelect?: () => void;
  /** Optional ⋮ menu rendered in the header (e.g. a <MoreMenu/>). */
  menu?: React.ReactNode;
}) {
  const type = resolveFileType(file.name);
  const { Icon, Preview, accentClass, label } = type;

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onOpen}
      title={file.name}
      aria-label={`${label}: ${file.name}`}
      className={`group flex flex-col rounded-lg border bg-card text-left transition-colors ${
        onOpen || onSelect ? "cursor-pointer" : ""
      } ${
        selected
          ? "border-accent/60 ring-1 ring-accent/40"
          : "border-border hover:border-accent/40"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className={`size-4 shrink-0 ${accentClass}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {file.name}
        </span>
        {menu && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {menu}
          </span>
        )}
      </div>
      {/* Clip only the preview to the card radius - keeping overflow visible on
          the card lets the header's ⋮ menu pop out instead of being cut off. */}
      <div className="overflow-hidden rounded-b-lg border-t border-border/60">
        <Preview file={file} />
      </div>
    </div>
  );
}
