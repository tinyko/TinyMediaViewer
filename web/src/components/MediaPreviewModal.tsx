import type { MediaItem } from "../types";
import { formatBytes, formatDate } from "../utils";
import { useEffect, useRef } from "react";

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
  if (!media) return null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  let touchStartX: number | null = null;

  const handleTouchStart = (event: React.TouchEvent) => {
    touchStartX = event.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: React.TouchEvent) => {
    if (touchStartX === null) return;
    const deltaX = (event.changedTouches[0]?.clientX ?? 0) - touchStartX;
    if (deltaX > 50 && hasPrev) onPrev();
    if (deltaX < -50 && hasNext) onNext();
    touchStartX = null;
  };

  const handleWheel = (event: React.WheelEvent) => {
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

  useEffect(() => {
    containerRef.current?.focus();
  }, [media?.path]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
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
      onTouchMove={(e) => e.preventDefault()}
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
