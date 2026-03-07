import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MediaItem } from "../types";
import { formatBytes, formatDate } from "../utils";

const GRID_GAP = 12;
const CARD_MIN_WIDTH = 220;
const ROW_ESTIMATE = 280;
const FALLBACK_RENDER_LIMIT = 80;

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
  onSelect: (item: MediaItem) => void;
}

const MediaCard = memo(function MediaCard({
  item,
  categoryPath,
  hoveredCardRef,
  onSelect,
}: MediaCardProps) {
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(null);

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

  const isThumbnailFailed = Boolean(item.thumbnailUrl && failedThumbnailUrl === item.thumbnailUrl);
  const showVideoElement = item.kind === "video" && (!item.thumbnailUrl || isThumbnailFailed);
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
      ) : (
        <img
          src={imageSrc}
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (item.thumbnailUrl) {
              setFailedThumbnailUrl(item.thumbnailUrl);
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

  const rowCount = Math.ceil(items.length / columnCount);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 2,
    initialRect: { width: 960, height: 740 },
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [columnCount, items.length, rowVirtualizer]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const fallbackItems = useMemo(
    () => items.slice(0, Math.min(items.length, FALLBACK_RENDER_LIMIT)),
    [items]
  );
  const hasVirtualRows = virtualRows.length > 0;

  useEffect(() => {
    const visibleCount = hasVirtualRows
      ? Math.min(items.length, virtualRows.length * columnCount)
      : fallbackItems.length;
    onVisibleCardsChange(visibleCount);
  }, [columnCount, fallbackItems.length, hasVirtualRows, items.length, onVisibleCardsChange, virtualRows.length]);

  useEffect(() => {
    if (!hasVirtualRows || !rowCount) return;
    const lastVisible = virtualRows[virtualRows.length - 1];
    if (lastVisible && lastVisible.index >= rowCount - 2) {
      onReachEnd();
    }
  }, [hasVirtualRows, onReachEnd, rowCount, virtualRows]);

  const hasMoreAction = items.length < totalFilteredCount || hasMore;

  return (
    <>
      <div className="media-grid-host" ref={hostRef}>
        {items.length ? (
          hasVirtualRows ? (
            <div className="media-grid-virtual" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
              {virtualRows.map((row) => {
                const startIndex = row.index * columnCount;
                const rowItems = items.slice(startIndex, startIndex + columnCount);
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={rowVirtualizer.measureElement}
                    className="media-grid-row"
                    style={{
                      transform: `translateY(${row.start}px)`,
                      gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                    }}
                  >
                    {rowItems.map((item) => (
                      <MediaCard
                        key={item.path}
                        item={item}
                        categoryPath={categoryPath}
                        hoveredCardRef={hoveredCardRef}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="media-grid">
              {fallbackItems.map((item) => (
                <MediaCard
                  key={item.path}
                  item={item}
                  categoryPath={categoryPath}
                  hoveredCardRef={hoveredCardRef}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )
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
