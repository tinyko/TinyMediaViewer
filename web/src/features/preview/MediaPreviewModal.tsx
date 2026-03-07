import {
  useEffect,
  useRef,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import type { MediaItem } from "../../types";
import { formatBytes, formatDate } from "../../utils";
import "./preview.css";

interface Props {
  media: MediaItem | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

const SWIPE_THRESHOLD_PX = 50;
const HORIZONTAL_BIAS = 1.1;

export function MediaPreviewModal({
  media,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);
  const supportsPointerEvents =
    typeof window !== "undefined" && typeof window.PointerEvent !== "undefined";

  useEffect(() => {
    if (!media) return;
    containerRef.current?.focus();
  }, [media]);

  useEffect(() => {
    if (!media) return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "ArrowLeft" && hasPrev) {
        event.preventDefault();
        onPrev();
      } else if (event.key === "ArrowRight" && hasNext) {
        event.preventDefault();
        onNext();
      } else if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [hasNext, hasPrev, media, onClose, onNext, onPrev]);

  const mediaUrlWithVersion =
    media && media.kind === "video"
      ? `${media.url}${media.url.includes("?") ? "&" : "?"}v=${media.modified}-${encodeURIComponent(
          media.path
        )}`
      : media?.url ?? "";

  useEffect(() => {
    if (!media || media.kind !== "video") return;
    const video = videoRef.current;
    if (!video) return;

    // Force webviews to tear down old stream state when switching videos.
    try {
      video.pause();
      video.currentTime = 0;
      video.load();
      const playResult = video.play();
      if (playResult && typeof playResult.catch === "function") {
        void playResult.catch(() => undefined);
      }
    } catch {
      // Test environments may not implement media element controls.
    }
  }, [media, mediaUrlWithVersion]);

  const startSwipe = (x: number, y: number) => {
    swipeStart.current = { x, y };
  };

  const endSwipe = (x: number, y: number) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;

    const deltaX = x - start.x;
    const deltaY = y - start.y;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    if (Math.abs(deltaX) < Math.abs(deltaY) * HORIZONTAL_BIAS) return;

    if (deltaX > 0 && hasPrev) onPrev();
    if (deltaX < 0 && hasNext) onNext();
  };

  if (!media) return null;

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (supportsPointerEvents) return;
    const touch = event.touches[0];
    if (!touch) return;
    startSwipe(touch.clientX, touch.clientY);
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (supportsPointerEvents) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    endSwipe(touch.clientX, touch.clientY);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") return;
    pointerId.current = event.pointerId;
    startSwipe(event.clientX, event.clientY);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") return;
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    endSwipe(event.clientX, event.clientY);
  };

  const handlePointerCancel = () => {
    pointerId.current = null;
    swipeStart.current = null;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const horizontal = event.deltaX;
    const vertical = event.deltaY;
    const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
    if (delta < -20 && hasPrev) {
      event.preventDefault();
      onPrev();
    } else if (delta > 20 && hasNext) {
      event.preventDefault();
      onNext();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onTouchMove={(event) => event.preventDefault()}
    >
      <div
        className="modal immersive"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={containerRef}
        onWheel={handleWheel}
      >
        <button className="close-button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div
          className="modal__content"
          onTouchStartCapture={handleTouchStart}
          onTouchEndCapture={handleTouchEnd}
          onPointerDownCapture={handlePointerDown}
          onPointerUpCapture={handlePointerUp}
          onPointerCancelCapture={handlePointerCancel}
        >
          {hasPrev && (
            <button className="nav-button left" onClick={onPrev} aria-label="上一张">
              ‹
            </button>
          )}
          {media.kind === "video" ? (
            <video
              key={`${media.path}:${media.modified}`}
              ref={videoRef}
              src={mediaUrlWithVersion}
              controls
              autoPlay
              loop
              playsInline
              className="modal__media"
            />
          ) : (
            <img
              src={media.url}
              alt={media.name}
              className="modal__media"
              onClick={onClose}
            />
          )}
          {hasNext && (
            <button className="nav-button right" onClick={onNext} aria-label="下一张">
              ›
            </button>
          )}
        </div>
        <footer className="modal__footer compact">
          <div className="media-footer-text">
            <span className="media-title">{media.name}</span>
            <span className="muted">
              {formatBytes(media.size)} · {formatDate(media.modified)}
            </span>
          </div>
          <div className="footer-actions">
            <a href={media.url} download className="ghost-button">
              下载
            </a>
            <button className="ghost-button" onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
