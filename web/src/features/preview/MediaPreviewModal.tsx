import {
  useEffect,
  useRef,
  type KeyboardEvent,
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

export function MediaPreviewModal({
  media,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const pointerStartX = useRef<number | null>(null);

  useEffect(() => {
    if (!media) return;
    containerRef.current?.focus();
  }, [media]);

  if (!media) return null;

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (touchStartX.current === null) return;
    const deltaX = (event.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    if (deltaX > 50 && hasPrev) onPrev();
    if (deltaX < -50 && hasNext) onNext();
    touchStartX.current = null;
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") return;
    pointerStartX.current = event.clientX;
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") return;
    const start = pointerStartX.current;
    if (start == null) return;
    const deltaX = event.clientX - start;
    if (deltaX > 50 && hasPrev) onPrev();
    if (deltaX < -50 && hasNext) onNext();
    pointerStartX.current = null;
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
      >
        <button className="close-button" onClick={onClose} aria-label="关闭">
          ×
        </button>
        <div
          className="modal__content"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        >
          {hasPrev && (
            <button className="nav-button left" onClick={onPrev} aria-label="上一张">
              ‹
            </button>
          )}
          {media.kind === "video" ? (
            <video controls autoPlay className="modal__media">
              <source src={media.url} />
            </video>
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
