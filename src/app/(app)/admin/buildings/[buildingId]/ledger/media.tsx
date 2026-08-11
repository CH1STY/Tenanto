"use client";

import { useRef, useState, useTransition } from "react";
import {
  uploadMonthMedia,
  deleteMonthMedia,
  type MediaItem,
} from "@/app/buildings/[buildingId]/media-actions";
import { ImageLightbox } from "@/components/image-lightbox";

/**
 * Downscale + recompress an image in the browser before upload (WhatsApp-style):
 * caps the longest edge and re-encodes as JPEG to keep stored bytes small.
 */
async function compressImage(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  const MAX_EDGE = 1600;
  const QUALITY = 0.72;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, width: 0, height: 0 };

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { blob: file, width, height };
  }
  // Flatten transparency onto white, since JPEG has no alpha channel.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", QUALITY),
  );
  if (!blob || blob.size >= file.size) {
    return { blob: file, width, height };
  }
  return { blob, width, height };
}

export function MonthAttachments({
  buildingId,
  monthYear,
  initialMedia,
  canDelete,
}: {
  buildingId: string;
  monthYear: string;
  initialMedia: MediaItem[];
  canDelete: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [media, setMedia] = useState<MediaItem[]>(initialMedia);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          setError("Only image files are allowed.");
          continue;
        }
        const { blob, width, height } = await compressImage(file);
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        const optimized =
          blob === file ? file : new File([blob], name, { type: "image/jpeg" });

        const fd = new FormData();
        fd.set("file", optimized);
        fd.set("width", String(width));
        fd.set("height", String(height));

        const res = await uploadMonthMedia(buildingId, monthYear, fd);
        if (res.error || !res.media) setError(res.error || "Upload failed.");
        else setMedia(res.media);
      }
    } catch {
      setError("Could not process the image.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this file? This cannot be undone.")) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteMonthMedia(buildingId, monthYear, id);
      if (res.error || !res.media) setError(res.error || "Delete failed.");
      else setMedia(res.media);
    });
  }

  return (
    <section className="no-print mt-6 rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
          Attachments
        </p>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Uploading…" : "Add images"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      {media.length === 0 ? (
        <p className="mt-3 text-sm text-black/55 dark:text-white/55">
          No images attached to this month.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map((m, i) => {
            const url = `/buildings/${buildingId}/media/${m.id}`;
            return (
              <div
                key={m.id}
                className="overflow-hidden rounded-lg border border-black/10 dark:border-white/15"
              >
                <button
                  type="button"
                  onClick={() => setOpenIndex(i)}
                  className="block w-full cursor-zoom-in"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={m.filename || "Attachment"}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                </button>
                <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                  <span className="min-w-0 truncate text-[11px] text-black/50 dark:text-white/50">
                    {m.createdAt}
                    {m.uploadedByName ? ` · ${m.uploadedByName}` : ""}
                  </span>
                  {canDelete ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(m.id)}
                      className="shrink-0 text-[11px] font-medium text-red-600 hover:underline dark:text-red-400"
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ImageLightbox
        images={media.map((m) => ({
          url: `/buildings/${buildingId}/media/${m.id}`,
          filename: m.filename,
        }))}
        index={openIndex}
        onClose={() => setOpenIndex(null)}
        onIndexChange={setOpenIndex}
      />
    </section>
  );
}
