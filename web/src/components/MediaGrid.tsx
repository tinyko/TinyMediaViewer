import { memo, useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import type { MediaItem } from "../types";
import { formatBytes, formatDate } from "../utils";
import { MediaGridVirtualRows } from "./MediaGridVirtualRows";

const GRID_GAP = 12;
const CARD_MIN_WIDTH = 220;
const VIDEO_FALLBACK_SETTLE_MS = 140;

interface MediaGridProps {
  items: MediaItem[];
  totalFilteredCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  categoryPath: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  hoveredCardRef: RefObject<HTMLButtonElement | null>;
  onSelect: (item: MediaItem) => void;
  onReachEnd: () => void;
  onVisibleCardsChange: (count: number) => void;
}

interface MediaCardProps {
  item: MediaItem;
  categoryPath: string | null;
  hoveredCardRef: RefObject<HTMLButtonElement | null>;
  allowVideoFallback: boolean;
  onSelect: (item: MediaItem) => void;
}

const MediaCard = memo(function MediaCard({
  item,
  categoryPath,
  hoveredCardRef,
  allowVideoFallback,
  onSelect,
}: MediaCardProps) {
  const [failedThumbnailAssetKey, setFailedThumbnailAssetKey] = useState<string | null>(null);
  const thumbnailAssetKey = item.thumbnailUrl ? `${item.path}|${item.thumbnailUrl}` : null;

  const handleVideoLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    // Seek slightly past 0s to improve first-frame rendering on mobile browsers.
    const previewTime = duration > 0.2 ? 0.1 : 0;
    if (previewTime <= 0) return;
    try {
      if (Math.abs(video.currentTime - previewTime) > 0.01) {
        video.currentTime = previewTime;
      }
    } catch {
      // Some browsers/webviews may reject programmatic seeking before enough data is buffered.
    }
  };

  const isThumbnailFailed = Boolean(
    thumbnailAssetKey && failedThumbnailAssetKey === thumbnailAssetKey
  );
  const shouldFallbackToVideo = item.kind === "video" && (!item.thumbnailUrl || isThumbnailFailed);
  const showVideoElement = shouldFallbackToVideo && allowVideoFallback;
  const imageSrc = !isThumbnailFailed && item.thumbnailUrl ? item.thumbnailUrl : item.url;

  return (
    <button
      key={`${categoryPath ?? "root"}-${item.path}`}
      className="media-card heart-target"
      onClick={() => onSelect(item)}
      onMouseEnter={(event) => {
        hoveredCardRef.current = event.currentTarget;
      }}
      onMouseLeave={(event) => {
        if (hoveredCardRef.current === event.currentTarget) {
          hoveredCardRef.current = null;
        }
        event.currentTarget.classList.remove("heart-beat");
      }}
    >
      {showVideoElement ? (
        <video
          muted
          playsInline
          preload="metadata"
          src={`${item.url}#t=0.001`}
          onLoadedMetadata={handleVideoLoadedMetadata}
        />
      ) : shouldFallbackToVideo ? (
        <div className="media-card__fallback" aria-label={`${item.name} 视频预览占位`}>
          <span>视频预览准备中</span>
        </div>
      ) : (
        <img
          src={imageSrc}
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (thumbnailAssetKey) {
              setFailedThumbnailAssetKey(thumbnailAssetKey);
            }
          }}
        />
      )}
      <div className="media-card__meta">
        <div>
          <p className="media-title">{item.name}</p>
          <p className="muted">
            {formatBytes(item.size)} · {formatDate(item.modified)}
          </p>
        </div>
      </div>
    </button>
  );
});

export function MediaGrid({
  items,
  totalFilteredCount,
  hasMore,
  loadingMore,
  categoryPath,
  scrollRef,
  hoveredCardRef,
  onSelect,
  onReachEnd,
  onVisibleCardsChange,
}: MediaGridProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = useState(960);
  const [allowVideoFallback, setAllowVideoFallback] = useState(true);

  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setHostWidth(Math.max(320, Math.round(node.clientWidth)));
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width) return;
      setHostWidth(Math.max(320, Math.round(width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const columnCount = useMemo(() => {
    return Math.max(1, Math.floor((hostWidth + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)));
  }, [hostWidth]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    let settleTimer = 0;
    const onScroll = () => {
      setAllowVideoFallback(false);
      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        setAllowVideoFallback(true);
      }, VIDEO_FALLBACK_SETTLE_MS);
    };

    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }
    };
  }, [scrollRef]);

  const hasMoreAction = items.length < totalFilteredCount || hasMore;

  return (
    <>
      <div className="media-grid-host" ref={hostRef}>
        {items.length ? (
          <MediaGridVirtualRows
            items={items}
            columnCount={columnCount}
            scrollRef={scrollRef}
            onReachEnd={onReachEnd}
            onVisibleCardsChange={onVisibleCardsChange}
            renderCard={(item) => (
              <MediaCard
                key={item.path}
                item={item}
                categoryPath={categoryPath}
                hoveredCardRef={hoveredCardRef}
                allowVideoFallback={allowVideoFallback}
                onSelect={onSelect}
              />
            )}
          />
        ) : (
          <div className="empty">该账号暂无符合过滤条件的媒体</div>
        )}
      </div>

      {hasMoreAction && (
        <div className="load-more">
          <button className="primary-button" disabled={loadingMore} onClick={onReachEnd}>
            {loadingMore
              ? "加载中..."
              : items.length < totalFilteredCount
                ? "加载更多"
                : "从服务加载更多"}
          </button>
        </div>
      )}
    </>
  );
}
