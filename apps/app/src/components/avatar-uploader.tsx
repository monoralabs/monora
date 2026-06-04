"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Read an image file and downscale it on a canvas to a compact webp blob.
 *  Resizing client-side keeps the upload tiny; the blob is then sent to R2 and
 *  we store the returned URL (never the bytes) so identity columns stay small. */
async function fileToResizedBlob(file: File, max = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Encode failed"))),
      "image/webp",
      0.85,
    );
  });
}

/** Upload the blob to R2 via the server route and return its public URL. */
async function uploadToR2(blob: Blob, kind: "avatar" | "org-logo"): Promise<string> {
  const form = new FormData();
  form.append("file", blob, `upload.webp`);
  form.append("kind", kind);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { error?: string }).error)
      .catch(() => null);
    throw new Error(detail ?? `Upload failed (HTTP ${res.status})`);
  }
  const { url } = (await res.json()) as { url: string };
  return url;
}

export function AvatarUploader({
  value,
  fallback,
  shape = "circle",
  kind,
  disabled,
  onChange,
}: {
  /** Current image URL, or null. */
  value: string | null;
  /** Initials shown when there is no image. */
  fallback: string;
  shape?: "circle" | "square";
  /** What this image is, so the server scopes the storage key correctly. */
  kind: "avatar" | "org-logo";
  disabled?: boolean;
  onChange: (next: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Pick an image file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const blob = await fileToResizedBlob(file);
      onChange(await uploadToR2(blob, kind));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setBusy(false);
    }
  }

  const radius = shape === "circle" ? "rounded-full" : "rounded-xl";

  return (
    <div className="flex items-center gap-4">
      <div
        className={cn(
          "relative grid size-16 shrink-0 place-items-center overflow-hidden text-lg font-bold text-white [background:var(--grad-warm)]",
          radius,
        )}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          fallback.slice(0, 2).toUpperCase()
        )}
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/40">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPick}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus className="size-4" /> {value ? "Change" : "Upload"}
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => onChange(null)}
            >
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {error ?? "PNG, JPG or WEBP. Resized to 256px."}
        </p>
      </div>
    </div>
  );
}
