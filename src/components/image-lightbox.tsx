"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type LightboxImage = { url: string; filename?: string };

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Full-screen image viewer with zoom, pan, download and prev/next navigation. */
export function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  images: LightboxImage[];
  index: number | null;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(
    null,
  );

  const open = index != null;
  const count = images.length;
  const current = open ? images[index] : null;

  useEffect(() => setMounted(true), []);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    pointers.current.clear();
    pinch.current = null;
    pan.current = null;
  }, []);

  // Reset the transform whenever the shown image changes.
  useEffect(() => {
    reset();
  }, [index, reset]);

  const go = useCallback(
    (dir: number) => {
      if (index == null || count < 2) return;
      onIndexChange((index + dir + count) % count);
    },
    [index, count, onIndexChange],
  );

  // Lock page scroll and wire keyboard shortcuts while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, go]);

  function zoomBy(factor: number) {
    setScale((s) => {
      const next = clamp(s * factor, MIN_SCALE, MAX_SCALE);
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
      return next;
    });
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  function onDoubleClick() {
    if (scale > 1) reset();
    else setScale(2);
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
      pan.current = null;
    } else if (scale > 1) {
      pan.current = { x: e.clientX, y: e.clientY, tx, ty };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const next = clamp(
        (dist / pinch.current.dist) * pinch.current.scale,
        MIN_SCALE,
        MAX_SCALE,
      );
      setScale(next);
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
      return;
    }

    if (pan.current) {
      setTx(pan.current.tx + (e.clientX - pan.current.x));
      setTy(pan.current.ty + (e.clientY - pan.current.y));
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) pan.current = null;
  }

  if (!mounted || !open || !current) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      {/* Toolbar */}
      <div
        className="flex items-center justify-between gap-2 px-4 py-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 truncate text-sm text-white/80">
          {current.filename || "Attachment"}
          {count > 1 ? (
            <span className="ml-2 text-white/50">
              {index! + 1} / {count}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1">
          <ToolbarButton label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
            −
          </ToolbarButton>
          <ToolbarButton label="Reset zoom" onClick={reset}>
            {Math.round(scale * 100)}%
          </ToolbarButton>
          <ToolbarButton label="Zoom in" onClick={() => zoomBy(1.3)}>
            +
          </ToolbarButton>
          <a
            href={current.url}
            download={current.filename || "image"}
            onClick={(e) => e.stopPropagation()}
            className="ml-1 inline-flex h-9 items-center justify-center rounded-md bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/20"
          >
            Download
          </a>
          <ToolbarButton label="Close" onClick={onClose}>
            ✕
          </ToolbarButton>
        </div>
      </div>

      {/* Stage */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        style={{ touchAction: "none" }}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {count > 1 ? <NavButton side="left" onClick={() => go(-1)} /> : null}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.url}
          alt={current.filename || "Attachment"}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            cursor: scale > 1 ? "grab" : "default",
            transition:
              pan.current || pinch.current ? "none" : "transform 0.1s",
          }}
        />

        {count > 1 ? <NavButton side="right" onClick={() => go(1)} /> : null}
      </div>
    </div>,
    document.body,
  );
}

function ToolbarButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-9 min-w-9 items-center justify-center rounded-md bg-white/10 px-2 text-sm font-medium text-white hover:bg-white/20"
    >
      {children}
    </button>
  );
}

function NavButton({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous" : "Next"}
      onClick={onClick}
      className={`absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 ${
        side === "left" ? "left-2 sm:left-4" : "right-2 sm:right-4"
      }`}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}
