# `file-types/` - the brain explorer's per-type file visualization

This folder owns **how a file looks** in the brain explorer (the Finder/Drive/Frame.io
grid at `/dashboard/brains/[brainId]`). One renderer per file type, one shared card
shell, one registry. Add a type by writing a small file - never by branching inside
the explorer.

## The shape

```
file-types/
  types.ts          # FileMeta + FileTypeDescriptor (the contract). Start here.
  shared.tsx        # getExt, toFileMeta, PreviewShell, GlyphPreview, badgeFor.
  file-card.tsx     # FileCard: the shared chrome (header row + preview canvas).
  registry.tsx      # FILE_TYPES list + resolveFileType(name). Wire new types here.
  renderers/        # one file per type, each exporting a FileTypeDescriptor.
    image.tsx pdf.tsx document.tsx spreadsheet.tsx presentation.tsx
    code.tsx video.tsx audio.tsx archive.tsx generic.tsx
  index.ts          # public surface - import from "@/components/file-types".
```

`FileCard` is type-agnostic: it reads the file name, asks `resolveFileType` for the
right descriptor, draws the header (icon + name + optional `⋮` menu), and hands the
canvas to that descriptor's `Preview`. The explorer only ever renders `<FileCard/>`.

## Add a new file type (the only procedure)

1. **Create `renderers/<type>.tsx`** exporting a `FileTypeDescriptor` (see `types.ts`).
   Copy the smallest existing one (`archive.tsx`) as a template:
   - `id` / `label` - stable id + human label.
   - `extensions` - lowercased, no dot.
   - `Icon` - a `lucide-react` icon (verify it exists in the installed version).
   - `accentClass` - see the **color rule** below.
   - `Preview` - usually just `<GlyphPreview icon={...} accentClass={...} badge={...}/>`.
2. **Register it** in `registry.tsx`: import it and add it to `FILE_TYPES`
   **before `genericType`** (the catch-all). Earlier entries win on extension overlap.
3. That's it - no explorer changes.

## Rules (non-negotiable)

- **Color rule (brand golden rule).** Never a raw hex. `accentClass` must reference a
  brand token via an arbitrary class, e.g. `text-[var(--brick)]`. Stay in the warm
  palette - tokens available: `--accent --flame --coral --brick --gold --amber --folder
  --indigo --ok --muted-foreground --faint`. Types differ by token, never by inventing
  a color. No Google-Drive primary red/green/blue.
- **Progressive enhancement.** The backend (`browseFolder`) gives only `{name, path}`
  today, so `file.url`/`size`/`modifiedAt` are usually absent. Every `Preview` MUST
  render cleanly with just a name (the `GlyphPreview` path) and *light up a real
  thumbnail when `file.url` exists* (see `image.tsx` / `video.tsx` for the branch).
- **Stay presentational.** Renderers are pure view: no tRPC, no fetching, no routing.
  Data arrives via the `FileMeta` prop. Fetching belongs in the explorer/server.
- **Keep the canvas uniform.** Use `PreviewShell` (fixed 4:3) so the grid stays tidy.
- **One type per file.** Don't pile multiple descriptors into one renderer file.

## When the backend grows

When `browseFolder` starts returning a preview `url` (and size/mtime), the only change
needed is to populate those fields in `toFileMeta` at the call site - every renderer
already branches on them. That's the whole point of this layout.
